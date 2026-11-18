/* ============================================================
 * music/groove.js — 现场生成每一层的「怎么弹」
 * 不是从几套模板里挑，而是拿「情绪 + 种子」现算：
 *   情绪决定手感参数（力度 / 密度 / 切分 / 留白）
 *   种子决定这一版具体落在哪些拍上
 * 同一个情绪每次换种子就是新的一版，但都还在这个情绪的范围里。
 * 事件：{ t 轨道, b 拍位置(0~16), d 时值(拍), v 力度, n 音级 }
 *   n：贝斯 root/fifth/oct，和音 0/1/2 = 和弦内第几个音，不写 = 整个和弦
 * 暴露：LALA.GROOVE
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;

  /* 情绪 → 手感参数，几个数字就把「温柔」和「热血」区分开了 */
  var FEEL = {
    '晴天': { energy: 0.60, density: 0.55, sync: 0.35, space: 0.35 },
    '深夜': { energy: 0.25, density: 0.30, sync: 0.25, space: 0.70 },
    '温柔': { energy: 0.35, density: 0.35, sync: 0.30, space: 0.60 },
    '下雨': { energy: 0.30, density: 0.30, sync: 0.20, space: 0.70 },
    '热血': { energy: 0.95, density: 0.85, sync: 0.50, space: 0.10 },
    '复古': { energy: 0.60, density: 0.50, sync: 0.60, space: 0.30 },
    '派对': { energy: 0.90, density: 0.80, sync: 0.45, space: 0.15 },
    '清晨': { energy: 0.45, density: 0.45, sync: 0.30, space: 0.55 }
  };
  var DEFAULT_FEEL = { energy: 0.5, density: 0.5, sync: 0.35, space: 0.4 };

  var SEED_MAX = 1679615;   /* 36^4 - 1，正好塞进 4 位 base36 */

  function feelOf(name) { return FEEL[name] || DEFAULT_FEEL; }

  /* 线性同余，够随机也够稳定：同一个种子一定长出同一版 */
  function rngOf(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s >>> 8) / 16777216;
    };
  }

  function chance(r, p) { return r() < p; }
  function newSeed() { return 1 + Math.floor(Math.random() * SEED_MAX); }

  /* 种子不只挑「哪些拍落在哪」，还决定这一版的性格：
     style 换节奏型，inv / oct 换和弦的转位与音区（arrange 用）。
     没有这两样，连按「换一版」只会得到同一个律动的微调。 */
  function variant(seed) {
    var s = seed > 0 ? Math.floor(seed) : 1;
    return {
      style: Math.floor(s / 3) % 3,
      inv: s % 3,
      oct: (Math.floor(s / 9) % 2) ? 12 : 0
    };
  }

  /* 旧数据 / 缺字段时的兜底，固定值保证编曲结果可重复 */
  function seedDefaults() { return { drums: 101, bass: 202, chord: 303 }; }
  function feelDefaults() { return { drums: '晴天', bass: '晴天', chord: '晴天' }; }

  function shuffle(r, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 鼓 ---------- */
  function drums(seed, mood) {
    var f = feelOf(mood);
    var style = variant(seed).style;   /* 0 标准 1 密 2 半速 */
    var ev = [];

    for (var bar = 0; bar < 4; bar++) {
      var r = rngOf(seed + bar * 131);
      var o = bar * 4;
      var add = function (t, b, v, d) {
        ev.push({ t: t, b: o + b, d: d || 0.2, v: v });
      };

      /* 底鼓：第一拍钉死，第三拍看力度，其余位置按切分倾向掷骰子 */
      add('kick', 0, 0.96 + r() * 0.04, 0.3);
      if (chance(r, 0.32 + f.energy * 0.5)) add('kick', 2, 0.8 + r() * 0.14, 0.3);
      if (chance(r, f.sync * 0.9)) add('kick', 1.5, 0.56 + r() * 0.18, 0.25);
      if (chance(r, f.sync * 0.75)) add('kick', 2.75, 0.5 + r() * 0.2, 0.22);
      if (chance(r, f.sync * 0.3)) add('kick', 3.5, 0.44 + r() * 0.16, 0.22);

      /* 军鼓：半速那一版只落第三拍，其余仍是二四拍为主 */
      if (style === 2) {
        add('snare', 2, 0.78 + r() * 0.14, 0.34);
        if (chance(r, 0.3 + f.energy * 0.3)) add('snare', 3.5, 0.4 + r() * 0.14, 0.2);
      } else {
        add('snare', 1, 0.72 + r() * 0.16, 0.3);
        if (chance(r, 0.72 + f.energy * 0.28)) add('snare', 3, 0.72 + r() * 0.16, 0.3);
        if (f.energy > 0.65 && chance(r, 0.32)) add('snare', 3.25, 0.36 + r() * 0.12, 0.18);
        if (f.energy > 0.7 && chance(r, 0.3)) add('snare', 3.75, 0.4 + r() * 0.14, 0.18);
      }

      /* 拍手只在很热闹的情绪里出现 */
      if (f.energy > 0.78 && chance(r, 0.55)) {
        add('clap', chance(r, 0.5) ? 1 : 3, 0.76 + r() * 0.12, 0.2);
      }

      /* 踩镲：密度决定八分还是十六分，留白决定漏掉多少；
         style=1 这一版更密，style=2 把十六分收回八分 */
      var step = f.density > 0.7 ? 0.25 : (f.density > 0.42 ? 0.5 : 1);
      if (style === 1 && f.density > 0.42) step = 0.25;
      if (style === 2) step = Math.max(0.5, step);
      for (var b = 0; b < 4; b += step) {
        if (chance(r, 0.94 - f.space * 0.45)) add('hat', b, 0.2 + r() * 0.24, 0.07);
      }
      if (chance(r, 0.3 + f.energy * 0.35)) add('openhat', 3.5, 0.32 + r() * 0.2, 0.2);

      /* 第四小节偶尔来个 fill */
      if (bar === 3 && f.energy > 0.4 && chance(r, 0.5)) {
        add('snare', 3.5, 0.48 + r() * 0.1, 0.16);
        add('snare', 3.75, 0.54 + r() * 0.1, 0.16);
      }
    }

    return ev;
  }

  /* ---------- 贝斯 ---------- */
  function bass(seed, mood) {
    var f = feelOf(mood);
    var style = variant(seed).style;   /* 0 根音 1 走句 2 长音 */
    var ev = [];

    for (var bar = 0; bar < 4; bar++) {
      var r = rngOf(seed + bar * 197);
      var o = bar * 4;
      var step = f.density > 0.68 ? 0.5 : (f.density > 0.42 ? 1 : 2);
      if (style === 1) step = Math.min(step, 0.5);
      if (style === 2) step = Math.max(step, 2);
      var used = {};
      var count = 0;

      for (var b = 0; b < 4; b += step) {
        if (b > 0 && chance(r, f.space * 0.4)) continue;

        var q = r();
        /* 走句那一版五度/八度更多，根音那一版几乎只踩根音 */
        var n = style === 1
          ? (q < 0.34 ? 'fifth' : (q < 0.5 ? 'oct' : 'root'))
          : (q < 0.14 ? 'fifth' : (q < 0.2 ? 'oct' : 'root'));
        var d = step > 1 ? step * 0.95 : step * 0.85;

        ev.push({
          t: 'bass', b: o + b, d: d * (0.85 + r() * 0.3),
          v: 0.74 + r() * 0.22, n: n
        });
        used[b] = true;
        count++;
      }

      /* 整小节都留白了就补一个根音，别真的空掉 */
      if (!count) {
        ev.push({ t: 'bass', b: o, d: 1.6, v: 0.9, n: 'root' });
        used[0] = true;
      }

      /* 句尾补一个五度，收得住一点 */
      if (!used[3.5] && chance(r, 0.4)) {
        ev.push({ t: 'bass', b: o + 3.5, d: 0.3, v: 0.6 + r() * 0.16, n: 'fifth' });
      }
    }

    return ev;
  }

  /* ---------- 和音 ---------- */
  function chord(seed, mood) {
    var f = feelOf(mood);
    var style = variant(seed).style;   /* 0 铺底 1 柱式 2 分解 */
    var ev = [];

    for (var bar = 0; bar < 4; bar++) {
      var r = rngOf(seed + bar * 613);
      var o = bar * 4;
      var barEv = [];
      /* 多数小节走这一版的性格，少数小节随机换个花样 */
      var kind = chance(r, 0.72) ? style : Math.floor(r() * 3);

      if (kind === 0) {
        /* 铺：长和弦打底，后半小节补一小块 */
        barEv.push({ t: 'chord', b: o, d: 2.2 + r() * 1.4, v: 0.76 + r() * 0.14 });
        if (chance(r, 0.35 + f.space * 0.4)) {
          barEv.push({ t: 'chord', b: o + 2.5, d: 1.2, v: 0.64 + r() * 0.12 });
        }
      } else if (kind === 1) {
        /* 柱式切分：强拍更容易落，弱拍靠力度决定 */
        [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].forEach(function (b) {
          var p = (b % 1 === 0 ? 0.5 : 0.26) * (0.6 + f.energy);
          if (chance(r, p)) {
            barEv.push({ t: 'chord', b: o + b, d: 0.3 + r() * 0.32, v: 0.64 + r() * 0.22 });
          }
        });
      } else {
        /* 分解：按密度选格距，和弦内音随机走 */
        var step = f.density > 0.6 ? 0.5 : 1;
        var order = shuffle(r, [0, 1, 2]);
        var idx = 0;
        for (var b = 0; b < 4; b += step) {
          barEv.push({
            t: 'chord', b: o + b, d: step * (0.7 + r() * 0.35),
            v: 0.56 + r() * 0.22, n: order[idx % 3]
          });
          idx++;
          if (chance(r, 0.15)) idx++;    /* 偶尔跳一个音，别太机械 */
        }
      }

      if (!barEv.length) {
        barEv.push({ t: 'chord', b: o, d: 3.4, v: 0.7 });
      }

      for (var i = 0; i < barEv.length; i++) ev.push(barEv[i]);
    }

    return ev;
  }

  L.GROOVE = {
    feels: FEEL, feel: feelOf, seedMax: SEED_MAX,
    newSeed: newSeed, seedDefaults: seedDefaults, feelDefaults: feelDefaults,
    variant: variant, rngOf: rngOf,
    drums: drums, bass: bass, chord: chord
  };
})();
