// Checks the chord engine: symbol parsing, known fingerings, and — most
// importantly — that every shape it can produce really sounds the chord it
// claims to be, by spelling out the notes the six strings play.
//
//   node test_chords.js
"use strict";
const Chords = require("./chords.js");

let failures = 0;
function check(name, ok, detail) {
  if (!ok) { failures++; console.log("FAIL " + name + (detail ? "  " + detail : "")); }
}

const OPEN_STRINGS = [4, 9, 2, 7, 11, 4]; // E A D G B E as semitones above C
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const ROOTS = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };

// Intervals each quality is made of, and which of them a shape may leave out
const TONES = {
  maj: { all: [0, 4, 7], optional: [7] }, min: { all: [0, 3, 7], optional: [7] },
  "7": { all: [0, 4, 7, 10], optional: [7] }, m7: { all: [0, 3, 7, 10], optional: [7] },
  maj7: { all: [0, 4, 7, 11], optional: [7] }, sus4: { all: [0, 5, 7], optional: [7] },
  sus2: { all: [0, 2, 7], optional: [7] }, dim: { all: [0, 3, 6], optional: [] },
  aug: { all: [0, 4, 8], optional: [] }, "6": { all: [0, 4, 7, 9], optional: [7] },
  "5": { all: [0, 7], optional: [] }, add9: { all: [0, 2, 4, 7], optional: [7] },
};

function sounded(frets) {
  return frets.map((f, i) => (f < 0 ? null : (OPEN_STRINGS[i] + f) % 12));
}

function spellsChord(frets, root, quality, bass) {
  const notes = sounded(frets).filter((n) => n !== null);
  const rel = new Set(notes.map((n) => (n - ROOTS[root] + 12) % 12));
  const spec = TONES[quality];
  // In a slash chord the bass note is allowed to be outside the chord
  const bassRel = bass ? (ROOTS[bass] - ROOTS[root] + 12) % 12 : -1;
  for (const r of rel) if (!spec.all.includes(r) && r !== bassRel) return "plays " + NOTE[(r + ROOTS[root]) % 12] + ", which is not in " + root + quality;
  for (const need of spec.all) {
    if (spec.optional.includes(need)) continue;
    if (!rel.has(need)) return "is missing the " + NOTE[(need + ROOTS[root]) % 12];
  }
  return null;
}

function lowestPitchClass(frets) {
  const i = frets.findIndex((f) => f >= 0);
  return (OPEN_STRINGS[i] + frets[i]) % 12;
}

// ── 1. Every key and quality, built through the public API ──
let shapes = 0;
for (const root of Object.keys(ROOTS)) {
  for (const quality of Object.keys(TONES)) {
    const suffix = { maj: "", min: "m", "7": "7", m7: "m7", maj7: "maj7", sus4: "sus4", sus2: "sus2", dim: "dim", aug: "aug", "6": "6", "5": "5", add9: "add9" }[quality];
    const symbol = root + suffix;
    const parsed = Chords.parse(symbol);
    check(symbol + " parses", parsed && parsed.root === root && parsed.quality === quality && !parsed.approx, JSON.stringify(parsed));
    const v = Chords.voicings(symbol);
    // dim/aug/sus2/add9 exist only as A shapes, and a few exotic roots may have none that fit
    for (const frets of v) {
      shapes++;
      const problem = spellsChord(frets, root, quality);
      check(symbol + " [" + frets.join(",") + "]", !problem, problem);
      check(symbol + " has a fret within reach", Math.max(...frets) <= 15);
      check(symbol + " has six strings", frets.length === 6);
    }
    if (quality !== "5") check(symbol + " has at least one shape", v.length >= 1);
  }
}

// ── 2. Slash chords: the lowest note must be the bass ──
const SLASH_CASES = ["C/B", "C/E", "C/G", "G/B", "G/D", "G/F#", "D/F#", "D/A", "A/C#", "A/E", "Am/G", "Am/C", "Am/E", "F/C", "E/G#", "Dm/F", "Em/G", "Em/D"];
for (const symbol of SLASH_CASES) {
  const p = Chords.parse(symbol);
  check(symbol + " parses with a bass", p && p.bass, JSON.stringify(p));
  const primary = Chords.voicings(symbol)[0];
  check(symbol + " has a shape", !!primary);
  if (primary && p) {
    check(symbol + " bass is lowest note", lowestPitchClass(primary) === ROOTS[p.bass],
      "lowest is " + NOTE[lowestPitchClass(primary)] + " in [" + primary.join(",") + "]");
    const problem = spellsChord(primary, p.root, p.quality, p.bass);
    check(symbol + " spells its chord", !problem, problem);
  }
}

// ── 3. Shapes people will check by eye ──
const KNOWN = {
  C: [-1, 3, 2, 0, 1, 0], D: [-1, -1, 0, 2, 3, 2], E: [0, 2, 2, 1, 0, 0], G: [3, 2, 0, 0, 0, 3],
  A: [-1, 0, 2, 2, 2, 0], F: [1, 3, 3, 2, 1, 1], Bm: [-1, 2, 4, 4, 3, 2], "F#m": [2, 4, 4, 2, 2, 2],
  Bb: [-1, 1, 3, 3, 3, 1], Am7: [-1, 0, 2, 0, 1, 0], Fmaj7: [-1, -1, 3, 2, 1, 0], Dm: [-1, -1, 0, 2, 3, 1],
  "C/B": [-1, 2, 2, 0, 1, 0], "G/B": [-1, 2, 0, 0, 0, 3], "D/F#": [2, 0, 0, 2, 3, 2],
  Ebm7: [-1, 6, 8, 6, 7, 6], "C#": [-1, 4, 6, 6, 6, 4],
};
for (const [symbol, want] of Object.entries(KNOWN)) {
  const got = Chords.voicings(symbol)[0];
  check(symbol + " first shape", got && got.join(",") === want.join(","), "got " + (got && got.join(",")) + " want " + want.join(","));
}

// ── 4. Symbols the sheet may contain ──
const FLAT_SYMBOLS = { Bb: "A#", Eb: "D#", Ab: "G#", Db: "C#", Gb: "F#" };
for (const [flat, sharp] of Object.entries(FLAT_SYMBOLS)) {
  check(flat + " is " + sharp, Chords.parse(flat).root === sharp);
  check(flat + "m reads as minor", Chords.parse(flat + "m").quality === "min");
}
check("star after a chord is ignored", Chords.parse("G*").root === "G" && Chords.parse("G*").quality === "maj");
check("brackets around a chord are ignored", Chords.parse("(Am)").quality === "min");
check("Asus is sus4", Chords.parse("Asus").quality === "sus4" && !Chords.parse("Asus").approx);

const APPROX = { Am9: "m7", Cmaj9: "maj7", D9: "7", G7sus4: "sus4", Cm6: "min", Bm7b5: "dim", E7b9: "7", Fadd9: "add9" };
for (const [symbol, q] of Object.entries(APPROX)) {
  const p = Chords.parse(symbol);
  check(symbol + " maps to " + q, p && p.quality === q, JSON.stringify(p));
}
for (const symbol of ["Am9", "Cmaj9", "D9", "G7sus4", "Bm7b5", "E7b9"]) {
  check(symbol + " is flagged as approximate", Chords.parse(symbol).approx === true);
  check(symbol + " still gets a shape", Chords.voicings(symbol).length >= 1);
}

check("card says Bb when the sheet says Bb", Chords.describe("Bbmaj7") === "Bb major 7th", Chords.describe("Bbmaj7"));
check("card says F# for a slash bass", Chords.describe("D/F#") === "D major, bass note F#", Chords.describe("D/F#"));
check("card says Gb for a flat bass", Chords.describe("C/Gb").includes("bass note Gb"), Chords.describe("C/Gb"));
check("approximate chords say so", Chords.describe("Am9") === "Closest shape: A minor 7th", Chords.describe("Am9"));

// ── 5. Text that is not a chord must never become tappable ──
for (const text of ["N.C.", "x2", "Hello", "|", "2x", "Intro", "H", "", "---", "A-G", "(2x)", "Cc"]) {
  check('"' + text + '" is not a chord', Chords.parse(text) === null, JSON.stringify(Chords.parse(text)));
}

// ── 6. Diagrams ──
const f = Chords.voicings("F")[0];
check("F is drawn with a barre", Chords.barreOf(f) && Chords.barreOf(f).from === 0 && Chords.barreOf(f).to === 5);
check("Bm is drawn with a barre", Chords.barreOf(Chords.voicings("Bm")[0]) !== null);
check("open C has no barre", Chords.barreOf(Chords.voicings("C")[0]) === null);
check("D is fingered, not barred", Chords.barreOf(Chords.voicings("D")[0]) === null);
check("A7 is not barred around an open string", Chords.barreOf(Chords.voicings("A7")[0]) === null);
const markup = Chords.svg(Chords.voicings("Bm")[0], "Bm");
check("diagram is an svg", markup.startsWith("<svg") && markup.endsWith("</svg>"));
check("high shapes show their fret number", /5fr<\/text>/.test(Chords.svg([-1, 5, 7, 7, 6, 5], "x")));
check("open shapes show no fret number", !/fr<\/text>/.test(Chords.svg(Chords.voicings("C")[0], "C")));
const hostile = Chords.svg([0, 0, 0, 0, 0, 0], '"><script>alert(1)</script>');
check("a chord name cannot break out of the svg", !/<script/i.test(hostile) && /aria-label="&quot;&gt;&lt;script&gt;/.test(hostile), hostile.slice(0, 160));

console.log(failures ? failures + " check(s) FAILED" : "ok — " + shapes + " generated shapes all spell their chords, plus fingering, symbol and diagram checks");
process.exit(failures ? 1 : 0);
