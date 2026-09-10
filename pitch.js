/*
 * Pitch detection for the tuner — McLeod Pitch Method (MPM).
 *
 * The normalised square difference function (NSDF) is computed through an FFT
 * so a full 170 ms window costs O(n log n) instead of the O(n^2) a plain
 * time-domain autocorrelation would need. MPM's "first peak within 90% of the
 * best one" rule is what keeps the low strings, whose fundamental is much
 * weaker than their harmonics, from reading an octave out.
 *
 * Everything runs locally, so the tuner still works with no connection.
 */
(function (global) {
  "use strict";

  const TARGET_RATE = 11000; // analysis rate after decimation
  const MIN_FREQ = 60; // below a very flat drop-D low string
  const MAX_FREQ = 1300;
  // McLeod's k. Measured across the harness in test_pitch.js: 0.9 lets strong
  // low-frequency interference pull the top strings an octave down, 0.7 starts
  // producing octave-up reads on notes with no fundamental.
  const PEAK_THRESHOLD = 0.8;
  const MIN_RMS = 0.0025;

  function Fft(size) {
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  // In-place iterative radix-2 Cooley-Tukey.
  Fft.prototype.transform = function (re, im) {
    const n = this.size;
    const cos = this.cos;
    const sin = this.sin;

    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };

  // Fit a parabola through the sample and its neighbours to get a peak
  // position between samples, plus the height at that position.
  function interpolatePeak(arr, pos) {
    const y1 = arr[pos - 1];
    const y2 = arr[pos];
    const y3 = arr[pos + 1];
    const a = (y1 + y3 - 2 * y2) / 2;
    const b = (y3 - y1) / 2;
    if (a >= -1e-12) return { pos: pos, value: y2 };
    const shift = -b / (2 * a);
    if (!(shift > -1 && shift < 1)) return { pos: pos, value: y2 };
    return { pos: pos + shift, value: y2 - (b * b) / (4 * a) };
  }

  /**
   * @param {number} sampleRate  rate of the buffers passed to detect()
   * @param {number} frameSize   length of those buffers
   */
  function PitchDetector(sampleRate, frameSize) {
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
    this.decimation = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
    this.rate = sampleRate / this.decimation;
    this.n = Math.floor(frameSize / this.decimation);
    this.nsdfLen = this.n >> 1;

    let fftSize = 1;
    while (fftSize < this.n * 2) fftSize <<= 1;
    this.fft = new Fft(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);

    this.x = new Float64Array(this.n);
    this.prefix = new Float64Array(this.n + 1);
    this.nsdf = new Float64Array(this.nsdfLen + 2);

    this.minLag = Math.max(2, Math.floor(this.rate / MAX_FREQ));
    this.maxLag = Math.min(this.nsdfLen - 2, Math.ceil(this.rate / MIN_FREQ));
    this.peakPos = [];
    this.peakVal = [];
  }

  // Average groups of samples on the way down to the analysis rate: cheap
  // extra anti-aliasing on top of the low-pass in the audio graph.
  PitchDetector.prototype._load = function (buf) {
    const d = this.decimation;
    const n = this.n;
    const x = this.x;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const base = i * d;
      for (let k = 0; k < d; k++) sum += buf[base + k];
      const v = sum / d;
      x[i] = v;
      mean += v;
    }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      x[i] -= mean;
      energy += x[i] * x[i];
    }
    return Math.sqrt(energy / n);
  };

  PitchDetector.prototype._nsdf = function () {
    const n = this.n;
    const size = this.fft.size;
    const re = this.re;
    const im = this.im;

    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n; i++) re[i] = this.x[i];
    this.fft.transform(re, im);
    for (let i = 0; i < size; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    // The power spectrum is real and even, so a second forward transform is
    // the inverse up to the 1/size scale.
    this.fft.transform(re, im);

    const prefix = this.prefix;
    const x = this.x;
    prefix[0] = 0;
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i] * x[i];
    const total = prefix[n];

    const nsdf = this.nsdf;
    const scale = 1 / size;
    for (let tau = 0; tau <= this.nsdfLen + 1; tau++) {
      // m'(tau) counts the energy of both overlapping halves
      const m = prefix[n - tau] + (total - prefix[tau]);
      nsdf[tau] = m > 1e-12 ? (2 * re[tau] * scale) / m : 0;
    }
  };

  // Highest point of every stretch where the NSDF is positive, ignoring the
  // lobe around zero lag.
  PitchDetector.prototype._collectPeaks = function () {
    const nsdf = this.nsdf;
    const maxLag = this.maxLag;
    const pos = this.peakPos;
    const val = this.peakVal;
    pos.length = 0;
    val.length = 0;

    let tau = 1;
    while (tau < maxLag && nsdf[tau] > 0) tau++;
    while (tau < maxLag) {
      while (tau < maxLag && nsdf[tau] <= 0) tau++;
      let bestPos = -1;
      let bestVal = 0;
      while (tau < maxLag && nsdf[tau] > 0) {
        if (nsdf[tau] > bestVal) {
          bestVal = nsdf[tau];
          bestPos = tau;
        }
        tau++;
      }
      if (bestPos > 0) {
        pos.push(bestPos);
        val.push(bestVal);
      }
    }
  };

  PitchDetector.prototype._locate = function (center, window) {
    const nsdf = this.nsdf;
    const limit = this.nsdfLen - 2;
    let pos = -1;
    let val = -Infinity;
    for (let t = center - window; t <= center + window; t++) {
      if (t < 2 || t > limit) continue;
      if (nsdf[t] > val) {
        val = nsdf[t];
        pos = t;
      }
    }
    if (pos < 2 || pos > limit) return null;
    if (!(nsdf[pos] >= nsdf[pos - 1] && nsdf[pos] >= nsdf[pos + 1])) return null;
    return interpolatePeak(nsdf, pos);
  };

  // The NSDF repeats at every multiple of the period, and measuring the peak
  // furthest out divides the interpolation error by that multiple. Without
  // this the top strings would only resolve to a few cents.
  PitchDetector.prototype._refine = function (base) {
    const limit = this.nsdfLen - 2;
    let period = base.pos;
    let k = 1;

    for (;;) {
      const next = k * 2;
      const center = Math.round(period * next);
      if (center + 2 > limit) break;
      const found = this._locate(center, Math.max(1, Math.round(period * 0.25)));
      if (!found || found.value < base.value * 0.6) break;
      period = found.pos / next;
      k = next;
    }

    const last = Math.floor(limit / period);
    if (last > k) {
      const found = this._locate(
        Math.round(period * last),
        Math.max(1, Math.round(period * 0.25))
      );
      if (found && found.value >= base.value * 0.6) period = found.pos / last;
    }
    return period;
  };

  /**
   * @param {Float32Array} buf time-domain samples, length >= frameSize
   * @returns {{frequency:number, clarity:number, rms:number}} frequency is -1
   *   when nothing trustworthy was found; clarity runs 0..1.
   */
  PitchDetector.prototype.detect = function (buf) {
    const rms = this._load(buf);
    if (rms < MIN_RMS) return { frequency: -1, clarity: 0, rms: rms };

    this._nsdf();
    this._collectPeaks();

    const pos = this.peakPos;
    const val = this.peakVal;
    const minLag = this.minLag;

    let best = 0;
    for (let i = 0; i < pos.length; i++) {
      if (pos[i] >= minLag && val[i] > best) best = val[i];
    }
    if (best <= 0) return { frequency: -1, clarity: 0, rms: rms };

    const threshold = best * PEAK_THRESHOLD;
    let chosen = -1;
    for (let i = 0; i < pos.length; i++) {
      if (pos[i] >= minLag && val[i] >= threshold) {
        chosen = pos[i];
        break;
      }
    }
    if (chosen < 2 || chosen > this.nsdfLen - 2) {
      return { frequency: -1, clarity: 0, rms: rms };
    }

    const base = interpolatePeak(this.nsdf, chosen);
    const period = this._refine(base);
    const frequency = this.rate / period;
    if (!(frequency >= MIN_FREQ && frequency <= MAX_FREQ)) {
      return { frequency: -1, clarity: 0, rms: rms };
    }

    return {
      frequency: frequency,
      clarity: Math.max(0, Math.min(1, base.value)),
      rms: rms,
    };
  };

  global.PitchDetector = PitchDetector;
  if (typeof module !== "undefined" && module.exports) module.exports = PitchDetector;
})(typeof self !== "undefined" ? self : globalThis);
