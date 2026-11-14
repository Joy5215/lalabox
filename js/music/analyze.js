/* ============================================================
 * music/analyze.js — YIN 音高检测 → 音符化 → 网格量化
 * 特点：分帧切片在 rAF 中执行，避免长任务卡住界面
 * 暴露：LALA.ANALYZE
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var U = L.util, C = L.C;

  var SR = 16000;          // 分析采样率
  var W = 512;             // 分析窗长（约 32ms）
  var HOP = 256;           // 帧移（16ms）
  var TAU_MIN = 18;        // 16k / 900Hz
  var TAU_MAX = 229;       // 16k / 70Hz
  var CMND_THRESHOLD = 0.16;

  function downsample(buf, srcRate) {
    var ratio = srcRate / SR;
    var outLen = Math.floor(buf.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var s = Math.floor(i * ratio);
      var e = Math.min(buf.length, Math.floor((i + 1) * ratio));
      var sum = 0, cnt = 0;
      for (var j = s; j < e; j++) { sum += buf[j]; cnt++; }
      out[i] = cnt ? sum / cnt : 0;
    }
    return out;
  }

  function frameAt(pcm, start) {
    var rms = 0, i;
    for (i = 0; i < W; i++) { var v = pcm[start + i]; rms += v * v; }
    rms = Math.sqrt(rms / W);

    var diff = new Float32Array(TAU_MAX + 1);
    for (var tau = 1; tau <= TAU_MAX; tau++) {
      var sum = 0;
      for (var j = 0; j < W; j++) {
        var d = pcm[start + j] - pcm[start + j + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    var cmnd = new Float32Array(TAU_MAX + 1);
    cmnd[0] = 1;
    var running = 0;
    for (var t2 = 1; t2 <= TAU_MAX; t2++) {
      running += diff[t2];
      cmnd[t2] = running > 1e-12 ? diff[t2] * t2 / running : 1;
    }

    var best = -1;
    for (i = TAU_MIN; i <= TAU_MAX; i++) {
      if (cmnd[i] < CMND_THRESHOLD) { best = i; break; }
    }
    if (best < 0) {
      var minv = 1e9;
      for (i = TAU_MIN; i <= TAU_MAX; i++) {
        if (cmnd[i] < minv) { minv = cmnd[i]; best = i; }
      }
      if (minv > 0.55) return { rms: rms, f0: 0, clarity: 0 };
    }

    var y0 = cmnd[best - 1] || cmnd[best];
    var y1 = cmnd[best];
    var y2 = cmnd[best + 1] || cmnd[best];
    var denom = 2 * (2 * y1 - y0 - y2);
    var shift = denom !== 0 ? (y2 - y0) / denom : 0;
    var tauEst = best + U.clamp(shift, -0.9, 0.9);

    return { rms: rms, f0: SR / tauEst, clarity: 1 - y1 };
  }

  function run(pcm, srcRate, offsetSec, onProgress) {
    var sliced = pcm;
    if (offsetSec > 0) {
      var st = Math.floor(offsetSec * srcRate);
      var en = Math.min(pcm.length, st + Math.floor(C.BEATS * C.SPB * srcRate) + srcRate * 0.4);
      sliced = pcm.slice(Math.max(0, st), en);
    }
    var ds = downsample(sliced, srcRate);
    var total = Math.max(0, Math.floor((ds.length - W - TAU_MAX) / HOP));
    if (total < 8) return Promise.resolve([]);

    var frames = new Array(total);

    return new Promise(function (resolve) {
      var i = 0;
      function step() {
        var t0 = performance.now();
        while (i < total && performance.now() - t0 < 8) {
          frames[i] = frameAt(ds, i * HOP);
          i++;
        }
        if (onProgress) onProgress(i / total);
        if (i < total) requestAnimationFrame(step);
        else resolve(toNotes(frames));
      }
      step();
    });
  }

  function toNotes(frames) {
    var i, peak = 0;
    for (i = 0; i < frames.length; i++) {
      if (frames[i] && frames[i].rms > peak) peak = frames[i].rms;
    }
    if (peak < 0.006) return [];
    var gate = Math.max(0.006, peak * 0.11);

    var voiced = [];
    for (i = 0; i < frames.length; i++) {
      var f = frames[i];
      var ok = f && f.f0 > 68 && f.f0 < 1100 && f.clarity > 0.55 && f.rms > gate;
      voiced.push(ok ? Math.round(69 + 12 * Math.log2(f.f0 / 440)) : null);
    }

    var idx = [];
    for (i = 0; i < voiced.length; i++) if (voiced[i] != null) idx.push(i);
    for (var k = 0; k < idx.length; k++) {
      var win = [];
      for (var w = k - 2; w <= k + 2; w++) {
        if (w >= 0 && w < idx.length) win.push(voiced[idx[w]]);
      }
      voiced[idx[k]] = Math.round(U.median(win));
    }

    var last = null;
    for (i = 0; i < voiced.length; i++) {
      if (voiced[i] == null) continue;
      if (last != null) {
        var diff = voiced[i] - last;
        if (diff > 7) voiced[i] -= 12;
        else if (diff < -7) voiced[i] += 12;
      }
      last = voiced[i];
    }

    var notes = [], cur = null, gap = 0;
    for (i = 0; i < voiced.length; i++) {
      var m = voiced[i];
      if (m == null) {
        gap++;
        if (cur && gap > 3) { notes.push(cur); cur = null; }
        continue;
      }
      if (cur) {
        var dm = Math.abs(m - cur.sum / cur.n);
        if (dm > 0.85 || gap > 3) {
          notes.push(cur);
          cur = { start: i, sum: m, n: 1, end: i };
        } else {
          cur.sum += m; cur.n += 1; cur.end = i;
        }
      } else {
        cur = { start: i, sum: m, n: 1, end: i };
      }
      gap = 0;
    }
    if (cur) notes.push(cur);

    var fr = HOP / SR;
    var out = [];
    for (i = 0; i < notes.length; i++) {
      var n0 = notes[i];
      var b = (n0.start * fr) / C.SPB;
      var dur = ((n0.end - n0.start + 1) * fr) / C.SPB;
      if (dur < 0.11) continue;
      var qb = Math.round(b * 2) / 2;
      var qd = U.clamp(Math.round(dur * 2) / 2, 0.5, 2);
      if (qb < 0 || qb >= 16) continue;
      out.push({ b: qb, d: qd, m: Math.round(n0.sum / n0.n) });
    }

    out.sort(function (a, b2) { return a.b - b2.b; });
    var merged = [];
    for (i = 0; i < out.length; i++) {
      var prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.b - out[i].b) < 0.01) {
        if (out[i].d > prev.d) prev.d = out[i].d;
        continue;
      }
      merged.push(out[i]);
    }
    return merged.slice(0, 64);
  }

  L.ANALYZE = { run: run, downsample: downsample };
})();
