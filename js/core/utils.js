/* ============================================================
 * core/utils.js — 基础工具与全局常量
 * 暴露：LALA.util / LALA.C
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA = window.LALA || {};
  var B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function b36(n) { return B36[clamp(n | 0, 0, 35)]; }
  function unb36(c) { return B36.indexOf(c); }
  function pad2(s) { return s.length < 2 ? '0' + s : s; }
  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function hzMidi(f) { return Math.round(69 + 12 * Math.log2(f / 440)); }
  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }

  var BPM = 96;
  var LOOP_BEATS = 16;      /* 伴奏循环 4 小节 */
  var MIN_CLIP = 0.5;       /* 一段最少半拍 */
  var MAX_CLIPS = 8;        /* 每件最多几段，和 codec 的段数上限对齐 */

  /* 片段区间归一化：按起点排序、半拍对齐、夹进 0~16、每段最短半拍、互不重叠。
     返回新数组，不动传进来的对象 —— 编排、播放、分享都只认这份结果 */
  function normClips(list) {
    var raw = [];
    (list || []).forEach(function (c) {
      if (!c) return;
      var from = (typeof c.from === 'number') ? c.from : 0;
      var to = (typeof c.to === 'number') ? c.to : LOOP_BEATS;
      from = clamp(Math.round(from * 2) / 2, 0, LOOP_BEATS);
      to = clamp(Math.round(to * 2) / 2, 0, LOOP_BEATS);
      if (to - from < MIN_CLIP - 1e-6) return;
      /* 片段静音是本地试听开关，跟着这一段走；不进分享码 */
      var one = { from: from, to: to };
      if (c.mute) one.mute = 1;
      /* lead 片段会带自己的音符（b 相对 from）；归一化区间后要按新区间重新切片 */
      if (c.notes && c.notes.length) {
        var abs = c.notes.map(function (n) { return { b: c.from + n.b, d: n.d, m: n.m }; });
        var ns = sliceNotes(abs, from, to);
        if (ns.length) one.notes = ns;
      }
      raw.push(one);
    });
    raw.sort(function (a, b) { return a.from - b.from || a.to - b.to; });

    var out = [];
    raw.forEach(function (c) {
      var last = out[out.length - 1];
      if (last && c.from < last.to - 1e-6) {
        /* 后一段被前一段盖住就丢掉；只压掉重叠的那一截，宁短不叠 */
        if (c.to <= last.to + 1e-6) return;
        var cut = { from: last.to, to: c.to };
        if (c.mute) cut.mute = 1;
        if (c.notes && c.notes.length) {
          var abs2 = c.notes.map(function (n) { return { b: c.from + n.b, d: n.d, m: n.m }; });
          var ns2 = sliceNotes(abs2, last.to, c.to);
          if (ns2.length) cut.notes = ns2;
        }
        c = cut;
        if (c.to - c.from < MIN_CLIP - 1e-6) return;
      }
      out.push(c);
    });
    return out;
  }

  /* 每件乐器的片段区间（拍），返回 [{from,to}]，缺省 = 整段。
     唯一取值口径：clips 优先；老数据把 from / to 折成一段；都没有就是整段 */
  function bandClips(it) {
    if (!it) return [{ from: 0, to: LOOP_BEATS }];
    if (it.clips && it.clips.length) {
      var list = normClips(it.clips);
      if (list.length) return list;
    }
    if (typeof it.from === 'number' || typeof it.to === 'number') {
      var one = normClips([{ from: it.from, to: it.to }]);
      if (one.length) return one;
    }
    return [{ from: 0, to: LOOP_BEATS }];
  }

  /* 写回：归一化后存成 clips；整段时把 clips / from / to 一起清掉，
     老数据的形状（没有区间字段 = 整段）保持一致。
     带静音标记的段不能折叠成「没有字段」，否则静音会丢 */
  function writeClips(it, list) {
    if (!it) return;
    var norm = normClips(list);
    delete it.clips;
    delete it.from;
    delete it.to;
    if (!norm.length) return;
    /* 整段折叠会丢掉字段：带音符的整段 lead 片段不能折，否则旋律内容就没了 */
    var plain = norm.length === 1 && isFullWindow(norm[0]) && !norm[0].mute
      && !(norm[0].notes && norm[0].notes.length);
    if (plain) return;
    it.clips = norm;
  }

  /* 片段级静音：只影响本机播放，不进分享码（和整轨静音一个口径） */
  function clipsAudible(list) {
    return (list || []).filter(function (c) { return !c.mute; });
  }

  /* 兼容老调用：只取第一段。新逻辑请用 bandClips */
  function bandWindow(it) {
    var first = bandClips(it)[0];
    return { from: first.from, to: first.to };
  }

  function isFullWindow(w) {
    return w.from <= 0 && w.to >= LOOP_BEATS;
  }

  /* 每件自己的律动倍率：0.5 = 慢一半、2 = 快一倍，其它值一律当 1。
     这是「这一层」的疏密，不动整首 BPM */
  function bandRate(it) {
    var r = it && it.rate;
    return (r === 0.5 || r === 2) ? r : 1;
  }

  /* 每拍多少秒：song.bpm 缺省回落 96，录音链路统一用 C.SPB */
  function spbOf(song) {
    var bpm = (song && song.bpm) || BPM;
    return 60 / bpm;
  }

  /* ===== 主旋律（lead）片段音符：让旋律跟着片段走 =====
     lead 片段可以带 notes（音符 b 相对片段 from），移动 / 切割 / 裁剪片段时音符一起搬；
     没物化的老数据仍用 song.notes 全局乐句 + 窗口过滤。 */

  /* 从绝对拍位音符里切出 [from,to) 内的音符，重新相对到 from */
  function sliceNotes(absNotes, from, to) {
    var out = [];
    (absNotes || []).forEach(function (n) {
      if (!n) return;
      if (n.b < from - 1e-6 || n.b >= to - 1e-6) return;
      var d = Math.min(n.d, to - n.b);
      if (d < 1e-6) return;
      out.push({ b: n.b - from, d: d, m: n.m });
    });
    return out;
  }

  /* band 里所有 k==='lead' 的轨道 */
  function leadItems(song) {
    var band = song && song.band;
    var out = [];
    if (!band) return out;
    for (var i = 0; i < band.length; i++) {
      if (band[i] && band[i].k === 'lead') out.push(band[i]);
    }
    return out;
  }

  /* lead 片段是否已经物化出自己的音符 */
  function leadHasNotes(song) {
    var items = leadItems(song);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.clips) continue;
      for (var j = 0; j < it.clips.length; j++) {
        if (it.clips[j].notes && it.clips[j].notes.length) return true;
      }
    }
    return false;
  }

  /* 实际旋律音符的扁平视图（绝对拍位，返回新数组）。
     有 per-clip notes 时按片段摊平；否则回落 song.notes（8 拍乐句） */
  function leadNotes(song) {
    var out;
    if (leadHasNotes(song)) {
      out = [];
      leadItems(song).forEach(function (it) {
        bandClips(it).forEach(function (c) {
          (c.notes || []).forEach(function (n) {
            out.push({ b: c.from + n.b, d: n.d, m: n.m });
          });
        });
      });
    } else {
      out = ((song && song.notes) || []).map(function (n) {
        return { b: n.b, d: n.d, m: n.m };
      });
    }
    /* 保证按拍位升序：codec 的增量编码要求单调，简谱 / 海报画线也依赖顺序 */
    out.sort(function (a, b) { return a.b - b.b || a.m - b.m; });
    return out;
  }

  /* 原地修改旋律音符（移调用）：命中 per-clip notes 时改片段音符，否则改 song.notes */
  function mapLeadNotes(song, fn) {
    if (leadHasNotes(song)) {
      leadItems(song).forEach(function (it) {
        (it.clips || []).forEach(function (c) {
          (c.notes || []).forEach(fn);
        });
      });
      return;
    }
    (song.notes || []).forEach(fn);
  }

  /* 把 8 拍乐句展开成 16 拍（8~16 拍重复一遍），再按现有片段区间切进各 lead 片段的 notes。
     只有还没物化的 lead 轨才做；物化过的保持原样 */
  function materializeLead(song) {
    leadItems(song).forEach(function (it) {
      var has = false;
      if (it.clips) {
        for (var j = 0; j < it.clips.length; j++) {
          if (it.clips[j].notes && it.clips[j].notes.length) { has = true; break; }
        }
      }
      if (has) return;
      var src = song.notes || [];
      var leadEnd = 0;
      src.forEach(function (n) { leadEnd = Math.max(leadEnd, n.b + n.d); });
      var repeat = leadEnd <= L.C.BEATS + 1e-6;
      var full = [];
      /* 先原句再重复句，保持拍位升序（增量编码与画线都依赖顺序） */
      src.forEach(function (n) { full.push({ b: n.b, d: n.d, m: n.m }); });
      if (repeat) src.forEach(function (n) { full.push({ b: n.b + L.C.BEATS, d: n.d, m: n.m }); });
      var clips = bandClips(it);
      var next = clips.map(function (c) {
        var o = { from: c.from, to: c.to };
        if (c.mute) o.mute = 1;
        var ns = sliceNotes(full, c.from, c.to);
        if (ns.length) o.notes = ns;
        return o;
      });
      writeClips(it, next);
    });
  }

  L.util = {
    $: $, $$: $$, clamp: clamp, sleep: sleep,
    b36: b36, unb36: unb36, pad2: pad2,
    midiHz: midiHz, hzMidi: hzMidi, median: median,
    spbOf: spbOf,
    LOOP_BEATS: LOOP_BEATS, MIN_CLIP: MIN_CLIP, MAX_CLIPS: MAX_CLIPS,
    normClips: normClips, bandClips: bandClips, writeClips: writeClips,
    clipsAudible: clipsAudible,
    bandWindow: bandWindow, isFullWindow: isFullWindow, bandRate: bandRate,
    sliceNotes: sliceNotes,
    leadItems: leadItems, leadHasNotes: leadHasNotes, leadNotes: leadNotes,
    mapLeadNotes: mapLeadNotes, materializeLead: materializeLead
  };

  L.C = {
    BPM: BPM,
    SPB: 60 / BPM,
    BEATS: 8,
    MAJ: [0, 2, 4, 5, 7, 9, 11],
    MIN: [0, 2, 3, 5, 7, 8, 10],
    PCN: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
    PCN_CN: ['C', '♯C', 'D', '♯D', 'E', 'F', '♯F', 'G', '♯G', 'A', '♯A', 'B']
  };
})();
