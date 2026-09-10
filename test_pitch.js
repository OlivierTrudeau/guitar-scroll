/*
 * Accuracy harness for pitch.js — run with `node test_pitch.js`.
 *
 * Synthesises plucked-string signals (decaying inharmonic partials, weak or
 * missing fundamental, mains hum, room noise, neighbouring strings ringing
 * along) and reports how far the detector lands from the true pitch, in
 * cents. The signals are pushed through the same high-pass/low-pass pair the
 * tuner puts in front of the analyser, so the numbers here track what the
 * browser sees.
 */
const PitchDetector = require("./pitch.js");

const STRINGS = { E2: 82.41, A2: 110.0, D3: 146.83, G3: 196.0, B3: 246.94, E4: 329.63 };

// Inharmonicity coefficient per string: wound bass strings add mass without
// much stiffness, so they sit closer to an ideal string than the plain
// trebles do. Partial n lands at n*f0*sqrt(1 + B*n^2).
const INHARMONICITY = { E2: 3e-5, A2: 4e-5, D3: 5e-5, G3: 1.2e-4, B3: 1.8e-4, E4: 2.2e-4 };

// Must mirror startTuner() in app.js.
const FRAME = 8192;
const HIGHPASS_HZ = 60;
const LOWPASS_HZ = 1000;
const FILTER_STAGES = 2;

function cents(a, b) {
  return 1200 * Math.log2(a / b);
}

function lowpassNoise(buf, alpha) {
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += alpha * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

function synth(opts) {
  const {
    freq,
    sampleRate,
    length,
    harmonics = 14,
    fundamental = 1,
    inharmonicity = 1e-4,
    decay = 1.5,
    noise = 0,
    hum = 0,
    age = 0, // seconds since the pluck
    amplitude = 0.2,
  } = opts;

  const out = new Float32Array(length);
  for (let h = 1; h <= harmonics; h++) {
    const partial = freq * h * Math.sqrt(1 + inharmonicity * h * h);
    if (partial > sampleRate / 2) break;
    // Upper partials die away faster than the fundamental.
    const amp = ((h === 1 ? fundamental : 1) / Math.pow(h, 1.1)) * Math.exp(-decay * h * 0.25 * age);
    const phase = (h * 1.7) % (2 * Math.PI);
    const w = (2 * Math.PI * partial) / sampleRate;
    for (let i = 0; i < length; i++) out[i] += amp * Math.sin(w * i + phase);
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] *= amplitude / peak;

  if (noise > 0) {
    const n = new Float32Array(length);
    for (let i = 0; i < length; i++) n[i] = Math.random() * 2 - 1;
    lowpassNoise(n, 0.3);
    let np = 0;
    for (let i = 0; i < length; i++) np = Math.max(np, Math.abs(n[i]));
    for (let i = 0; i < length; i++) out[i] += (n[i] / np) * amplitude * noise;
  }

  if (hum > 0) {
    const w = (2 * Math.PI * 50) / sampleRate;
    for (let i = 0; i < length; i++) {
      out[i] += amplitude * hum * (Math.sin(w * i) + 0.4 * Math.sin(3 * w * i));
    }
  }

  return out;
}

function biquad(buf, type, f0, sampleRate, stages) {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;
  const b0 = type === "highpass" ? (1 + cw) / 2 : (1 - cw) / 2;
  const b1 = type === "highpass" ? -(1 + cw) : 1 - cw;
  const b2 = b0;

  let out = buf;
  for (let s = 0; s < stages; s++) {
    const src = out;
    const dst = new Float32Array(src.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < src.length; i++) {
      const x0 = src[i];
      const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      dst[i] = y0;
    }
    out = dst;
  }
  return out;
}

function frontEnd(buf, sampleRate) {
  return biquad(
    biquad(buf, "highpass", HIGHPASS_HZ, sampleRate, FILTER_STAGES),
    "lowpass",
    LOWPASS_HZ,
    sampleRate,
    FILTER_STAGES
  );
}

const detectors = new Map();
function detectorFor(sampleRate) {
  if (!detectors.has(sampleRate)) detectors.set(sampleRate, new PitchDetector(sampleRate, FRAME));
  return detectors.get(sampleRate);
}

let failures = 0;
const errors = [];

function report(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(40)} ${detail}`);
}

// Checks a synthesised note lands within `tolerance` cents of the truth.
function check(label, opts, tolerance) {
  const sampleRate = opts.sampleRate || 48000;
  const buf = frontEnd(synth(Object.assign({ sampleRate, length: FRAME }, opts)), sampleRate);
  const res = detectorFor(sampleRate).detect(buf);
  const err = res.frequency > 0 ? cents(res.frequency, opts.freq) : NaN;
  const ok = res.frequency > 0 && Math.abs(err) <= tolerance;
  if (ok) errors.push(Math.abs(err));
  report(
    label,
    ok,
    `${(res.frequency > 0 ? `${err >= 0 ? "+" : ""}${err.toFixed(2)}c` : "NO PITCH").padStart(9)}` +
      `  tol ${String(tolerance).padStart(2)}c  clarity ${res.clarity.toFixed(3)}`
  );
}

function forEachString(fn) {
  for (const [name, freq] of Object.entries(STRINGS)) fn(name, freq, INHARMONICITY[name]);
}

console.log("\n— open strings, clean —");
forEachString((name, f, B) => check(`${name} in tune`, { freq: f, inharmonicity: B }, 2));

console.log("\n— detuned, still has to read the right string —");
forEachString((name, f, B) => {
  for (const c of [-190, -90, -40, -12, 7, 33, 95, 190]) {
    check(`${name} ${c > 0 ? "+" : ""}${c}c`, { freq: f * Math.pow(2, c / 1200), inharmonicity: B }, 2);
  }
});

console.log("\n— weak or missing fundamental (phone mics roll off the bass) —");
forEachString((name, f, B) => {
  check(`${name} fundamental -20 dB`, { freq: f, fundamental: 0.1, inharmonicity: B }, 2);
  check(`${name} fundamental removed`, { freq: f, fundamental: 0, inharmonicity: B }, 2);
});

console.log("\n— noisy room —");
forEachString((name, f, B) => {
  for (const noise of [0.1, 0.3, 0.6, 1.0]) {
    check(`${name} noise ${noise}`, { freq: f, noise, inharmonicity: B }, 3);
  }
});

console.log("\n— 50 Hz mains hum —");
forEachString((name, f, B) => {
  for (const hum of [0.15, 0.3]) check(`${name} hum ${hum}`, { freq: f, hum, inharmonicity: B }, 4);
});

console.log("\n— long after the pluck, barely audible —");
forEachString((name, f, B) =>
  check(`${name} decayed 2.5 s`, { freq: f, age: 2.5, amplitude: 0.01, noise: 0.08, inharmonicity: B }, 3)
);

console.log("\n— pluck attack landing inside the window —");
forEachString((name, f, B) => {
  const sampleRate = 48000;
  const raw = synth({ freq: f, sampleRate, length: FRAME, inharmonicity: B });
  const attackAt = Math.floor(FRAME * 0.35);
  for (let i = 0; i < FRAME; i++) {
    raw[i] *= i < attackAt ? 0.02 : Math.exp(-(i - attackAt) / (sampleRate * 1.2));
  }
  const res = detectorFor(sampleRate).detect(frontEnd(raw, sampleRate));
  const err = res.frequency > 0 ? cents(res.frequency, f) : NaN;
  const ok = Math.abs(err) <= 3;
  if (ok) errors.push(Math.abs(err));
  report(`${name} with attack`, ok, `${err.toFixed(2)}c  clarity ${res.clarity.toFixed(3)}`);
});

console.log("\n— neighbouring string ringing along at -10 dB —");
{
  const names = Object.keys(STRINGS);
  names.forEach((name, i) => {
    const other = names[(i + 1) % names.length];
    const sampleRate = 48000;
    const a = synth({ freq: STRINGS[name], sampleRate, length: FRAME, inharmonicity: INHARMONICITY[name] });
    const b = synth({
      freq: STRINGS[other],
      sampleRate,
      length: FRAME,
      amplitude: 0.2 * 0.3,
      inharmonicity: INHARMONICITY[other],
    });
    for (let j = 0; j < FRAME; j++) a[j] += b[j];
    const res = detectorFor(sampleRate).detect(frontEnd(a, sampleRate));
    const err = res.frequency > 0 ? cents(res.frequency, STRINGS[name]) : NaN;
    const ok = Math.abs(err) <= 3;
    if (ok) errors.push(Math.abs(err));
    report(`${name} over ${other}`, ok, `${err.toFixed(2)}c  clarity ${res.clarity.toFixed(3)}`);
  });
}

console.log("\n— other capture rates —");
for (const sampleRate of [44100, 32000, 16000]) {
  forEachString((name, f, B) =>
    check(`${name} @ ${sampleRate / 1000}k`, { freq: f, sampleRate, noise: 0.15, inharmonicity: B }, 3)
  );
}

console.log("\n— alternate tunings —");
for (const [label, f] of Object.entries({
  "D2 drop D": 73.42,
  "Eb2 half step down": 77.78,
  "C3 open C": 130.81,
  "F#3 open D": 185.0,
  "C#4 open A": 277.18,
  "F#4 open D": 369.99,
})) {
  check(label, { freq: f, noise: 0.1 }, 3);
}

console.log("\n— things that must NOT produce a reading —");
{
  const res = detectorFor(48000).detect(new Float32Array(FRAME));
  report("silence", res.frequency === -1, `frequency ${res.frequency}`);
}
{
  const raw = synth({ freq: 200, sampleRate: 48000, length: FRAME, harmonics: 0, noise: 1 });
  const res = detectorFor(48000).detect(frontEnd(raw, 48000));
  report("broadband noise", res.clarity < 0.85, `clarity ${res.clarity.toFixed(3)}`);
}
{
  // A full strum has no single period, so it has to come back low-clarity
  // rather than confidently naming some string.
  const mixed = new Float32Array(FRAME);
  for (const [name, f] of Object.entries(STRINGS)) {
    const s = synth({ freq: f, sampleRate: 48000, length: FRAME, amplitude: 0.12, inharmonicity: INHARMONICITY[name] });
    for (let i = 0; i < FRAME; i++) mixed[i] += s[i];
  }
  const res = detectorFor(48000).detect(frontEnd(mixed, 48000));
  report("six-string strum", res.clarity < 0.85, `clarity ${res.clarity.toFixed(3)}`);
}

console.log("\n— cost per analysis frame —");
for (const sampleRate of [48000, 44100, 16000]) {
  const buf = frontEnd(synth({ freq: 110, sampleRate, length: FRAME }), sampleRate);
  const det = detectorFor(sampleRate);
  for (let i = 0; i < 20; i++) det.detect(buf);
  const runs = 300;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) det.detect(buf);
  console.log(`      ${sampleRate} Hz: ${(Number(process.hrtime.bigint() - t0) / 1e6 / runs).toFixed(2)} ms/frame`);
}

const mean = errors.reduce((a, b) => a + b, 0) / (errors.length || 1);
console.log(
  `\nmean |error| ${mean.toFixed(3)}c over ${errors.length} passing cases, ` +
    `worst ${Math.max(...errors).toFixed(3)}c, ${failures} failure(s)\n`
);
process.exit(failures ? 1 : 0);
