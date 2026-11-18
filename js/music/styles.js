/* ============================================================
 * music/styles.js — 氛围 × 风格：随机旋律「差异」的来源
 * 氛围（明暗冷暖）定音阶色彩与走向，风格（编曲出处）定速度区间、
 * 常用和弦走向、节奏型与配器倾向。两层各取一份，合成一个 plan，
 * 生成器只认 plan，不再在算法里堆 if。
 * 暴露：LALA.STYLE
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var U = L.util;

  /* ---------- 氛围：决定明暗与轮廓 ---------- */
  /* scale 用 compose 里的音阶名；keyBias 是主音（半音），小调五声以 A 为 0 基准 */
  var VIBES = [
    {
      id: 'heal', name: '治愈', scale: 'majorPenta', contour: 'wave', keyBias: 0,
      feelDelta: { energy: -0.08, density: -0.04, sync: -0.04, space: 0.12 }
    },
    {
      id: 'blue', name: '忧郁', scale: 'minorPenta', contour: 'down', keyBias: 9,
      feelDelta: { energy: -0.26, density: -0.14, sync: -0.10, space: 0.24 }
    },
    {
      id: 'wild', name: '躁动', scale: 'major', contour: 'motif', keyBias: 0,
      feelDelta: { energy: 0.34, density: 0.30, sync: 0.16, space: -0.26 }
    },
    {
      id: 'airy', name: '空灵', scale: 'minorPenta', contour: 'arch', keyBias: 2,
      feelDelta: { energy: -0.20, density: -0.08, sync: 0.10, space: 0.30 }
    }
  ];

  /* ---------- 节奏型：一行参数就够，别写成 if 树 ---------- */
  var RHYTHM_FEEL = {
    straight: {},
    lazy: { density: -0.16, sync: -0.06, space: 0.12 },
    swing: { density: 0.04, sync: 0.18 },
    driving: { density: 0.16, sync: 0.06, space: -0.08 },
    four: { density: 0.20, sync: 0.10, space: -0.06 },
    halfTime: { density: -0.20, sync: 0.10, space: 0.14 }
  };

  /* ---------- 风格：常见编曲的底色 ---------- */
  /* bpm 是区间，一批三段会在区间里摊开成慢 / 中 / 快；
     pools 是这套编曲最常用的走向（音阶级数，0 起）；
     mood 指向现有 8 个曲调之一，用户后面自己加乐器时默认沿用它 */
  var STYLES = [
    {
      id: 'folk', name: '民谣', bpm: [86, 104], rhythm: 'straight', mood: '晴天',
      pools: {
        major: [[0, 4, 5, 3], [0, 3, 4, 0], [0, 5, 3, 4], [0, 3, 0, 4]],
        minor: [[0, 5, 2, 6], [0, 3, 4, 0]]
      },
      timbreHint: { drums: 'hand', bass: 'finger', chord: 'guitar' }
    },
    {
      id: 'lofi', name: 'Lo-fi', bpm: [68, 84], rhythm: 'lazy', mood: '深夜',
      pools: {
        major: [[0, 3, 5, 4], [5, 3, 0, 4], [0, 5, 3, 4]],
        minor: [[0, 5, 2, 6], [0, 6, 5, 4], [0, 5, 3, 4]]
      },
      timbreHint: { drums: 'hand', bass: 'upright', chord: 'ep' }
    },
    {
      id: 'rock', name: '摇滚', bpm: [112, 132], rhythm: 'driving', mood: '热血',
      pools: {
        major: [[0, 4, 5, 3], [0, 3, 4, 0], [0, 5, 5, 3], [0, 3, 0, 4]],
        minor: [[0, 5, 2, 6], [0, 3, 4, 0], [0, 6, 5, 4]]
      },
      timbreHint: { drums: 'acoustic', bass: 'pick', chord: 'eguitar' }
    },
    {
      id: 'electro', name: '电子', bpm: [122, 138], rhythm: 'four', mood: '派对',
      pools: {
        major: [[5, 3, 0, 4], [0, 5, 3, 4], [5, 3, 4, 0]],
        minor: [[5, 2, 0, 6], [0, 5, 2, 6], [5, 3, 0, 4]]
      },
      timbreHint: { drums: 'electro', bass: 'synth', chord: 'ep' }
    },
    {
      id: 'jazz', name: '爵士', bpm: [96, 118], rhythm: 'swing', mood: '复古',
      pools: {
        major: [[1, 4, 0, 5], [1, 4, 0, 0], [0, 1, 4, 0]],
        minor: [[1, 4, 0, 0], [0, 5, 2, 6], [1, 4, 0, 5]]
      },
      timbreHint: { drums: 'acoustic', bass: 'upright', chord: 'piano' }
    },
    {
      id: 'guofeng', name: '国风', bpm: [74, 92], rhythm: 'straight', mood: '清晨',
      pools: {
        major: [[0, 3, 4, 0], [0, 1, 4, 0], [0, 4, 0, 3]],
        minor: [[0, 3, 4, 0], [0, 5, 4, 0]]
      },
      timbreHint: { drums: 'hand', bass: 'upright', chord: 'guzheng' }
    },
    {
      id: 'party', name: '派对', bpm: [118, 134], rhythm: 'four', mood: '热血',
      pools: {
        major: [[0, 5, 3, 4], [5, 3, 0, 4], [0, 4, 5, 3]],
        minor: [[0, 5, 2, 6], [5, 2, 0, 6], [0, 3, 4, 0]]
      },
      timbreHint: { drums: 'electro', bass: 'pick', chord: 'eguitar' }
    },
    {
      id: 'hiphop', name: '说唱', bpm: [82, 96], rhythm: 'halfTime', mood: '下雨',
      pools: {
        major: [[0, 3, 5, 4], [0, 0, 3, 4], [5, 3, 0, 4]],
        minor: [[0, 0, 5, 6], [0, 5, 2, 6], [0, 2, 5, 4]]
      },
      timbreHint: { drums: 'electro', bass: 'synth', chord: 'ep' }
    }
  ];

  /* 氛围 → 这件乐器能用的曲调（就是 GROOVE 那 8 个心情）。
     重叠是有意的：氛围只是粗筛，同一个曲调换个种子是另一条律动 */
  var VIBE_MOODS = {
    heal: ['晴天', '温柔'],
    blue: ['深夜', '下雨'],
    wild: ['热血', '派对'],
    airy: ['清晨', '温柔']
  };

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function vibe(id) { return findById(VIBES, id); }
  function style(id) { return findById(STYLES, id); }

  function clampFeel(v) { return U.clamp(v, 0.06, 1); }

  /* 一批三段的 BPM 要摊开，不然三张卡听起来速度一样。
     slot/count 缺省时取区间中点，r 只做小幅抖动 */
  function bpmOf(range, opts) {
    var lo = range[0], hi = range[1];
    var r = opts && opts.r;
    var jitter = r ? (r() - 0.5) * 3 : 0;
    var slot = opts ? opts.slot : null;
    var count = opts ? opts.count : 0;
    var center = (slot === null || slot === undefined || !count)
      ? (lo + hi) / 2
      : lo + (hi - lo) * (0.2 + (slot / (count - 1)) * 0.6);
    return Math.round(U.clamp(center + jitter, lo, hi));
  }

  /* 氛围 × 风格 → 生成器用的一份 plan。
     opts.r 只影响 BPM 抖动，缺省即确定性结果（方便测试） */
  function planFor(vibeId, styleId, opts) {
    var v = vibe(vibeId) || VIBES[0];
    var s = style(styleId) || STYLES[0];
    var base = L.GROOVE.feel(s.mood);
    var d = v.feelDelta || {};
    var rd = RHYTHM_FEEL[s.rhythm] || {};
    var minor = v.scale === 'minorPenta';
    var pools = s.pools && (minor ? s.pools.minor : s.pools.major);

    return {
      vibe: v.name, vibeId: v.id,
      style: s.name, styleId: s.id,
      scale: v.scale, contour: v.contour,
      feels: {
        energy: clampFeel(base.energy + (d.energy || 0) + (rd.energy || 0)),
        density: clampFeel(base.density + (d.density || 0) + (rd.density || 0)),
        sync: clampFeel(base.sync + (d.sync || 0) + (rd.sync || 0)),
        space: clampFeel(base.space + (d.space || 0) + (rd.space || 0))
      },
      bpm: bpmOf(s.bpm, opts),
      pools: pools && pools.length ? pools : null,
      mood: s.mood,
      rhythm: s.rhythm,
      timbreHint: s.timbreHint || null,
      tonic: v.keyBias,
      mode: minor ? 'minor' : 'major',
      /* 生成器按 A 小调 / C 大调起音，这里补一个移调量把主音搬过去 */
      transpose: minor ? ((v.keyBias - 9) % 12 + 12) % 12 : v.keyBias
    };
  }

  /* 配器倾向的一行文案，乐队面板拿它当提示 */
  function timbreText(hint) {
    if (!hint) return '';
    return ['drums', 'bass', 'chord'].map(function (k) {
      return L.TIMBRE.nameOf(k, hint[k]) || '';
    }).filter(Boolean).join(' · ');
  }

  /* 这个氛围下能抽的曲调；'' / 未知 id 返回空数组，调用方回落到全队曲调 */
  function moodsOfVibe(id) {
    return (VIBE_MOODS[id] || []).slice();
  }

  /* 按氛围随机抽一个曲调；没指定氛围或抽不到时交给 fallback */
  function rollMood(id, fallback) {
    var list = moodsOfVibe(id);
    if (!list.length) return fallback || '晴天';
    return list[Math.floor(Math.random() * list.length)];
  }

  L.STYLE = {
    vibes: VIBES,
    styles: STYLES,
    rhythmFeel: RHYTHM_FEEL,
    vibeMoods: VIBE_MOODS,
    planFor: planFor,
    vibe: vibe,
    style: style,
    moodsOfVibe: moodsOfVibe,
    rollMood: rollMood,
    timbreText: timbreText
  };
})();
