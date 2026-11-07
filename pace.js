/* Auto pace: the math behind a scroller that learns how a song is played.
 *
 * A song's pacing profile is a curve of speed factors over the song. The
 * scroller moves at   base speed × profile(position) × hints(position),
 * so the profile only bends the user's own speed, it never replaces it.
 *
 * Position is the fraction of the scrollable height (scrollTop / max scroll).
 * That is the one coordinate that means the same spot in the song at every
 * text size, font and phone width; pixels and wrapped rows don't survive a
 * reflow, and line indices can't say where between two lines the reader is.
 * Jam progress uses the same fraction.
 *
 * The profile is stored as N control points, evenly spread from the top to
 * the bottom, holding log factors (so ×1.25 and ÷1.25 are equal and opposite
 * steps). Between points it is a monotone cubic: smooth, no steps, no
 * overshoot, and it passes through the points, so an untouched stretch stays
 * at exactly 1×.
 *
 * Learning works on "observations": at wall time t the reader was really at
 * position p, while the scroller had them somewhere else. That is turned into
 * the speed ratio that would have been right over the stretch leading up to
 * it, and blended into the profile with a smooth bump (see observe()).
 *
 * No DOM here, so `node test_pace.js` can check it.
 */
(function (root) {
  "use strict";

  var N = 40; // control points; ~3 rows of a typical chart apart
  var MIN_LOG = Math.log(0.4); // the profile never bends speed past 0.4×..2.5×
  var MAX_LOG = Math.log(2.5);
  // One correction changes local speed by at most about ±25% (×1.28 / ×0.78)
  var STEP_LOG = Math.log(1.28);
  // How much of what one observation says is taken on board. A swipe is a
  // clear statement, but one play is noisy: 0.6 converges in ~3 plays
  // (residual 0.4^k) without one stray swipe dominating.
  var LR_SWIPE = 0.6;
  // A pause says "I needed more time here", but people also pause to retune
  // or talk, so it counts for less.
  var LR_PAUSE = 0.35;
  // Speed taps are spread over the song when it is closed (see learnFromTaps)
  var LR_TAP = 0.5;
  var LR_BASE = 0.6;

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  function flat() {
    var a = new Array(N);
    for (var i = 0; i < N; i++) a[i] = 0;
    return a;
  }

  function isFlat(logs) {
    if (!logs) return true;
    for (var i = 0; i < logs.length; i++) if (Math.abs(logs[i]) > 0.004) return false;
    return true;
  }

  // Stored as hundredths of a log unit: 40 small integers.
  function encode(logs) {
    var out = new Array(logs.length);
    for (var i = 0; i < logs.length; i++) out[i] = Math.round(logs[i] * 100);
    return out;
  }

  function decode(arr) {
    if (!Array.isArray(arr) || arr.length !== N) return flat();
    var out = new Array(N);
    for (var i = 0; i < N; i++) {
      var v = Number(arr[i]) / 100;
      out[i] = isFinite(v) ? clamp(v, MIN_LOG, MAX_LOG) : 0;
    }
    return out;
  }

  // A monotone cubic through the control points, in log space (Fritsch-
  // Carlson tangents): smooth like a spline, but it never overshoots, so a
  // slowdown can't make the bars beside it a little faster.
  function tangent(logs, i) {
    if (i <= 0 || i >= N - 1) return 0;
    var a = logs[i] - logs[i - 1];
    var b = logs[i + 1] - logs[i];
    if (a * b <= 0) return 0;
    return (2 * a * b) / (a + b);
  }
  function logAt(logs, p) {
    if (!logs) return 0;
    var x = clamp(p, 0, 1) * (N - 1);
    var i = Math.floor(x);
    if (i >= N - 1) return logs[N - 1];
    var t = x - i;
    var y0 = logs[i], y1 = logs[i + 1];
    var m0 = tangent(logs, i), m1 = tangent(logs, i + 1);
    var t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
  }

  function factorAt(logs, p) {
    return Math.exp(clamp(logAt(logs, p), MIN_LOG, MAX_LOG));
  }

  // 0 → 1 with zero slope at both ends
  function ease(t) {
    t = clamp(t, 0, 1);
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  // How much of a correction lands at position x, for a stretch the scroller
  // ran from `from` to `to`. Full weight over most of the stretch, a smooth
  // rise at its start that barely reaches further back, and a short fade
  // after it, because a passage that was too fast usually goes on a little.
  function bumpWeight(x, from, to) {
    var minLen = 3 / (N - 1); // never narrower than ~3 points: no spikes
    if (to - from < minLen) from = to - minLen;
    var len = to - from;
    var riseA = from - 0.15 * len;
    var riseB = from + 0.35 * len;
    var fall = 0.35 * len;
    if (x <= riseA || x >= to + fall) return 0;
    if (x < riseB) return ease((x - riseA) / (riseB - riseA));
    if (x <= to) return 1;
    return 1 - ease((x - to) / fall);
  }

  // Speed ratio that would have put the reader where they really were.
  // anchor: where the scroller was a while ago (window start)
  // expected: where it would be now if nobody had touched it
  // actual: where the reader says they are
  function ratioOf(anchorP, expectedP, actualP) {
    var ran = expectedP - anchorP;
    if (!(ran > 0)) return 1;
    return (actualP - anchorP) / ran;
  }

  // Blend one observation into the profile. Returns the new logs and the
  // largest change made to any point (log units).
  function observe(logs, from, to, ratio, lr) {
    var out = logs.slice();
    if (!(ratio > 0) || !isFinite(ratio)) return { logs: out, change: 0 };
    var step = clamp((lr == null ? LR_SWIPE : lr) * Math.log(ratio), -STEP_LOG, STEP_LOG);
    var biggest = 0;
    for (var i = 0; i < N; i++) {
      var w = bumpWeight(i / (N - 1), from, to);
      if (!w) continue;
      var next = clamp(out[i] + w * step, MIN_LOG, MAX_LOG);
      biggest = Math.max(biggest, Math.abs(next - out[i]));
      out[i] = next;
    }
    return { logs: out, change: biggest };
  }

  // A blank-line hint: a smooth, local slowdown around `center` (scrollTop
  // pixels) that adds the time `n` extra text rows used to take at the
  // same speed. Wider for longer pauses so it never comes close to a stop.
  //   speed factor = 1 / (1 + Σ a·bump), and ∫ a·bump = n·rowPx
  function makeHint(center, n, rowPx) {
    var w = rowPx * (3 + n);
    return { c: center, w: w, a: (2 * n * rowPx) / w };
  }

  function hintFactor(hints, y) {
    if (!hints || !hints.length) return 1;
    var sum = 0;
    for (var i = 0; i < hints.length; i++) {
      var h = hints[i];
      var d = Math.abs(y - h.c);
      if (d >= h.w / 2) continue;
      sum += h.a * (0.5 + 0.5 * Math.cos((Math.PI * d) / (h.w / 2)));
    }
    return 1 / (1 + sum);
  }

  // Speed taps, when the song is closed. `segs` are the stretches the
  // scroller ran in this sitting: { a, b } fractions and `lb`, the log of the
  // base speed it ran at. Where the user ran faster than their average, the
  // profile leans faster there; the average itself becomes the new base.
  // Returns { logs, base } (base as a log) or null when there is too little
  // to go on.
  function learnFromTaps(logs, segs, startLogBase) {
    var K = 200;
    var lb = new Array(K);
    var covered = 0, sum = 0, tapped = false;
    for (var k = 0; k < K; k++) {
      var x = (k + 0.5) / K;
      lb[k] = null;
      for (var s = segs.length - 1; s >= 0; s--) {
        if (x >= segs[s].a && x <= segs[s].b) { lb[k] = segs[s].lb; break; }
      }
      if (lb[k] !== null) {
        covered++;
        sum += lb[k];
        if (Math.abs(lb[k] - startLogBase) > 1e-6) tapped = true;
      }
    }
    if (!tapped || covered < K * 0.3) return null;
    var mean = sum / covered;
    var out = logs.slice();
    var sigma = 0.05;
    for (var i = 0; i < N; i++) {
      var xi = i / (N - 1);
      var wsum = 0, esum = 0, cov = 0;
      for (var j = 0; j < K; j++) {
        var g = Math.exp(-Math.pow(((j + 0.5) / K - xi) / sigma, 2) / 2);
        wsum += g;
        if (lb[j] === null) continue;
        cov += g;
        esum += g * (lb[j] - mean);
      }
      if (cov <= 0) continue;
      var e = esum / cov;
      var c = cov / wsum;
      out[i] = clamp(out[i] + LR_TAP * c * clamp(e, -STEP_LOG, STEP_LOG), MIN_LOG, MAX_LOG);
    }
    return { logs: out, base: startLogBase + LR_BASE * (mean - startLogBase) };
  }

  // Move the profile's overall level into the base speed, so the speed label
  // stays honest: the base is the song's average, the profile only its shape.
  // The base is rounded to the half-steps the +/- buttons use; what rounding
  // leaves over stays in the profile.
  function renormalize(logs, logBase, minBase, maxBase) {
    var mean = 0;
    for (var i = 0; i < N; i++) mean += logs[i];
    mean /= N;
    var exact = Math.exp(logBase + mean);
    var base = clamp(Math.round(exact * 2) / 2, minBase, maxBase);
    var shift = Math.log(base) - logBase; // what the base now carries
    var out = new Array(N);
    for (var j = 0; j < N; j++) out[j] = clamp(logs[j] - shift, MIN_LOG, MAX_LOG);
    return { logs: out, base: base };
  }

  // A cheap fingerprint of a song's text, to notice when it was edited
  function bodyHash(body) {
    var h = 5381;
    var s = String(body || "");
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function lineCount(body) {
    return String(body || "").split("\n").filter(function (l) { return l.trim(); }).length;
  }

  // Blank-line runs: a single blank line is an ordinary gap, each extra one
  // is a pacing hint. Returns, for each item index that starts a run of two
  // or more, how many hints it holds (capped so a pasted wall of newlines
  // can't stall the song).
  var MAX_HINTS_PER_RUN = 8;
  function blankRuns(items) {
    var out = {};
    for (var i = 0; i < items.length; i++) {
      if (items[i].type !== "empty") continue;
      if (i > 0 && items[i - 1].type === "empty") continue;
      var j = i;
      while (j < items.length && items[j].type === "empty") j++;
      if (j - i >= 2) out[i] = Math.min(MAX_HINTS_PER_RUN, j - i - 1);
    }
    return out;
  }

  var api = {
    N: N, LR_SWIPE: LR_SWIPE, LR_PAUSE: LR_PAUSE, STEP_LOG: STEP_LOG, MIN_LOG: MIN_LOG, MAX_LOG: MAX_LOG,
    flat: flat, isFlat: isFlat, encode: encode, decode: decode,
    logAt: logAt, factorAt: factorAt, bumpWeight: bumpWeight, ratioOf: ratioOf, observe: observe,
    makeHint: makeHint, hintFactor: hintFactor, learnFromTaps: learnFromTaps, renormalize: renormalize,
    bodyHash: bodyHash, lineCount: lineCount, blankRuns: blankRuns,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Pace = api;
})(typeof window !== "undefined" ? window : this);
