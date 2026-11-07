/*
 * QR codes, both ways, with no dependencies — used to pair phones for an
 * offline jam when there is no internet to carry the handshake.
 *
 *   QR.encode(text, { ecc: "L" | "M" })  -> { size, modules: boolean[][] }
 *   QR.draw(canvas, qr, px)              -> paints it, with its quiet zone
 *   QR.decode(gray, width, height)       -> text, or null  (gray: Uint8 luma)
 *
 * Encoding is byte mode only (UTF-8), versions 1-20. Decoding reads the same:
 * it finds the three corner squares, maps the grid onto the image (using the
 * fourth alignment square to correct for perspective when there is one),
 * reads the format bits, unmasks, and runs Reed-Solomon over each block so a
 * smudge or a bit of glare doesn't cost the whole code.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QR = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ── Tables (versions 1..40 indexed directly; we only emit up to 20) ──
  var ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  };
  var NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  };
  var FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  var ECC_FROM_BITS = ["M", "L", "H", "Q"]; // indexed by the 2 format bits
  var MAX_VERSION = 40;

  // ── Geometry shared by the encoder and decoder ──
  function sizeOf(ver) { return ver * 4 + 17; }

  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var pos = sizeOf(ver) - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  function rawModules(ver) {
    var size = sizeOf(ver);
    var r = size * size - 8 * 8 * 3 - 15 * 2 - 1 - (size - 16) * 2;
    if (ver >= 2) {
      var n = Math.floor(ver / 7) + 2;
      r -= (n - 1) * (n - 1) * 25;
      r -= (n - 2) * 2 * 20;
      if (ver >= 7) r -= 6 * 3 * 2;
    }
    return r;
  }

  function dataCodewords(ver, ecc) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * NUM_BLOCKS[ecc][ver];
  }

  // true where the module belongs to a function pattern (not data)
  function functionMask(ver) {
    var size = sizeOf(ver);
    var m = [];
    for (var y = 0; y < size; y++) m.push(new Uint8Array(size));
    function rect(x0, y0, w, h) {
      for (var y2 = y0; y2 < y0 + h; y2++) for (var x2 = x0; x2 < x0 + w; x2++) if (y2 >= 0 && y2 < size && x2 >= 0 && x2 < size) m[y2][x2] = 1;
    }
    rect(0, 0, 9, 9); rect(size - 8, 0, 8, 9); rect(0, size - 8, 9, 8); // finders + format
    rect(6, 0, 1, size); rect(0, 6, size, 1); // timing
    var a = alignPositions(ver);
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < a.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === a.length - 1) || (i === a.length - 1 && j === 0)) continue;
        rect(a[i] - 2, a[j] - 2, 5, 5);
      }
    }
    if (ver >= 7) { rect(size - 11, 0, 3, 6); rect(0, size - 11, 6, 3); }
    return m;
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  // Positions of the data bits in reading order: two columns at a time, right
  // to left, snaking up and down, skipping the timing column and function modules.
  function dataOrder(ver, fmask) {
    var size = sizeOf(ver);
    var order = [];
    var up = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var v = 0; v < size; v++) {
        var y = up ? size - 1 - v : v;
        for (var k = 0; k < 2; k++) {
          var x = right - k;
          if (!fmask[y][x]) order.push([x, y]);
        }
      }
      up = !up;
    }
    return order;
  }

  // ── Galois field GF(256), x^8 + x^4 + x^3 + x^2 + 1 ──
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  function gdiv(a, b) { return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]; }

  function rsDivisor(degree) {
    var res = new Array(degree).fill(0);
    res[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        res[j] = gmul(res[j], root);
        if (j + 1 < degree) res[j] ^= res[j + 1];
      }
      root = gmul(root, 2);
    }
    return res;
  }

  function rsRemainder(data, divisor) {
    var res = new Array(divisor.length).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res.shift();
      res.push(0);
      for (var j = 0; j < divisor.length; j++) res[j] ^= gmul(divisor[j], factor);
    }
    return res;
  }

  // ── Encoder ──
  function utf8(text) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    var s = unescape(encodeURIComponent(text));
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function pickVersion(nbytes, ecc) {
    for (var ver = 1; ver <= 20; ver++) {
      var bits = 4 + (ver < 10 ? 8 : 16) + nbytes * 8;
      if (bits <= dataCodewords(ver, ecc) * 8) return ver;
    }
    return 0;
  }

  function formatBits(ecc, mask) {
    var data = (FORMAT_BITS[ecc] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(ver) {
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (ver << 12) | rem;
  }

  function encode(text, options) {
    var ecc = options && options.ecc === "L" ? "L" : "M";
    var bytes = utf8(String(text));
    var ver = pickVersion(bytes.length, ecc);
    if (!ver) throw new Error("too long for a QR code");
    var size = sizeOf(ver);

    // Bit stream: mode, count, data, terminator, padding
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);
    var cap = dataCodewords(ver, ecc) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    var data = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
      data.push(byte);
    }

    // Split into blocks, add Reed-Solomon, interleave
    var nb = NUM_BLOCKS[ecc][ver];
    var eccLen = ECC_PER_BLOCK[ecc][ver];
    var raw = Math.floor(rawModules(ver) / 8);
    var shortBlocks = nb - (raw % nb);
    var shortLen = Math.floor(raw / nb);
    var divisor = rsDivisor(eccLen);
    var blocks = [];
    var pos = 0;
    for (var bi = 0; bi < nb; bi++) {
      var len = shortLen - eccLen + (bi < shortBlocks ? 0 : 1);
      var dat = data.slice(pos, pos + len);
      pos += len;
      var e = rsRemainder(dat, divisor);
      if (bi < shortBlocks) dat.push(0); // placeholder so columns line up
      blocks.push(dat.concat(e));
    }
    var all = [];
    for (var col = 0; col < blocks[0].length; col++) {
      for (var r = 0; r < blocks.length; r++) {
        if (col !== shortLen - eccLen || r >= shortBlocks) all.push(blocks[r][col]);
      }
    }

    // Draw
    var fmask = functionMask(ver);
    var order = dataOrder(ver, fmask);
    var grid = [];
    for (var y = 0; y < size; y++) grid.push(new Uint8Array(size));
    for (var n = 0; n < order.length; n++) {
      var bit = n < all.length * 8 ? (all[n >> 3] >>> (7 - (n & 7))) & 1 : 0;
      grid[order[n][1]][order[n][0]] = bit;
    }

    function drawFunctions(mask) {
      var g = grid;
      function set(x, y, v) { if (x >= 0 && y >= 0 && x < size && y < size) g[y][x] = v ? 1 : 0; }
      for (var t = 0; t < size; t++) { set(6, t, t % 2 === 0); set(t, 6, t % 2 === 0); }
      function finder(cx, cy) {
        for (var dy = -4; dy <= 4; dy++) {
          for (var dx = -4; dx <= 4; dx++) {
            var dist = Math.max(Math.abs(dx), Math.abs(dy));
            set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
          }
        }
      }
      finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
      var a = alignPositions(ver);
      for (var i2 = 0; i2 < a.length; i2++) {
        for (var j2 = 0; j2 < a.length; j2++) {
          if ((i2 === 0 && j2 === 0) || (i2 === 0 && j2 === a.length - 1) || (i2 === a.length - 1 && j2 === 0)) continue;
          for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) set(a[i2] + dx2, a[j2] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
        }
      }
      var f = formatBits(ecc, mask);
      for (var q = 0; q <= 5; q++) set(8, q, (f >>> q) & 1);
      set(8, 7, (f >>> 6) & 1); set(8, 8, (f >>> 7) & 1); set(7, 8, (f >>> 8) & 1);
      for (var q2 = 9; q2 < 15; q2++) set(14 - q2, 8, (f >>> q2) & 1);
      for (var q3 = 0; q3 < 8; q3++) set(size - 1 - q3, 8, (f >>> q3) & 1);
      for (var q4 = 8; q4 < 15; q4++) set(8, size - 15 + q4, (f >>> q4) & 1);
      set(8, size - 8, 1); // the always-dark module
      if (ver >= 7) {
        var v = versionBits(ver);
        for (var w = 0; w < 18; w++) {
          var bit2 = (v >>> w) & 1;
          var a2 = size - 11 + (w % 3);
          var b2 = Math.floor(w / 3);
          set(a2, b2, bit2); set(b2, a2, bit2);
        }
      }
    }

    // Pick the mask with the lowest penalty
    var best = null;
    var bestMask = 0;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var g2 = grid.map(function (row) { return Uint8Array.from(row); });
      for (var n2 = 0; n2 < order.length; n2++) {
        var xx = order[n2][0], yy = order[n2][1];
        if (maskBit(mask, xx, yy)) g2[yy][xx] ^= 1;
      }
      var saved = grid;
      grid = g2;
      drawFunctions(mask);
      var score = penalty(g2, size);
      grid = saved;
      if (score < bestScore) { bestScore = score; best = g2; bestMask = mask; }
    }
    return { size: size, version: ver, ecc: ecc, mask: bestMask, modules: best.map(function (row) { return Array.from(row, Boolean); }) };
  }

  function penalty(g, size) {
    var score = 0;
    var y, x, run, i;
    function line(get) {
      var runC = 1;
      for (var k = 1; k < size; k++) {
        if (get(k) === get(k - 1)) {
          runC++;
          if (runC === 5) score += 3; else if (runC > 5) score++;
        } else runC = 1;
      }
      // finder-like 1:1:3:1:1 with 4 light on a side
      var s = "";
      for (var k2 = 0; k2 < size; k2++) s += get(k2) ? "1" : "0";
      var re = /(?=(10111010000|00001011101))/g;
      var m;
      while ((m = re.exec(s))) { score += 40; re.lastIndex = m.index + 1; }
    }
    for (y = 0; y < size; y++) { (function (yy) { line(function (k) { return g[yy][k]; }); })(y); }
    for (x = 0; x < size; x++) { (function (xx) { line(function (k) { return g[k][xx]; }); })(x); }
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var c = g[y][x];
      if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) score += 3;
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (i = 0; i < size; i++) dark += g[y][i];
    var total = size * size;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10 - 0;
    return score;
  }

  function draw(canvas, qr, px) {
    var quiet = 4;
    var scale = px || 6;
    var dim = (qr.size + quiet * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = "#000";
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }

  // ── Decoder ──
  // Reed-Solomon: returns corrected block (data + ecc) or null.
  function rsCorrect(block, eccLen) {
    var n = block.length;
    var synd = new Array(eccLen).fill(0);
    var clean = true;
    var i, j;
    for (i = 0; i < eccLen; i++) {
      var s = 0;
      for (j = 0; j < n; j++) s = gmul(s, EXP[i]) ^ block[j];
      synd[i] = s;
      if (s) clean = false;
    }
    if (clean) return block;

    // Berlekamp-Massey
    var C = [1], B = [1];
    var L = 0, m = 1, bb = 1;
    for (var step = 0; step < eccLen; step++) {
      var d = synd[step];
      for (i = 1; i <= L; i++) d ^= gmul(C[i] || 0, synd[step - i]);
      if (d === 0) { m++; continue; }
      var T = C.slice();
      var coef = gdiv(d, bb);
      while (C.length < B.length + m) C.push(0);
      for (i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
      if (2 * L <= step) { L = step + 1 - L; B = T; bb = d; m = 1; } else m++;
    }
    if (L * 2 > eccLen) return null;

    // Chien search: error at position p (from the end) if C(alpha^-p) == 0
    var locs = [];
    for (var p = 0; p < n; p++) {
      var x = EXP[(255 - p) % 255];
      var sum = 0, xp = 1;
      for (i = 0; i <= L; i++) { sum ^= gmul(C[i] || 0, xp); xp = gmul(xp, x); }
      if (sum === 0) locs.push(p);
    }
    if (locs.length !== L) return null;

    // Forney: omega = S(x) * C(x) mod x^eccLen
    var omega = new Array(eccLen).fill(0);
    for (i = 0; i < eccLen; i++) for (j = 0; j <= i && j <= L; j++) omega[i] ^= gmul(C[j] || 0, synd[i - j]);
    var out = block.slice();
    for (var e = 0; e < locs.length; e++) {
      var pos = locs[e];
      var xi = EXP[pos];            // alpha^pos
      var xiInv = EXP[(255 - pos) % 255];
      var num = 0, pw = 1;
      for (i = 0; i < eccLen; i++) { num ^= gmul(omega[i], pw); pw = gmul(pw, xiInv); }
      var den = 0;
      for (i = 1; i <= L; i += 2) den ^= gmul(C[i] || 0, EXP[(255 - ((pos * (i - 1)) % 255)) % 255]); // odd-degree terms of C', at x = alpha^-pos
      if (den === 0) return null;
      var mag = gmul(xi, gdiv(num, den));
      out[n - 1 - pos] ^= mag;
    }
    // Confirm the repair
    for (i = 0; i < eccLen; i++) {
      var s2 = 0;
      for (j = 0; j < n; j++) s2 = gmul(s2, EXP[i]) ^ out[j];
      if (s2) return null;
    }
    return out;
  }

  // Valid 15-bit format words, to find the nearest one to what was read
  var FORMAT_WORDS = [];
  (function () {
    var eccs = ["L", "M", "Q", "H"];
    for (var e = 0; e < 4; e++) for (var m = 0; m < 8; m++) FORMAT_WORDS.push({ ecc: eccs[e], mask: m, word: formatBits(eccs[e], m) });
  })();
  function popcount(n) { var c = 0; while (n) { c += n & 1; n >>>= 1; } return c; }
  function nearestFormat(word) {
    var best = null, bd = 99;
    for (var i = 0; i < FORMAT_WORDS.length; i++) {
      var d = popcount(FORMAT_WORDS[i].word ^ word);
      if (d < bd) { bd = d; best = FORMAT_WORDS[i]; }
    }
    return bd <= 3 ? best : null;
  }

  // Read modules of a known-size grid and turn them into text
  function readGrid(get, ver) {
    var size = sizeOf(ver);
    // Format info, two copies
    var f1 = 0, f2 = 0, i;
    for (i = 0; i <= 5; i++) f1 |= get(8, i) << i;
    f1 |= get(8, 7) << 6; f1 |= get(8, 8) << 7; f1 |= get(7, 8) << 8;
    for (i = 9; i < 15; i++) f1 |= get(14 - i, 8) << i;
    for (i = 0; i < 8; i++) f2 |= get(size - 1 - i, 8) << i;
    for (i = 8; i < 15; i++) f2 |= get(8, size - 15 + i) << i;
    var fmt = nearestFormat(f1) || nearestFormat(f2);
    if (!fmt || !ECC_PER_BLOCK[fmt.ecc]) return null;
    var ecc = fmt.ecc;

    var fmask = functionMask(ver);
    var order = dataOrder(ver, fmask);
    var raw = Math.floor(rawModules(ver) / 8);
    var codewords = new Array(raw).fill(0);
    for (var n = 0; n < raw * 8; n++) {
      var bit = get(order[n][0], order[n][1]) ^ (maskBit(fmt.mask, order[n][0], order[n][1]) ? 1 : 0);
      codewords[n >> 3] |= bit << (7 - (n & 7));
    }

    // Undo the interleave
    var nb = NUM_BLOCKS[ecc][ver];
    var eccLen = ECC_PER_BLOCK[ecc][ver];
    var shortBlocks = nb - (raw % nb);
    var shortLen = Math.floor(raw / nb);
    var blocks = [];
    for (var b = 0; b < nb; b++) blocks.push([]);
    var idx = 0;
    var dataShort = shortLen - eccLen;
    for (var col = 0; col < dataShort + 1; col++) {
      for (var r = 0; r < nb; r++) {
        if (col === dataShort && r < shortBlocks) continue;
        blocks[r].push(codewords[idx++]);
      }
    }
    for (var col2 = 0; col2 < eccLen; col2++) for (var r2 = 0; r2 < nb; r2++) blocks[r2].push(codewords[idx++]);

    var data = [];
    for (var bi = 0; bi < nb; bi++) {
      var fixed = rsCorrect(blocks[bi], eccLen);
      if (!fixed) return null;
      for (var k = 0; k < fixed.length - eccLen; k++) data.push(fixed[k]);
    }

    // Parse segments (byte mode only; that is all we ever make)
    var pos = 0;
    function take(len) {
      var v = 0;
      for (var q = 0; q < len; q++) {
        if (pos >= data.length * 8) return -1;
        v = (v << 1) | ((data[pos >> 3] >>> (7 - (pos & 7))) & 1);
        pos++;
      }
      return v;
    }
    var out = [];
    while (true) {
      var mode = take(4);
      if (mode <= 0) break;
      if (mode !== 4) return null;
      var count = take(ver < 10 ? 8 : 16);
      if (count < 0) return null;
      for (var c = 0; c < count; c++) {
        var byte = take(8);
        if (byte < 0) return null;
        out.push(byte);
      }
    }
    try { return decodeURIComponent(escape(String.fromCharCode.apply(null, out))); }
    catch (e) { return String.fromCharCode.apply(null, out); }
  }

  // Black/white from luma, using a local average so shadows and glare don't matter
  function binarize(gray, w, h, bias) {
    var integral = new Float64Array((w + 1) * (h + 1));
    var x, y;
    for (y = 0; y < h; y++) {
      var row = 0;
      for (x = 0; x < w; x++) {
        row += gray[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
      }
    }
    var half = Math.max(8, Math.round(Math.min(w, h) / 12));
    var bin = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
        var sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        var mean = sum / ((x1 - x0) * (y1 - y0));
        bin[y * w + x] = gray[y * w + x] < mean * bias ? 1 : 0; // 1 = dark
      }
    }
    return bin;
  }

  // Finder squares: along a line, dark:light:dark:light:dark in 1:1:3:1:1
  function matchRatio(runs) {
    var total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
    if (total < 7) return 0;
    var unit = total / 7;
    var tol = unit * 0.6;
    if (Math.abs(runs[0] - unit) < tol && Math.abs(runs[1] - unit) < tol && Math.abs(runs[2] - 3 * unit) < 3 * tol &&
        Math.abs(runs[3] - unit) < tol && Math.abs(runs[4] - unit) < tol) return unit;
    return 0;
  }

  function crossCheck(bin, w, h, cx, cy, dx, dy, unit) {
    // Walk out from the centre both ways along (dx,dy), measuring the 5 runs
    var runs = [0, 0, 0, 0, 0];
    var x = cx, y = cy;
    var state = 2;
    while (x >= 0 && y >= 0 && x < w && y < h && bin[y * w + x] === (state % 2 === 0 ? 1 : 0)) { runs[state]++; x -= dx; y -= dy; if (runs[state] > unit * 5) return 0; }
    state = 1;
    while (state >= 0 && x >= 0 && y >= 0 && x < w && y < h) {
      if (bin[y * w + x] === (state % 2 === 0 ? 1 : 0)) { runs[state]++; x -= dx; y -= dy; if (runs[state] > unit * 5) return 0; }
      else { state--; }
    }
    if (state >= 0) return 0;
    x = cx + dx; y = cy + dy;
    state = 2;
    while (x >= 0 && y >= 0 && x < w && y < h && bin[y * w + x] === 1) { runs[2]++; x += dx; y += dy; if (runs[2] > unit * 5) return 0; }
    state = 3;
    while (state <= 4 && x >= 0 && y >= 0 && x < w && y < h) {
      if (bin[y * w + x] === (state % 2 === 0 ? 1 : 0)) { runs[state]++; x += dx; y += dy; if (runs[state] > unit * 5) return 0; }
      else { state++; }
    }
    if (state <= 4) return 0;
    return matchRatio(runs);
  }

  function findFinders(bin, w, h) {
    var cands = [];
    for (var y = 0; y < h; y += 1) {
      var runs = [0, 0, 0, 0, 0];
      var state = 0;
      var cur = bin[y * w];
      var run = 0;
      // run-length encode the row, test every window of 5
      var lens = [], starts = [], vals = [];
      var start = 0;
      for (var x = 0; x <= w; x++) {
        var v = x < w ? bin[y * w + x] : -1;
        if (v !== cur) {
          lens.push(x - start); starts.push(start); vals.push(cur);
          start = x; cur = v;
        }
      }
      for (var i = 0; i + 4 < lens.length; i++) {
        if (vals[i] !== 1) continue;
        var r5 = [lens[i], lens[i + 1], lens[i + 2], lens[i + 3], lens[i + 4]];
        var unit = matchRatio(r5);
        if (!unit) continue;
        var cx = Math.round(starts[i] + (r5[0] + r5[1] + r5[2] / 2));
        var vu = crossCheck(bin, w, h, cx, y, 0, 1, unit);
        if (!vu) continue;
        // centre y of the vertical run: refine by walking
        var up = 0, yy = y;
        while (yy > 0 && bin[(yy - 1) * w + cx] === 1) { yy--; up++; }
        var down = 0; yy = y;
        while (yy < h - 1 && bin[(yy + 1) * w + cx] === 1) { yy++; down++; }
        var cy = y - up + (up + down) / 2;
        var hu = crossCheck(bin, w, h, cx, Math.round(cy), 1, 0, unit);
        if (!hu) continue;
        var ms = (unit + vu + hu) / 3;
        var merged = false;
        for (var c = 0; c < cands.length; c++) {
          var cd = cands[c];
          if (Math.abs(cd.x - cx) < ms * 2 && Math.abs(cd.y - cy) < ms * 2 && Math.abs(cd.ms - ms) < ms * 0.5) {
            cd.x = (cd.x * cd.n + cx) / (cd.n + 1);
            cd.y = (cd.y * cd.n + cy) / (cd.n + 1);
            cd.ms = (cd.ms * cd.n + ms) / (cd.n + 1);
            cd.n++;
            merged = true;
            break;
          }
        }
        if (!merged) cands.push({ x: cx, y: cy, ms: ms, n: 1 });
      }
    }
    return cands.filter(function (c) { return c.n >= 2; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 12);
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Solve for the projective map taking the unit points to four image points
  function homography(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    var n = 8, r, c, k;
    for (c = 0; c < n; c++) {
      var piv = c;
      for (r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-9) return null;
      var tA = A[c]; A[c] = A[piv]; A[piv] = tA;
      var tb = b[c]; b[c] = b[piv]; b[piv] = tb;
      for (r = 0; r < n; r++) {
        if (r === c) continue;
        var f = A[r][c] / A[c][c];
        for (k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    var h = [];
    for (r = 0; r < n; r++) h.push(b[r] / A[r][r]);
    return function (x2, y2) {
      var d = h[6] * x2 + h[7] * y2 + 1;
      return [(h[0] * x2 + h[1] * y2 + h[2]) / d, (h[3] * x2 + h[4] * y2 + h[5]) / d];
    };
  }

  // Looks for the bottom-right alignment square near where the affine map expects it
  function findAlignment(bin, w, h, px, py, ms) {
    var best = null, bestScore = 1e9;
    var rad = Math.round(ms * 4);
    for (var y = Math.round(py - rad); y <= py + rad; y++) {
      for (var x = Math.round(px - rad); x <= px + rad; x++) {
        if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) continue;
        // centre dark, ring at ~1 module light, ring at ~2 modules dark
        var s = Math.max(1, Math.round(ms));
        if (!bin[y * w + x]) continue;
        var bad = 0;
        for (var a = 0; a < 8; a++) {
          var ang = a * Math.PI / 4;
          var cx1 = Math.round(x + Math.cos(ang) * ms), cy1 = Math.round(y + Math.sin(ang) * ms);
          var cx2 = Math.round(x + Math.cos(ang) * ms * 2), cy2 = Math.round(y + Math.sin(ang) * ms * 2);
          if (bin[cy1 * w + cx1]) bad++;
          if (!bin[cy2 * w + cx2]) bad++;
        }
        var score = bad + Math.hypot(x - px, y - py) / ms * 0.3;
        if (score < bestScore) { bestScore = score; best = [x, y]; }
        void s;
      }
    }
    return bestScore <= 3 ? best : null;
  }

  function tryTriple(bin, w, h, tl, tr, bl) {
    var ms = (tl.ms + tr.ms + bl.ms) / 3;
    var side = (dist(tl, tr) + dist(tl, bl)) / 2;
    var estDim = side / ms + 7;
    var baseVer = Math.round((estDim - 17) / 4);
    var tries = [baseVer, baseVer - 1, baseVer + 1, baseVer - 2, baseVer + 2];
    for (var t = 0; t < tries.length; t++) {
      var ver = tries[t];
      if (ver < 1 || ver > 20) continue;
      var dim = sizeOf(ver);
      // affine guess for the 4th point (module coords dim-6.5, dim-6.5)
      var ux = (tr.x - tl.x) / (dim - 7), uy = (tr.y - tl.y) / (dim - 7);
      var vx = (bl.x - tl.x) / (dim - 7), vy = (bl.y - tl.y) / (dim - 7);
      function aff(mx, my) { return [tl.x + (mx - 3.5) * ux + (my - 3.5) * vx, tl.y + (mx - 3.5) * uy + (my - 3.5) * vy]; }
      var src = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5]];
      var fourth = [dim - 6.5, dim - 6.5];
      var guess = aff(fourth[0], fourth[1]);
      var maps = [];
      if (ver >= 2) {
        var al = findAlignment(bin, w, h, guess[0], guess[1], ms * 0.5 * (Math.hypot(ux, uy) + Math.hypot(vx, vy)) / (ms * 0.5 * 2) * 1);
        if (al) maps.push(homography([src[0], src[1], src[2], fourth], [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], al]));
      }
      maps.push(homography([src[0], src[1], src[2], fourth], [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], guess]));
      for (var mi = 0; mi < maps.length; mi++) {
        var map = maps[mi];
        if (!map) continue;
        var text = readGrid(function (mx, my) {
          // vote over the centre and four neighbours so a speck can't flip a module
          var p = map(mx + 0.5, my + 0.5);
          var q1 = map(mx + 0.25, my + 0.5), q2 = map(mx + 0.75, my + 0.5), q3 = map(mx + 0.5, my + 0.25), q4 = map(mx + 0.5, my + 0.75);
          var votes = 0;
          var pts = [p, q1, q2, q3, q4];
          for (var pi = 0; pi < 5; pi++) {
            var px2 = Math.round(pts[pi][0] - 0.5), py2 = Math.round(pts[pi][1] - 0.5);
            if (px2 >= 0 && py2 >= 0 && px2 < w && py2 < h) votes += bin[py2 * w + px2];
          }
          return votes >= 3 ? 1 : 0;
        }, ver);
        if (text !== null) return text;
      }
    }
    return null;
  }

  // Camera frames vary, so try a few thresholds; the first one that decodes wins.
  function decode(gray, w, h) {
    var biases = [0.92, 0.84, 1.0];
    for (var i = 0; i < biases.length; i++) {
      var text = decodeAt(gray, w, h, biases[i]);
      if (text !== null) return text;
    }
    return null;
  }

  function decodeAt(gray, w, h, bias) {
    var bin = binarize(gray, w, h, bias);
    var finders = findFinders(bin, w, h);
    if (finders.length < 3) return null;
    for (var a = 0; a < finders.length; a++) {
      for (var b = a + 1; b < finders.length; b++) {
        for (var c = b + 1; c < finders.length; c++) {
          var pts = [finders[a], finders[b], finders[c]];
          var ms = (pts[0].ms + pts[1].ms + pts[2].ms) / 3;
          if (Math.max(pts[0].ms, pts[1].ms, pts[2].ms) > Math.min(pts[0].ms, pts[1].ms, pts[2].ms) * 1.7) continue;
          // corner = the point opposite the longest side
          var d01 = dist(pts[0], pts[1]), d02 = dist(pts[0], pts[2]), d12 = dist(pts[1], pts[2]);
          var corner, p1, p2;
          if (d12 >= d01 && d12 >= d02) { corner = pts[0]; p1 = pts[1]; p2 = pts[2]; }
          else if (d02 >= d01 && d02 >= d12) { corner = pts[1]; p1 = pts[0]; p2 = pts[2]; }
          else { corner = pts[2]; p1 = pts[0]; p2 = pts[1]; }
          var s1 = dist(corner, p1), s2 = dist(corner, p2);
          if (Math.abs(s1 - s2) > Math.max(s1, s2) * 0.25) continue; // a square code has equal sides
          if (s1 < ms * 12) continue;
          // right angle at the corner
          var dot = ((p1.x - corner.x) * (p2.x - corner.x) + (p1.y - corner.y) * (p2.y - corner.y)) / (s1 * s2);
          if (Math.abs(dot) > 0.35) continue;
          // order so that TR then BL turns clockwise on screen (y down)
          var cross = (p1.x - corner.x) * (p2.y - corner.y) - (p1.y - corner.y) * (p2.x - corner.x);
          var tr = cross > 0 ? p1 : p2;
          var bl = cross > 0 ? p2 : p1;
          var text = tryTriple(bin, w, h, corner, tr, bl);
          if (text !== null) return text;
        }
      }
    }
    return null;
  }

  return { encode: encode, draw: draw, decode: decode, _internals: { functionMask: functionMask, rsCorrect: rsCorrect, rsRemainder: rsRemainder, rsDivisor: rsDivisor, sizeOf: sizeOf } };
});
