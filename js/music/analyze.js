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
  var W = 640;             // 分析窗长（40ms）；低频需要更长的窗才装得下两个周期
  var HOP = 256;           // 帧移（16ms）
  var TAU_MIN = 18;        // 16k / 900Hz
  var TAU_MAX = 290;       // 16k / 55Hz（人声压到最低也能覆盖）
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
    } else {
      /* 阈值只能标记「进入谷区」，不能定位谷底。停在下降沿上会让周期偏小、
         音高系统性偏高（实测每个音都高约 120 cents），必须继续走到局部最小。 */
      while (best < TAU_MAX && cmnd[best + 1] < cmnd[best]) best++;
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

  /* 最近一次分析的统计，用于区分「没声音」和「有声音但没音高」（气声） */
  var lastStats = { peak: 0, frames: 0, voiced: 0 };

  function toNotes(frames) {
    var i, peak = 0;
    for (i = 0; i < frames.length; i++) {
      if (frames[i] && frames[i].rms > peak) peak = frames[i].rms;
    }
    if (peak < 0.006) { lastStats = { peak: peak, frames: 0, voiced: 0 }; return []; }
    var gate = Math.max(0.006, peak * 0.11);

    var voiced = [], nVoiced = 0;
    for (i = 0; i < frames.length; i++) {
      var f = frames[i];
      /* 范围跟着 TAU_MIN / TAU_MAX 走，别在这里又把低音卡掉 */
      var ok = f && f.f0 > 55 && f.f0 < 900 && f.clarity > 0.55 && f.rms > gate;
      if (ok) nVoiced++;
      /* 先留浮点：帧级四舍五入会把 58.5 这种卡在半音之间的音来回甩成 58 / 59，
         中值平滑拿到的就是两个整数里随机一个，整句听感跟着抖 */
      voiced.push(ok ? 69 + 12 * Math.log2(f.f0 / 440) : null);
    }
    lastStats = { peak: peak, frames: voiced.length, voiced: nVoiced };

    var idx = [];
    for (i = 0; i < voiced.length; i++) if (voiced[i] != null) idx.push(i);
    /* 中值窗从 ±2 帧放到 ±4 帧：人声的颤音、滑音在 ±2（96ms）里按不平，
       会把一个长音切成好几个半音跳变 */
    for (var k = 0; k < idx.length; k++) {
      var win = [];
      for (var w = k - 4; w <= k + 4; w++) {
        if (w >= 0 && w < idx.length) win.push(voiced[idx[w]]);
      }
      voiced[idx[k]] = U.median(win);
    }

    /* 八度纠错：YIN 偶尔会把 f0 判成一半或两倍，表现为 ±12 的跳变。
       阈值必须贴着 12，用 7 会把正常的大跳（六度、七度）误当成八度给压掉。 */
    var last = null;
    for (i = 0; i < voiced.length; i++) {
      if (voiced[i] == null) continue;
      if (last != null) {
        var diff = voiced[i] - last;
        if (diff >= 12) voiced[i] -= 12;
        else if (diff <= -12) voiced[i] += 12;
      }
      last = voiced[i];
    }

    /* 起音检测：同音反复（哒 哒 哒）音高完全没变，只靠音高变化分不开，
       会在能量重新冲起来的地方切一刀。DEV-NOTES 里「同音重复被并成一个音」
       这个老坑就是它——不修的话哼四下一模一样的音，出来只有一个长音 */
    var onsets = new Array(voiced.length).fill(false);
    for (i = 2; i < voiced.length; i++) {
      var r0 = frames[i] ? frames[i].rms : 0;
      var r1 = frames[i - 1] ? frames[i - 1].rms : 0;
      var r2 = frames[i - 2] ? frames[i - 2].rms : 0;
      var prevR = Math.min(r1, r2);
      if (r0 > gate * 1.6 && r0 > prevR * 1.9 && r0 > peak * 0.2) onsets[i] = true;
    }

    /* 换音判定要滞后：单帧偏出半个音就切，会把一个长音在颤音里剁成好几段；
       但阈值放大又切不开只差 1 个半音的正常级进。所以阈值保持 0.9，
       要求「连续 3 帧（48ms）都偏出去」才认，短于 3 帧的当抖动并回本音 */
    var SPLIT = 0.9;
    var notes = [], cur = null, gap = 0;
    var pend = [], pendStart = 0;

    function closeCur() {
      if (cur) notes.push(cur);
      cur = null;
    }

    for (i = 0; i < voiced.length; i++) {
      var m = voiced[i];
      if (m == null) {
        gap++;
        if (cur && gap > 3) { closeCur(); pend = []; }
        continue;
      }
      if (!cur) {
        cur = { start: i, sum: m, n: 1, end: i };
        pend = [];
        gap = 0;
        continue;
      }

      var dm = Math.abs(m - cur.sum / cur.n);
      var attack = onsets[i] && (i - cur.start) >= 3;

      if (dm > SPLIT) {
        if (!pend.length) pendStart = i;
        pend.push(m);
        /* 抖动：没攒够 3 帧就回落到原音，帧数照算进去 */
        if (pend.length < 3 && !attack) {
          cur.end = i;
          gap = 0;
          continue;
        }
        /* 真换音：当前音收在 pending 之前，新音从 pending 的第一帧开始 */
        cur.end = pendStart - 1;
        var head = cur;
        if (head.end >= head.start) notes.push(head);
        cur = { start: pendStart, sum: 0, n: 0, end: i };
        pend.forEach(function (x) { cur.sum += x; cur.n += 1; });
        pend = [];
      } else {
        /* 抖动结束：把挂着的那几帧并回当前音 */
        if (pend.length) {
          pend.forEach(function (x) { cur.sum += x; cur.n += 1; });
          pend = [];
        }
        cur.sum += m;
        cur.n += 1;
        cur.end = i;
      }
      gap = 0;
    }
    if (pend.length && cur) {
      /* 句尾还在 pending 里：够长就独立成音，否则并回去 */
      if (pend.length >= 3) {
        cur.end = pendStart - 1;
        if (cur.end >= cur.start) notes.push(cur);
        var tail = { start: pendStart, sum: 0, n: 0, end: voiced.length - 1 };
        pend.forEach(function (x) { tail.sum += x; tail.n += 1; });
        notes.push(tail);
        cur = null;
      } else {
        pend.forEach(function (x) { cur.sum += x; cur.n += 1; });
        cur.end = voiced.length - 1;
        pend = [];
      }
    }
    closeCur();

    var fr = HOP / SR;
    var out = [];
    for (i = 0; i < notes.length; i++) {
      var n0 = notes[i];
      var b = (n0.start * fr) / C.SPB;
      var dur = ((n0.end - n0.start + 1) * fr) / C.SPB;
      /* 最短音从 0.11 拍提到 0.25 拍：比十六分还短的碎片基本都是滑音/噪声，
         留着只会把整句拆成一串「半音乱跳」，量化后还会被强行拉成 0.25 拍 */
      if (dur < 0.25) continue;
      /* 量化网格用十六分音符（0.25 拍）。原来用 0.5 拍，短于 312ms 的音会两两
         落进同一格，被后面的去重合并掉——听起来就是「短音识别不出来」。 */
      var qb = Math.round(b * 4) / 4;
      /* 上限原来是 2 拍，哼长音会被硬砍成两拍；一小节 4 拍，放到 4 才装得下 */
      var qd = U.clamp(Math.round(dur * 4) / 4, 0.25, 4);
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

    /* 时值不能盖到下一个音头上：b 与 d 各自量化后很容易互相叠住，
       叠住的那几拍会同时响两个音，听起来就是「和弦糊了 / 音不准」 */
    for (i = 0; i < merged.length - 1; i++) {
      var room = merged[i + 1].b - merged[i].b;
      if (merged[i].d > room) merged[i].d = Math.max(0.25, Math.floor(room * 4) / 4);
    }
    return merged.slice(0, 64);
  }

  L.ANALYZE = {
    run: run, downsample: downsample,
    /* 音符化单独暴露一份：离线测试可以直接喂帧数据，不用合成音频 */
    notesOf: toNotes,
    stats: function () { return lastStats; }
  };
})();
