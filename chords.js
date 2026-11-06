/* Chord shapes for the tap-a-chord diagrams.
 *
 * Standard tuning, strings listed low E to high e. A shape is six numbers, one
 * per string: -1 for a muted string, 0 for an open one, otherwise the fret.
 *
 * Common open chords are looked up in a table. Everything else is built from
 * two movable barre shapes: the "E" shape (root on the 6th string) and the "A"
 * shape (root on the 5th), slid to the right fret for the root.
 */
(function (root) {
  "use strict";

  var SEMITONE = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
  var FLAT_TO_SHARP = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E", "E#": "F", "B#": "C" };

  // ── Open and favourite shapes, written as the six frets low to high ──
  var OPEN = {
    "C|maj": ["x32010"], "D|maj": ["xx0232"], "E|maj": ["022100"], "G|maj": ["320003", "320033"],
    "A|maj": ["x02220"], "F|maj": ["133211", "xx3211"], "B|maj": ["x24442"],
    "A|min": ["x02210"], "D|min": ["xx0231"], "E|min": ["022000"],
    "C|7": ["x32310"], "D|7": ["xx0212"], "E|7": ["020100"], "G|7": ["320001"], "A|7": ["x02020"], "B|7": ["x21202"],
    "A|m7": ["x02010"], "D|m7": ["xx0211"], "E|m7": ["022030", "020000"], "B|m7": ["x20202"],
    "C|maj7": ["x32000"], "D|maj7": ["xx0222"], "E|maj7": ["021100"], "F|maj7": ["xx3210"],
    "G|maj7": ["320002"], "A|maj7": ["x02120"],
    "A|sus4": ["x02230"], "D|sus4": ["xx0233"], "E|sus4": ["022200"],
    "A|sus2": ["x02200"], "D|sus2": ["xx0230"], "C|sus2": ["x30033"],
    "C|add9": ["x32030"], "G|add9": ["320203"],
    "E|5": ["022xxx"], "A|5": ["x022xx"], "D|5": ["xx023x"],
  };

  // Slash chords with a well-known shape
  var SLASH = {
    "C|maj/B": ["x22010"], "C|maj/E": ["032010"], "C|maj/G": ["332010"],
    "G|maj/B": ["x20003"], "G|maj/D": ["xx0003"], "G|maj/F#": ["2x0003"],
    "D|maj/F#": ["200232"], "D|maj/A": ["x00232"],
    "A|maj/C#": ["x42220"], "A|maj/E": ["002220"],
    "A|min/G": ["3x2210"], "A|min/C": ["x32210"], "A|min/E": ["002210"],
    "F|maj/C": ["x33211"], "E|maj/G#": ["4x2100"], "D|min/F": ["1x0231"],
    "E|min/G": ["3x2000"], "E|min/D": ["xx0000"],
  };

  // ── Movable barre shapes: offsets from the root fret ──
  var X = -1;
  var E_FORM = {
    "maj": [0, 2, 2, 1, 0, 0], "min": [0, 2, 2, 0, 0, 0], "7": [0, 2, 0, 1, 0, 0],
    "m7": [0, 2, 0, 0, 0, 0], "maj7": [0, 2, 1, 1, 0, 0], "sus4": [0, 2, 2, 2, 0, 0],
    "6": [0, 2, 2, 1, 2, 0], "5": [0, 2, 2, X, X, X],
  };
  var A_FORM = {
    "maj": [X, 0, 2, 2, 2, 0], "min": [X, 0, 2, 2, 1, 0], "7": [X, 0, 2, 0, 2, 0],
    "m7": [X, 0, 2, 0, 1, 0], "maj7": [X, 0, 2, 1, 2, 0], "sus4": [X, 0, 2, 2, 3, 0],
    "sus2": [X, 0, 2, 2, 0, 0], "6": [X, 0, 2, 2, 2, 2], "5": [X, 0, 2, 2, X, X],
    "dim": [X, 0, 1, 2, 1, X], "aug": [X, 0, 3, 2, 2, 1], "add9": [X, 0, 2, 4, 2, 0],
  };

  var QUALITY_NAMES = {
    maj: "major", min: "minor", "7": "dominant 7th", m7: "minor 7th", maj7: "major 7th",
    sus4: "suspended 4th", sus2: "suspended 2nd", dim: "diminished", aug: "augmented",
    "6": "major 6th", "5": "power chord", add9: "add 9",
  };

  var EXACT = {
    "": "maj", maj: "maj", M: "maj", major: "maj",
    m: "min", min: "min", "-": "min", minor: "min",
    "7": "7", dom7: "7",
    m7: "m7", min7: "m7", "-7": "m7",
    maj7: "maj7", M7: "maj7", "Δ": "maj7", "Δ7": "maj7",
    sus4: "sus4", sus: "sus4", sus2: "sus2",
    dim: "dim", "°": "dim", aug: "aug", "+": "aug",
    "6": "6", "5": "5", add9: "add9", add2: "add9",
  };

  // Chord symbol: root, quality text, optional /bass
  var SYMBOL_RE = /^([A-G])([#b♯♭]?)((?:maj|min|dim|aug|sus|add|m|M|\+|°|ø|Δ|-|\d{1,2}|b\d|#\d)*)(?:\/([A-G])([#b♯♭]?))?$/;

  // How a note was written on the sheet, so the card can say Bb when the sheet says Bb
  function written(letter, accidental) {
    return letter + (accidental === "\u266f" ? "#" : accidental === "\u266d" ? "b" : accidental);
  }

  function sharpRoot(letter, accidental) {
    var acc = accidental === "♯" ? "#" : accidental === "♭" ? "b" : accidental;
    var name = letter + acc;
    return FLAT_TO_SHARP[name] || name;
  }

  // Reads what a symbol means. Returns null if the text is not a chord at all.
  function parse(token) {
    if (typeof token !== "string") return null;
    var text = token.replace(/\*+$/, "").replace(/^\(+|\)+$/g, "");
    var m = SYMBOL_RE.exec(text);
    if (!m) return null;
    var rootName = sharpRoot(m[1], m[2]);
    if (!(rootName in SEMITONE)) return null;
    var bass = m[4] ? sharpRoot(m[4], m[5]) : null;
    if (bass && !(bass in SEMITONE)) return null;
    var cls = classify(m[3]);
    return {
      name: text, root: rootName, rootAs: written(m[1], m[2]), quality: cls.q, approx: cls.approx,
      bass: bass, bassAs: m[4] ? written(m[4], m[5]) : null,
    };
  }

  function classify(suffix) {
    var s = suffix.replace(/[()]/g, "").replace(/♭/g, "b").replace(/♯/g, "#");
    if (Object.prototype.hasOwnProperty.call(EXACT, s)) return { q: EXACT[s], approx: false };
    var q;
    if (/^(m7b5|min7b5|ø)/.test(s)) q = "dim";
    else if (/^(maj|M|Δ)/.test(s)) q = "maj7";
    else if (/^(dim|°)/.test(s)) q = "dim";
    else if (/^(aug|\+)/.test(s)) q = "aug";
    else if (/^(m|min|-)/.test(s)) q = /(7|9|11|13)/.test(s) ? "m7" : "min";
    else if (/^sus2/.test(s)) q = "sus2";
    else if (/^(sus|7sus)/.test(s)) q = "sus4";
    else if (/^(7|9|11|13)/.test(s)) q = "7";
    else if (/^6/.test(s)) q = "6";
    else q = "maj";
    return { q: q, approx: true };
  }

  function decode(str) {
    var out = [];
    for (var i = 0; i < 6; i++) {
      var c = str.charAt(i);
      out.push(c === "x" ? -1 : parseInt(c, 10));
    }
    return out;
  }

  function slide(form, r) {
    return form.map(function (f) { return f < 0 ? -1 : f + r; });
  }

  function maxFret(frets) {
    return Math.max.apply(null, frets);
  }

  // Every shape we know for a chord, easiest first
  function voicings(token) {
    var p = typeof token === "string" ? parse(token) : token;
    if (!p) return [];
    var found = [];
    var seen = {};
    function add(frets) {
      var key = frets.join(",");
      if (seen[key] || maxFret(frets) > 15) return;
      seen[key] = true;
      found.push(frets);
    }

    if (p.bass) {
      var slash = SLASH[p.root + "|" + p.quality + "/" + p.bass];
      if (slash) slash.forEach(function (s) { add(decode(s)); });
    }
    (OPEN[p.root + "|" + p.quality] || []).forEach(function (s) { add(decode(s)); });

    var n = SEMITONE[p.root];
    var barres = [];
    if (E_FORM[p.quality]) barres.push({ r: (n - SEMITONE.E + 12) % 12, form: E_FORM[p.quality] });
    if (A_FORM[p.quality]) barres.push({ r: (n - SEMITONE.A + 12) % 12, form: A_FORM[p.quality] });
    barres.sort(function (a, b) { return a.r - b.r; });
    barres.forEach(function (b) { add(slide(b.form, b.r)); });

    return found.slice(0, 3);
  }

  // A short description for under the chord name
  function describe(token) {
    var p = typeof token === "string" ? parse(token) : token;
    if (!p) return "";
    var parts = [];
    var kind = p.rootAs + " " + (QUALITY_NAMES[p.quality] || p.quality);
    parts.push(p.approx ? "Closest shape: " + kind : kind);
    if (p.bass && p.bass !== p.root) parts.push("bass note " + p.bassAs);
    return parts.join(", ");
  }

  // ── Diagram ──
  var NS = "http://www.w3.org/2000/svg";
  var STRING_X0 = 34, STRING_GAP = 17, TOP = 36, FRET_H = 22, FRETS = 5;

  function barreOf(frets) {
    var positive = frets.filter(function (f) { return f > 0; });
    if (!positive.length) return null;
    var lowest = Math.min.apply(null, positive);
    var idx = [];
    frets.forEach(function (f, i) { if (f === lowest) idx.push(i); });
    if (idx.length < 2) return null;
    var first = idx[0], last = idx[idx.length - 1];
    if (last - first < 3) return null; // short grips are fingered, not barred
    for (var i = first + 1; i < last; i++) if (frets[i] <= 0) return null;
    return { fret: lowest, from: first, to: last };
  }

  function attr(text) {
    return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function svg(frets, label) {
    var positive = frets.filter(function (f) { return f > 0; });
    var base = positive.length && maxFret(frets) > FRETS ? Math.min.apply(null, positive) : 1;
    var x = function (i) { return STRING_X0 + i * STRING_GAP; };
    var y = function (rel) { return TOP + (rel - 0.5) * FRET_H; };
    var width = x(5) + 22, height = TOP + FRETS * FRET_H + 8;
    var o = [];
    o.push('<svg class="chord-diagram" xmlns="' + NS + '" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + attr(label || "Chord shape") + '">');

    // Fret lines, then the nut (thick at the top of the neck) or a plain line plus fret number
    for (var f = 0; f <= FRETS; f++) {
      var yy = TOP + f * FRET_H;
      var cls = f === 0 && base === 1 ? "cd-nut" : "cd-fret";
      o.push('<line class="' + cls + '" x1="' + x(0) + '" y1="' + yy + '" x2="' + x(5) + '" y2="' + yy + '"/>');
    }
    for (var s = 0; s < 6; s++) {
      o.push('<line class="cd-string" x1="' + x(s) + '" y1="' + TOP + '" x2="' + x(s) + '" y2="' + (TOP + FRETS * FRET_H) + '"/>');
    }
    if (base > 1) {
      o.push('<text class="cd-label" x="' + (x(0) - 12) + '" y="' + (y(1) + 4) + '" text-anchor="end">' + base + "fr</text>");
    }

    // Open and muted strings above the neck
    frets.forEach(function (fret, i) {
      if (fret === 0) o.push('<circle class="cd-mark" cx="' + x(i) + '" cy="' + (TOP - 12) + '" r="4.5"/>');
      else if (fret < 0) {
        var cx = x(i), cy = TOP - 12;
        o.push('<path class="cd-mark" d="M' + (cx - 4) + " " + (cy - 4) + "L" + (cx + 4) + " " + (cy + 4) + "M" + (cx + 4) + " " + (cy - 4) + "L" + (cx - 4) + " " + (cy + 4) + '"/>');
      }
    });

    // A barre as one bar, then single fingers on top
    var barre = barreOf(frets);
    if (barre) {
      var by = y(barre.fret - base + 1);
      o.push('<rect class="cd-dot" x="' + (x(barre.from) - 7.5) + '" y="' + (by - 7.5) + '" width="' + (x(barre.to) - x(barre.from) + 15) + '" height="15" rx="7.5"/>');
    }
    frets.forEach(function (fret, i) {
      if (fret <= 0 || (barre && fret === barre.fret)) return;
      o.push('<circle class="cd-dot" cx="' + x(i) + '" cy="' + y(fret - base + 1) + '" r="7.5"/>');
    });

    o.push("</svg>");
    return o.join("");
  }

  var api = { parse: parse, voicings: voicings, describe: describe, svg: svg, barreOf: barreOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Chords = api;
})(typeof window !== "undefined" ? window : this);
