// QR codes and the offline pairing text — run with `node test_qr.js`.
// (The WebRTC link itself needs a browser; see the notes in offline.js.)
"use strict";
const QR = require("./qr.js");
const Offline = require("./offline.js");
let failed = 0;
function check(name, ok, detail) { if (!ok) { failed++; console.log("FAIL " + name + (detail ? " " + detail : "")); } }

// Render a code to a grayscale image the way a camera would see it, upright
function render(q, px) {
  const quiet = 4, dim = (q.size + quiet * 2) * px, g = new Uint8Array(dim * dim).fill(255);
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x])
    for (let yy = 0; yy < px; yy++) for (let xx = 0; xx < px; xx++) g[((y + quiet) * px + yy) * dim + (x + quiet) * px + xx] = 0;
  return { g, dim };
}

// Round trips at every size we can make, both error levels
let n = 0;
for (const ecc of ["L", "M"]) for (const len of [1, 20, 101, 260, 500, 800]) {
  let text = "";
  for (let i = 0; i < len; i++) text += String.fromCharCode(33 + ((i * 7 + len) % 90));
  let q;
  try { q = QR.encode(text, { ecc }); } catch (e) { continue; }
  const { g, dim } = render(q, 5);
  check("round trip " + ecc + " " + len, QR.decode(g, dim, dim) === text);
  n++;
}
check("unicode survives", (() => { const t = "Café ♯ — 音"; const { g, dim } = render(QR.encode(t), 6); return QR.decode(g, dim, dim) === t; })());
check("too long is refused", (() => { try { QR.encode("x".repeat(2000)); return false; } catch (e) { return true; } })());

// Reed-Solomon repairs damage up to its limit
const I = QR._internals;
let repaired = 0, tried = 0;
for (let t = 0; t < 200; t++) {
  const eccLen = [10, 16, 18, 22, 26, 28, 30][t % 7];
  const data = Array.from({ length: 20 + (t % 30) }, () => Math.floor(Math.random() * 256));
  const block = data.concat(I.rsRemainder(data, I.rsDivisor(eccLen)));
  const bad = block.slice();
  const k = 1 + Math.floor(Math.random() * (eccLen / 2));
  const hit = new Set();
  while (hit.size < k) { const p = Math.floor(Math.random() * bad.length); if (!hit.has(p)) { hit.add(p); bad[p] ^= 1 + Math.floor(Math.random() * 255); } }
  const fixed = I.rsCorrect(bad, eccLen);
  tried++;
  if (fixed && fixed.every((v, i) => v === block[i])) repaired++;
}
check("Reed-Solomon repairs every correctable block", repaired === tried, repaired + "/" + tried);

// A code with some modules flipped still reads
{
  const q = QR.encode("GS1~o~ABCDE~xxxx~yyyyyyyyyyyyyyyyyyyyyy~zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz~192.168.1.5/50000", { ecc: "M" });
  for (let i = 0; i < 6; i++) { const x = 12 + i * 5, y = 20 + i * 3; q.modules[y][x] = !q.modules[y][x]; }
  const { g, dim } = render(q, 5);
  check("a few damaged modules still read", QR.decode(g, dim, dim) !== null);
}

// Pairing text
const sig = { ufrag: "abcd", pwd: "p".repeat(22), fp: Array.from({ length: 32 }, (_, i) => (i * 8 + 3).toString(16).toUpperCase().padStart(2, "0")).join(":"), cands: ["192.168.1.20/54000", "abcd-1234.local/54001"] };
const packed = Offline._pack("o", "K7MQP", sig);
const un = Offline.unpack(packed);
check("pairing text round trips", un && un.kind === "o" && un.code === "K7MQP" && un.ufrag === "abcd" && un.fp === sig.fp && un.cands.length === 2, JSON.stringify(un));
check("pairing text fits a small code", QR.encode(packed, { ecc: "M" }).version <= 8, "v" + QR.encode(packed, { ecc: "M" }).version);
check("junk is not a pairing code", Offline.unpack("hello") === null && Offline.unpack("GS1~o~a") === null);
const sdp = Offline._buildSdp(un, true);
check("rebuilt SDP carries the fields", /a=ice-ufrag:abcd/.test(sdp) && /a=setup:actpass/.test(sdp) && /192\.168\.1\.20 54000 typ host/.test(sdp) && /abcd-1234\.local 54001 typ host/.test(sdp));
check("answer SDP is the active side", /a=setup:active/.test(Offline._buildSdp(un, false)));

console.log(failed ? failed + " check(s) FAILED" : "ok — " + n + " QR round trips, Reed-Solomon, pairing text");
process.exit(failed ? 1 : 0);
