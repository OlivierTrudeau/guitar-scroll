// Checks the Auto pace model: a smooth curve, bounded and local corrections,
// blank-line dwell that matches the old extra-row pause, and that a player
// who keeps correcting the same spots teaches the scroller to stop needing it.
//
//   node test_pace.js
"use strict";
const Pace = require("./pace.js");

let failures = 0;
function check(name, ok, detail) {
  if (!ok) { failures++; console.log("FAIL " + name + (detail ? "  " + detail : "")); }
  else console.log("ok   " + name + (detail ? "  " + detail : ""));
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── Curve ──
{
  const flat = Pace.flat();
  check("flat profile is exactly 1x everywhere", [0, 0.13, 0.5, 0.99, 1].every((p) => Pace.factorAt(flat, p) === 1));
  const logs = Pace.flat();
  logs[10] = Math.log(0.7); logs[11] = Math.log(0.7); logs[25] = Math.log(1.4);
  let worst = 0;
  for (let i = 1; i <= 4000; i++) {
    const a = Pace.factorAt(logs, (i - 1) / 4000), b = Pace.factorAt(logs, i / 4000);
    worst = Math.max(worst, Math.abs(b - a));
  }
  check("curve has no steps (max change per 1/4000 of the song)", worst < 0.01, worst.toFixed(5));
  check("curve passes through its points", near(Pace.factorAt(logs, 10 / (Pace.N - 1)), 0.7, 1e-9));
  const round = Pace.decode(Pace.encode(logs));
  check("encode/decode round trip within 1%", round.every((v, i) => near(v, logs[i], 0.006)));
  check("stored form is small", JSON.stringify(Pace.encode(logs)).length < 140, JSON.stringify(Pace.encode(logs)).length + " chars");
  check("bad stored data decodes flat", Pace.isFlat(Pace.decode("junk")) && Pace.isFlat(Pace.decode([1, 2])));
}

// ── One correction ──
{
  // Scroller ran from 40% to 55% of the song in the window; the reader was
  // really only at 50.5%: that stretch was ~30% too fast.
  const r = Pace.ratioOf(0.40, 0.55, 0.505);
  const res = Pace.observe(Pace.flat(), 0.40, 0.55, r, Pace.LR_SWIPE);
  const f = (p) => Pace.factorAt(res.logs, p);
  let lo = 1, hi = 1;
  for (let p = 0; p <= 1; p += 0.001) { lo = Math.min(lo, f(p)); hi = Math.max(hi, f(p)); }
  check("ratio of a 30%-too-fast stretch", near(r, 0.7, 1e-9), r.toFixed(3));
  check("local slowdown is bounded (>= x0.77)", lo >= 0.77 - 1e-9, lo.toFixed(3));
  check("and real (<= x0.85)", lo <= 0.85, lo.toFixed(3));
  check("never speeds anything up", hi <= 1 + 1e-6, hi.toFixed(4));
  check("earlier parts barely move (<1% before 35%)", [0, 0.1, 0.2, 0.3, 0.35].every((p) => f(p) > 0.99), [0.3, 0.35].map((p) => f(p).toFixed(4)).join(" "));
  check("well past the spot it is back to 1x", f(0.66) > 0.995 && f(0.8) === 1, f(0.66).toFixed(4));
  const big = Pace.observe(Pace.flat(), 0.40, 0.55, 0.2, 1);
  let lo2 = 1;
  for (let p = 0; p <= 1; p += 0.001) lo2 = Math.min(lo2, Pace.factorAt(big.logs, p));
  check("even a huge correction is capped (~-22%)", lo2 >= 1 / 1.28 - 0.01, lo2.toFixed(3));
  const up = Pace.observe(Pace.flat(), 0.2, 0.3, 1.25, Pace.LR_SWIPE);
  check("dragging ahead speeds the stretch up", Pace.factorAt(up.logs, 0.27) > 1.1, Pace.factorAt(up.logs, 0.27).toFixed(3));
  // A tiny window still spreads over a few points instead of one spike
  const narrow = Pace.observe(Pace.flat(), 0.5, 0.505, 0.8, Pace.LR_SWIPE);
  const touched = narrow.logs.filter((v) => v !== 0).length;
  check("a narrow correction still spreads over several points", touched >= 3, touched + " points");
}

// ── Blank-line hints ──
{
  // Old behaviour: each extra blank line was one more 1.55em row of travel.
  const row = 1.55 * 13.5;
  for (const n of [1, 2, 4]) {
    const h = Pace.makeHint(1000, n, row);
    const v = 40; // px per second (10x at 1x text)
    let extra = 0, minF = 1;
    for (let y = 0; y < 2000; y += 0.25) {
      const f = Pace.hintFactor([h], y);
      minF = Math.min(minF, f);
      extra += 0.25 / (v * f) - 0.25 / v;
    }
    const want = (n * row) / v;
    check("hint x" + n + " adds the old extra-row time", near(extra, want, want * 0.01), extra.toFixed(3) + "s vs " + want.toFixed(3) + "s");
    check("hint x" + n + " slows smoothly, never stops", minF > 0.4, "min " + minF.toFixed(2) + "x");
  }
  const runs = Pace.blankRuns([{ type: "lyric" }, { type: "empty" }, { type: "lyric" }, { type: "empty" }, { type: "empty" }, { type: "empty" }, { type: "section" }]);
  check("one blank line is a gap, a run of 3 is 2 hints", JSON.stringify(runs) === '{"3":2}', JSON.stringify(runs));
}

// ── Taps and the base speed ──
{
  // Played the whole song at 10x but bumped it to 12x for the last third
  const segs = [{ a: 0, b: 0.66, lb: Math.log(10) }, { a: 0.66, b: 1, lb: Math.log(12) }];
  const t = Pace.learnFromTaps(Pace.flat(), segs, Math.log(10));
  check("taps are learnt", !!t);
  check("the end leans faster than the start", Pace.factorAt(t.logs, 0.9) > Pace.factorAt(t.logs, 0.2) * 1.04,
    Pace.factorAt(t.logs, 0.2).toFixed(3) + " -> " + Pace.factorAt(t.logs, 0.9).toFixed(3));
  check("the base moves toward what was played", Math.exp(t.base) > 10.2 && Math.exp(t.base) < 11.3, Math.exp(t.base).toFixed(2));
  check("no taps, nothing to learn", Pace.learnFromTaps(Pace.flat(), [{ a: 0, b: 1, lb: Math.log(10) }], Math.log(10)) === null);
  check("a few seconds of play teach nothing", Pace.learnFromTaps(Pace.flat(), [{ a: 0, b: 0.1, lb: Math.log(12) }], Math.log(10)) === null);
  const slow = Pace.flat().map(() => Math.log(0.8));
  const norm = Pace.renormalize(slow, Math.log(10), 1, 50);
  check("an overall slowdown moves into the base", norm.base === 8 && Pace.isFlat(norm.logs), norm.base + "x");
  const eff = Math.exp(Math.log(10) + Math.log(0.8)), eff2 = norm.base * Pace.factorAt(norm.logs, 0.5);
  check("renormalising keeps the real speed", near(eff, eff2, 0.06), eff.toFixed(2) + " vs " + eff2.toFixed(2));
}

// ── Convergence over repeated plays ──
// A song the player takes slower in a verse and faster in a solo. The
// scroller starts flat. The simulated player drags the sheet to where they
// really are whenever it is ~3 rows off (with a little sloppiness), and the
// app learns from each drag exactly as app.js does.
{
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const truth = (p) => (p > 0.25 && p < 0.45 ? 0.72 : p > 0.65 && p < 0.8 ? 1.3 : 1);
  const v = 1 / 180; // fraction per second: a 3-minute song at the base speed
  const DT = 0.05, THRESH = 0.012, WINDOW = 25, MIN_WIN = 4;
  // How far off would the scroller get if nobody touched it?
  const driftLeftAlone = (logs) => {
    let qs = 0, qu = 0, worst = 0;
    while (qu < 0.999 && qs < 0.999) {
      qs += v * Pace.factorAt(logs, qs) * DT;
      qu += v * truth(qu) * DT;
      worst = Math.max(worst, Math.abs(qs - qu));
    }
    return worst;
  };
  let logs = Pace.flat();
  const before = driftLeftAlone(logs);
  const perPlay = [];
  for (let play = 0; play < 10; play++) {
    let ps = 0, pu = 0, t = 0, hist = [{ t: 0, p: 0 }], corrections = 0, err = 0;
    while (pu < 0.999 && ps < 0.999 && t < 600) {
      ps += v * Pace.factorAt(logs, ps) * DT;
      pu += v * truth(pu) * DT;
      t += DT;
      if (t - hist[hist.length - 1].t >= 0.2) hist.push({ t, p: ps });
      err += Math.abs(ps - pu) * DT;
      if (Math.abs(ps - pu) > THRESH) {
        const pObs = pu + (rand() - 0.5) * 0.006;
        const anchor = hist.find((h) => h.t >= t - WINDOW);
        if (anchor && t - anchor.t >= MIN_WIN) {
          const r = Pace.ratioOf(anchor.p, ps, pObs);
          logs = Pace.observe(logs, anchor.p, Math.max(ps, pObs), r, Pace.LR_SWIPE).logs;
        }
        ps = pObs;
        hist = [{ t, p: ps }];
        corrections++;
      }
    }
    perPlay.push({ corrections, err: driftLeftAlone(logs) });
  }
  console.log("     corrections per play: " + perPlay.map((x) => x.corrections).join(" "));
  console.log("     worst drift if left alone, after each play: " + perPlay.map((x) => (x.err * 100).toFixed(1) + "%").join(" "));
  const first = perPlay[0], last = perPlay[perPlay.length - 1];
  check("needs far fewer corrections after a few plays", last.corrections <= Math.max(1, first.corrections / 3), first.corrections + " -> " + last.corrections);
  check("left alone, the scroller now stays with the player", last.err < before * 0.25 && last.err <= THRESH, (before * 100).toFixed(1) + "% -> " + (last.err * 100).toFixed(1) + "% of the song");
  const fv = Pace.factorAt(logs, 0.37), fs = Pace.factorAt(logs, 0.74), fi = Pace.factorAt(logs, 0.1);
  check("learnt the slow verse", fv < 0.88, fv.toFixed(2) + "x (truth 0.72x)");
  check("learnt the fast solo", fs > 1.12, fs.toFixed(2) + "x (truth 1.3x)");
  check("left the intro alone", near(fi, 1, 0.08), fi.toFixed(2) + "x");
  // One drag per play at the same spot, always pulling back to where the
  // player really is (a stretch that should be 0.75x): each play closes 60%
  // of what is left, so consistent drags add up and settle on the truth.
  let cur = Pace.flat();
  const path = [];
  for (let k = 0; k < 6; k++) {
    const f = Pace.factorAt(cur, 0.5);
    cur = Pace.observe(cur, 0.4, 0.55, 0.75 / f, Pace.LR_SWIPE).logs;
    path.push(Pace.factorAt(cur, 0.5));
  }
  console.log("     same drag each play, local speed: " + path.map((x) => x.toFixed(3)).join(" -> "));
  check("consistent drags converge on the truth", path.every((x, i) => i === 0 || x <= path[i - 1] + 1e-9) && near(path[path.length - 1], 0.75, 0.01));
  // Noisy drags (±15% around the truth) average out instead of chasing each one
  let noisy = Pace.flat();
  const tail = [];
  for (let k = 0; k < 40; k++) {
    const f = Pace.factorAt(noisy, 0.5);
    noisy = Pace.observe(noisy, 0.4, 0.55, (0.75 * (0.85 + 0.3 * rand())) / f, Pace.LR_SWIPE).logs;
    if (k >= 20) tail.push(Pace.factorAt(noisy, 0.5));
  }
  const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
  check("noisy drags average out near the truth", near(avg, 0.75, 0.05), "mean " + avg.toFixed(3));
  // Order doesn't matter much and one noisy drag doesn't dominate
  const once = Pace.observe(Pace.flat(), 0.3, 0.45, 0.5, Pace.LR_SWIPE).logs;
  const fOnce = Pace.factorAt(once, 0.4);
  check("one wild drag moves it at most ~22%", fOnce >= 0.77, fOnce.toFixed(3));
}

if (failures) { console.log(failures + " failure(s)"); process.exit(1); }
console.log("all pace checks passed");
