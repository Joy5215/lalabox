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

  L.util = {
    $: $, $$: $$, clamp: clamp, sleep: sleep,
    b36: b36, unb36: unb36, pad2: pad2,
    midiHz: midiHz, hzMidi: hzMidi, median: median
  };

  L.C = {
    BPM: BPM,
    SPB: 60 / BPM,
    BEATS: 8,
    MAJ: [0, 2, 4, 5, 7, 9, 11],
    MIN: [0, 2, 3, 5, 7, 8, 10],
    STYLE_ORDER: ['pop', 'edm', 'lofi', 'rock'],
    STYLE_LABEL: { pop: '流行', edm: '电子', lofi: 'Lo-fi', rock: '摇滚' },
    PCN: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
    PCN_CN: ['C', '♯C', 'D', '♯D', 'E', 'F', '♯F', 'G', '♯G', 'A', '♯A', 'B']
  };
})();
