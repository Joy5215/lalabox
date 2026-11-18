/* ============================================================
 * music/compose.js — 调式识别 / 音阶吸附 / 和弦进行选优 / 成曲
 * 暴露：LALA.COMPOSE
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var C = L.C;

  var MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  /* 调外音每拍扣的分。只按音级轮廓打分时，一个长音就能把调吸过去，
     选出个「调里没有这个音」的调，伴奏立刻和哼唱打架；扣到这个量级
     （约等于轮廓里一个次要音级的权重）之后，零调外音的调才会赢 */
  var OUT_PENALTY = 3;

  function bestKey(hist) {
    var best = { score: -1e9, tonic: 9, mode: 'minor' };
    for (var t = 0; t < 12; t++) {
      for (var mi = 0; mi < 2; mi++) {
        var prof = mi === 0 ? MAJOR_PROFILE : MINOR_PROFILE;
        var sc = mi === 0 ? C.MAJ : C.MIN;
        var s = 0;
        for (var pc = 0; pc < 12; pc++) {
          var w = hist[(pc + t) % 12];
          /* 这里的 pc 已经是相对主音的音级 */
          s += w * (sc.indexOf(pc) < 0 ? prof[pc] - OUT_PENALTY : prof[pc]);
        }
        if (s > best.score) {
          best = { score: s, tonic: t, mode: mi === 0 ? 'major' : 'minor' };
        }
      }
    }
    return best;
  }

  function nearestScale(rel, sc) {
    var bestD = rel, bd = 99;
    for (var i = 0; i < sc.length; i++) {
      var diff = Math.abs(rel - sc[i]);
      diff = Math.min(diff, 12 - diff);
      if (diff < bd) { bd = diff; bestD = sc[i]; }
    }
    return bestD;
  }

  function poolsOf(mode) {
    return mode === 'major'
      ? [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [3, 4, 2, 5], [0, 3, 4, 0]]
      : [[0, 5, 2, 6], [0, 3, 4, 0], [5, 2, 0, 6], [0, 6, 5, 4]];
  }

  function pcOf(prog, tonic, mode) {
    var sc = mode === 'major' ? C.MAJ : C.MIN;
    return prog.map(function (d) { return (tonic + sc[d % 7]) % 12; });
  }

  /* ---------- 常用和弦走向（示范用） ----------
     和 pools 同一套口径：4 个音阶级数、0 = 主和弦，随调式自动变大 / 小和弦。
     卡片上给的是级数标签（1-6-4-5），大调解成 C-Am-F-G，小调解成 Am-F-Dm-Em 这种 */
  var PROGS = [
    { id: 'p1645', lab: '1-6-4-5', hint: '华语流行最常用', deg: [0, 5, 3, 4] },
    { id: 'p1564', lab: '1-5-6-4', hint: '卡农式，很顺', deg: [0, 4, 5, 3] },
    { id: 'p6415', lab: '6-4-1-5', hint: '抒情、副歌感', deg: [5, 3, 0, 4] },
    { id: 'p4536', lab: '4-5-3-6', hint: '小调味，往前推', deg: [3, 4, 2, 5] },
    { id: 'p2516', lab: '2-5-1-6', hint: '爵士味一点', deg: [1, 4, 0, 5] },
    { id: 'p1451', lab: '1-4-5-1', hint: '明亮、回到主和弦', deg: [0, 3, 4, 0] }
  ];

  /* 给界面用：带上按当前调算好的 pitch class，方便直接写进 song.bars */
  function progressions(tonic, mode) {
    return PROGS.map(function (p) {
      return {
        id: p.id, lab: p.lab, hint: p.hint, deg: p.deg.slice(),
        bars: pcOf(p.deg, tonic, mode)
      };
    });
  }

  /* 这首歌现在用的是哪一条走向（对不上返回 ''） */
  function progOf(bars, tonic, mode) {
    if (!bars || bars.length !== 4) return '';
    var key = bars.join();
    var hit = '';
    PROGS.forEach(function (p) {
      if (pcOf(p.deg, tonic, mode).join() === key) hit = p.id;
    });
    return hit;
  }

  /* 一条走向给哼唱音符打分：和弦内音加分，调外音扣分 */
  function scorePool(prog, notes, tonic, mode, pri) {
    var sc = mode === 'major' ? C.MAJ : C.MIN;
    var score = pri * 0.15;
    for (var bar = 0; bar < 4; bar++) {
      var deg = prog[bar];
      var chordTones = [sc[deg % 7], sc[(deg + 2) % 7], sc[(deg + 4) % 7]];
      for (var ni = 0; ni < notes.length; ni++) {
        var nt = notes[ni];
        if (nt.b < bar * 4 || nt.b >= bar * 4 + 4) continue;
        var rel = ((nt.m - tonic) % 12 + 12) % 12;
        var w = Math.max(0.5, nt.d);
        if (chordTones.indexOf(rel) >= 0) score += 1.0 * w;
        else if (sc.indexOf(rel) >= 0) score += 0.3 * w;
        else score -= 0.35 * w;
      }
    }
    return score;
  }

  /* pools 可由调用方指定（风格表里的常用走向）；不给就退回内置的通用走向 */
  function chooseChords(notes, tonic, mode, pools) {
    if (!pools || !pools.length) pools = poolsOf(mode);
    var bestProg = pools[0], bestScore = -1e9;
    for (var pi = 0; pi < pools.length; pi++) {
      var score = scorePool(pools[pi], notes, tonic, mode, pools.length - pi);
      if (score > bestScore) { bestScore = score; bestProg = pools[pi]; }
    }
    return pcOf(bestProg, tonic, mode);
  }

  /* 「换一个」用的走向：在打分靠前的走向 × 四种起拍轮换里随机挑，
     并且强制第一个和弦和上一版不同 —— 开头音一样是最容易被听出来的重复 */
  function rollChords(notes, tonic, mode, prevBars) {
    var pools = poolsOf(mode);
    var cands = [];
    pools.forEach(function (p, pi) {
      var base = scorePool(p, notes, tonic, mode, pools.length - pi);
      for (var r = 0; r < 4; r++) {
        var rot = p.slice(r).concat(p.slice(0, r));
        cands.push({ pcs: pcOf(rot, tonic, mode), score: base - r * 0.45 });
      }
    });

    var prevFirst = prevBars && prevBars.length ? prevBars[0] : null;
    var prevKey = prevBars && prevBars.length ? prevBars.join() : '';
    var fresh = cands.filter(function (c) {
      if (prevFirst !== null && c.pcs[0] === prevFirst) return false;
      return c.pcs.join() !== prevKey;
    });
    var pool = fresh.length ? fresh : cands;
    pool.sort(function (a, b) { return b.score - a.score; });
    var top = pool.slice(0, Math.min(6, pool.length));
    return top[Math.floor(Math.random() * top.length)].pcs.slice();
  }

  function buildSong(rawNotes, opts) {
    opts = opts || {};
    var notes = rawNotes.map(function (n) { return { b: n.b, d: n.d, m: n.m }; });

    var minM = 99, maxM = 0;
    notes.forEach(function (n) {
      minM = Math.min(minM, n.m);
      maxM = Math.max(maxM, n.m);
    });
    /* 门槛从 G3 降到 A2：压嗓子哼的低音不再被整体抬一个八度，否则用户
       听到的旋律会比他哼的高一整段，低音区等于消失 */
    while (minM < 40) { notes.forEach(function (n) { n.m += 12; }); minM += 12; maxM += 12; }
    while (maxM > 82) { notes.forEach(function (n) { n.m -= 12; }); minM -= 12; maxM -= 12; }

    var hist = new Array(12).fill(0);
    notes.forEach(function (n) { hist[((n.m % 12) + 12) % 12] += n.d; });
    /* opts 带调性时直接用它：随机旋律按自己的音阶定调，
       不让识别器把「小调五声」听成别的大调再改音 */
    var key = (opts && opts.tonic !== undefined)
      ? { tonic: opts.tonic, mode: opts.mode === 'minor' ? 'minor' : 'major' }
      : bestKey(hist);
    var sc = key.mode === 'major' ? C.MAJ : C.MIN;

    /* 默认不改音：哼出来的音就是成曲的音。以前这里无条件把调外音吸到音阶上，
       哼一条带半音（布鲁斯、和声小调）的旋律会被改掉几个音，听感就是
       「重新编了一条」。真要强行归到调内，调用方显式传 opts.snap */
    if (opts.snap) {
      notes.forEach(function (n) {
        var pc = ((n.m % 12) + 12) % 12;
        var rel = ((pc - key.tonic) % 12 + 12) % 12;
        var target = nearestScale(rel, sc);
        if (target !== rel) {
          var delta = target - rel;
          if (delta > 6) delta -= 12;
          if (delta < -6) delta += 12;
          n.m += delta;
        }
      });
    }

    /* 风格给的曲调：用户后面自己加乐器时，默认就沿用它 */
    var moodName = opts.moodName || '';
    var mood = moodName
      ? { drums: moodName, bass: moodName, chord: moodName }
      : L.GROOVE.feelDefaults();

    /* 三层种子只给老数据回落用；乐器自己的种子在加入乐队时才生成 */
    return {
      v: 6, bpm: opts.bpm || C.BPM, tonic: key.tonic, mode: key.mode,
      mood: mood,
      style: opts.style || null,
      seeds: {
        drums: L.GROOVE.newSeed(),
        bass: L.GROOVE.newSeed(),
        chord: L.GROOVE.newSeed()
      },
      band: [],
      bars: chooseChords(notes, key.tonic, key.mode, opts.pools),
      notes: notes
    };
  }

  /* ---------- 不用麦克风：简谱输入 / 随机旋律 ---------- */
  /* 1-7 是 C 大调里的音级，0 是停顿。小白不用写时值：一个数字一拍。
     空格、逗号、竖线、斜杠都当分隔符，直接连着写「1235321」也认。 */
  var DEGREES = [0, 2, 4, 5, 7, 9, 11];
  var MAX_IN_BEATS = 16;

  function parseDegrees(text) {
    var s = String(text || '');
    var out = { notes: [], rests: 0, count: 0, bad: '', truncated: false };
    var beat = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '0') {
        out.rests++;
        if (beat < MAX_IN_BEATS) beat++;
        else out.truncated = true;
        continue;
      }
      if (ch >= '1' && ch <= '7') {
        if (beat >= MAX_IN_BEATS) { out.truncated = true; continue; }
        out.notes.push({
          b: beat, d: 1,
          m: 60 + DEGREES[ch.charCodeAt(0) - 49]
        });
        beat++;
        out.count++;
        continue;
      }
      if (' \t\r\n,，、|/·-~'.indexOf(ch) >= 0) continue;
      if (out.bad.indexOf(ch) < 0) out.bad += ch;
    }
    return out;
  }

  /* 随机旋律：三段不同「感觉」，点哪段试听哪段，确认后才进结果页。
     感觉直接沿用乐器曲调那 8 个心情：心情决定音阶（大调 / 小调五声）、
     走向（上行 / 下行 / 拱形 / 回环 / 动机反复）和节奏疏密，
     所以同一批三段不会长得一样，「换一批」也是全新一套 */
  var SCALES = {
    majorPenta: [0, 2, 4, 7, 9],        /* 1 2 3 5 6 */
    minorPenta: [-3, 0, 2, 4, 7],       /* 6 1 2 3 5 */
    major: [0, 2, 4, 5, 7, 9, 11]       /* 1-7 */
  };
  var DEGREE_OF = { '-3': 6, '0': 1, '2': 2, '4': 3, '5': 4, '7': 5, '9': 6, '11': 7 };

  var MOOD_PLAN = {
    '晴天': { scale: 'majorPenta', contour: 'arch' },
    '清晨': { scale: 'majorPenta', contour: 'up' },
    '温柔': { scale: 'majorPenta', contour: 'wave' },
    '深夜': { scale: 'minorPenta', contour: 'down' },
    '下雨': { scale: 'minorPenta', contour: 'wave' },
    '热血': { scale: 'major', contour: 'up' },
    '复古': { scale: 'majorPenta', contour: 'motif' },
    '派对': { scale: 'major', contour: 'motif' }
  };

  /* 心情的 density / sync / space 直接变节奏：密的走八分，疏的走二分；
     space 决定留白，sync 决定要不要把两格并成一个长音 */
  function rhythmFor(feel, r) {
    var step = feel.density > 0.7 ? 0.5 : (feel.density > 0.42 ? 1 : 2);
    var durs = [];
    var beat = 0;
    var guard = 0;

    while (beat < 8 - 1e-9 && guard++ < 40) {
      var left = 8 - beat;
      var d = Math.min(step, left);

      /* 留白：中间偶尔空掉一格；最后三拍别空，句子要收得住 */
      if (beat > 0 && left > 3 && r() < feel.space * 0.5) {
        beat += d;
        continue;
      }
      /* 连音：两格并成一个长音，切分感就是这么来的 */
      if (d * 2 <= left && r() < 0.18 + feel.sync * 0.35) d *= 2;
      /* 反过来，切分强的感觉也偶尔把一拍拆成半拍，别老是方方正正 */
      else if (d === 1 && r() < feel.sync * 0.45) d = 0.5;

      durs.push(d);
      beat += d;
    }
    return durs.length >= 3 ? durs : [1, 1, 1, 1, 1, 1, 1, 1];
  }

  /* 走向：top 是音阶下标的上限（含高八度主音），index 落在 0..top。
     下行 / 回环从高处起步，不然一上来就撞地板，听起来全是 1 2 3 */
  function startIndex(plan, top, r) {
    if (plan.contour === 'down') return Math.max(2, top - 1);
    if (plan.contour === 'wave') return r() < 0.5 ? 0 : 2;
    if (plan.contour === 'up') return r() < 0.5 ? 0 : 1;
    return 0;
  }

  /* 走向用现成的动机骨架，而不是纯随机游走：
     随机游走很容易在 0、1 两个音之间来回弹，听起来都一样 */
  var SHAPES = {
    up: [[0, 1, 2, 3], [0, 1, 2, 4], [0, 2, 3, 4], [0, 1, 3, 4]],
    down: [[3, 2, 1, 0], [4, 3, 2, 1], [4, 2, 1, 0], [3, 1, 0, 2]],
    arch: [[0, 2, 3, 1], [0, 1, 3, 2], [1, 3, 4, 2], [0, 2, 4, 1]],
    wave: [[0, 2, 1, 3], [2, 0, 3, 1], [1, 3, 2, 4], [0, 2, 3, 1]],
    motif: [[0, 1, 2, 1], [0, 2, 3, 2], [0, 2, 1, 0], [0, 3, 2, 1]]
  };

  function walkDegrees(plan, n, top, energy, r) {
    var pool = SHAPES[plan.contour] || SHAPES.up;
    var shape = pool[Math.floor(r() * pool.length)];
    var shift = plan.contour === 'down' ? -1 : 1;
    var want = plan.contour === 'down' ? Math.max(0, top - 4) : (r() < 0.55 ? 0 : 1);
    /* 起点别太靠上，否则后半段移调会顶到天花板，出现一串同音 */
    var room = top - Math.max.apply(null, shape) - Math.max(0, shift);
    var offset = L.util.clamp(want, 0, Math.max(0, room));
    var idx = [];
    var i, base;

    for (i = 0; i < n; i++) {
      base = shape[i % shape.length] + offset + shift * Math.floor(i / shape.length);
      idx.push(L.util.clamp(base, 0, top));
    }

    /* 后半段偶尔改一个音，避免「整句一模一样地平移」；
       改完别和前后撞成三个同音 */
    if (n > 4 && r() < 0.6) {
      var k = 2 + Math.floor(r() * (n - 3));
      var cand = L.util.clamp(idx[k] + (r() < 0.5 ? 1 : -1), 0, top);
      if (cand !== idx[k - 1] && cand !== idx[k + 1]) idx[k] = cand;
    }

    /* 收尾别从高处硬砸回主音：离得远就落到三音，也别连着三个同音 */
    if (n > 2) {
      var end = idx[n - 1] > 3 ? Math.min(2, top) : (r() < 0.6 ? 0 : Math.min(2, top));
      if (end === idx[n - 2] && end === idx[n - 3]) end = 0;
      idx[n - 1] = end;
    }
    return idx;
  }

  function notesFrom(idx, durs, scale) {
    var beat = 0, notes = [], degrees = [];
    for (var k = 0; k < durs.length; k++) {
      var oct = Math.floor(idx[k] / scale.length);
      var semis = scale[((idx[k] % scale.length) + scale.length) % scale.length];
      notes.push({ b: beat, d: durs[k], m: 60 + semis + oct * 12 });
      degrees.push(DEGREE_OF[String(semis)] || 1);
      beat += durs[k];
    }
    return { notes: notes, degrees: degrees };
  }

  /* seed 相同 → 同一批三段，方便测试与「换一批」复现 */
  function randomBatch(seed) {
    var base = seed || L.GROOVE.newSeed();
    var r = L.GROOVE.rngOf(base);

    function shuffle(arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(r() * (i + 1));
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }

    /* 一批里保证至少一段小调、两段大调：先挑感觉，再打乱顺序，
       这样三段的明暗、疏密、音区一定拉得开 */
    var minorPool = shuffle(['深夜', '下雨']);
    var majorPool = shuffle(['晴天', '清晨', '温柔', '热血', '复古', '派对']);
    var picks = shuffle([minorPool[0], majorPool[0], majorPool[1]]);

    var out = [];
    for (var k = 0; k < 3; k++) {
      var mood = picks[k];
      var plan = MOOD_PLAN[mood];
      var feel = L.GROOVE.feel(mood);
      var rr = L.GROOVE.rngOf(base + (k + 1) * 7919);
      var durs = rhythmFor(feel, rr);
      /* 太稀疏（只剩三四个音）没法定形，重抽两三次；还不行就退回一拍一音 */
      for (var tries = 0; tries < 3 && durs.length < 5; tries++) durs = rhythmFor(feel, rr);
      if (durs.length < 5) durs = [1, 1, 1, 1, 1, 1, 1, 1];

      var scale = SCALES[plan.scale];
      var idx = walkDegrees(plan, durs.length, scale.length, feel.energy, rr);
      var m = notesFrom(idx, durs, scale);
      /* 音阶自带调性：五声小调落在 A 小调，其余落在 C 大调 */
      out.push({
        mood: mood,
        notes: m.notes,
        degrees: m.degrees,
        tonic: plan.scale === 'minorPenta' ? 9 : 0,
        mode: plan.scale === 'minorPenta' ? 'minor' : 'major'
      });
    }
    return out;
  }

  /* ---------- 氛围 × 风格：一次给三段，且保证三段真的不一样 ---------- */
  var CONTOURS = ['up', 'down', 'arch', 'wave', 'motif'];
  var VIEWS = ['auto', 'half', 'long'];
  var VIEW_NAME = { auto: '自动', straight: '原拍', half: '半拍', long: '长音' };

  function histOf(notes) {
    var h = new Array(12).fill(0);
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      h[((n.m % 12) + 12) % 12] += n.d;
    }
    return h;
  }

  function cosine(a, b) {
    var dot = 0, la = 0, lb = 0;
    for (var i = 0; i < 12; i++) {
      dot += a[i] * b[i];
      la += a[i] * a[i];
      lb += b[i] * b[i];
    }
    if (!la || !lb) return 0;
    return dot / Math.sqrt(la * lb);
  }

  /* 差异闸门：同调同轮廓同速度、或者音高分布几乎重合，都算重复。
     两处都用同一把尺，一批三段之间、以及「换一版」都有据可依 */
  function distinctEnough(cand, list) {
    var hc = histOf(cand.notes);
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o.tonic === cand.tonic && o.mode === cand.mode
        && o.contour === cand.contour
        && Math.abs((o.bpm || C.BPM) - (cand.bpm || C.BPM)) < 8) return false;
      if (cosine(histOf(o.notes), hc) > 0.93) return false;
    }
    return true;
  }

  function shiftNotes(notes, delta) {
    if (!delta) return notes;
    for (var i = 0; i < notes.length; i++) notes[i].m += delta;
    return notes;
  }

  /* 一条 plan + 一个轮廓 → 一段候选。整条旋律只有 8 拍，重抽很快 */
  function melodyOf(plan, contour, r) {
    var feel = plan.feels;
    var durs = rhythmFor(feel, r);
    for (var t = 0; t < 3 && durs.length < 5; t++) durs = rhythmFor(feel, r);
    if (durs.length < 5) durs = [1, 1, 1, 1, 1, 1, 1, 1];

    var scale = SCALES[plan.scale] || SCALES.majorPenta;
    var idx = walkDegrees({ contour: contour }, durs.length, scale.length, feel.energy, r);
    var m = notesFrom(idx, durs, scale);
    shiftNotes(m.notes, plan.transpose);

    return {
      mood: plan.mood, vibe: plan.vibe, vibeId: plan.vibeId,
      style: plan.style, styleId: plan.styleId,
      contour: contour, bpm: plan.bpm,
      tonic: plan.tonic, mode: plan.mode,
      pools: plan.pools, timbreHint: plan.timbreHint,
      notes: m.notes, degrees: m.degrees
    };
  }

  function pickIds(items, want, r) {
    var ids = items.map(function (x) { return x.id; });
    for (var i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    }
    var out = [];
    for (var k = 0; k < want; k++) out.push(ids[k % ids.length]);
    return out;
  }

  /* opts = { vibe: 'heal'|'', style: 'folk'|'' }，空串 = 随机。
     风格随机时三段各挑不同风格 —— 这是「差异较大」最直接的来源 */
  function melodyBatch(seed, opts) {
    opts = opts || {};
    var S = L.STYLE;
    if (!S) return randomBatch(seed);

    var base = seed || L.GROOVE.newSeed();
    var pick = L.GROOVE.rngOf(base + 104729);
    var styleIds = opts.style ? [opts.style, opts.style, opts.style] : pickIds(S.styles, 3, pick);
    var vibeIds = opts.vibe ? [opts.vibe, opts.vibe, opts.vibe] : pickIds(S.vibes, 3, pick);

    var out = [];
    var tries = 0;
    while (out.length < 3 && tries < 24) {
      var k = out.length;
      var rr = L.GROOVE.rngOf(base + (k + 1) * 7919 + tries * 131);
      var plan = S.planFor(vibeIds[k], styleIds[k], { slot: k, count: 3, r: rr });
      var contour = CONTOURS[Math.floor(rr() * CONTOURS.length)];
      var cand = melodyOf(plan, contour, rr);
      tries++;
      if (!distinctEnough(cand, out)) continue;
      out.push(cand);
    }

    /* 闸门过严时剩下的直接放行：宁可近似，也不能少于三段 */
    while (out.length < 3) {
      var k2 = out.length;
      var rr2 = L.GROOVE.rngOf(base + 9973 + k2 * 4099);
      var plan2 = S.planFor(vibeIds[k2], styleIds[k2], { slot: k2, count: 3, r: rr2 });
      var contour2 = CONTOURS[Math.floor(rr2() * CONTOURS.length)];
      out.push(melodyOf(plan2, contour2, rr2));
    }
    return out;
  }

  /* ---------- 简谱变奏：走向不动，只换节拍与音调 ---------- */
  function degreeSemi(m) {
    var pc = ((m % 12) + 12) % 12;
    var i = DEGREES.indexOf(pc);
    return i < 0 ? 0 : DEGREES[i];
  }

  function degreeLabelOf(m, tonic, mode) {
    var sc = mode === 'major' ? C.MAJ : C.MIN;
    var rel = ((m - tonic - 60) % 12 + 12) % 12;
    var i = sc.indexOf(rel);
    return i < 0 ? 1 : i + 1;
  }

  /* 大小调色彩：把大三度 / 大六度 / 大七度压低半个音，走向仍是原来那条 */
  function toMinor(semis) {
    return semis.map(function (s) {
      return s === 4 ? 3 : (s === 9 ? 8 : (s === 11 ? 10 : s));
    });
  }

  var BPM_BANDS = [82, 96, 118, 132];

  /* 一段变奏：
     音级序列来自用户，节奏按时值重排，音调由 移调 / 大小调 / 八度 组成 */
  function typedOne(rawNotes, r, opts) {
    opts = opts || {};
    var view = opts.view || 'auto';
    var n = rawNotes.length;
    var semis = rawNotes.map(function (x) { return degreeSemi(x.m); });

    var mode = opts.mode || (r() < 0.35 ? 'minor' : 'major');
    if (mode === 'minor') semis = toMinor(semis);
    var bpm = opts.bpm || BPM_BANDS[Math.floor(r() * BPM_BANDS.length)];
    var tonic = opts.tonic !== undefined ? opts.tonic : Math.floor(r() * 12);

    var step;
    if (view === 'half') step = 0.5;
    else if (view === 'long') step = 2;
    else if (view === 'straight') step = 1;
    else step = r() < 0.45 ? 1 : (r() < 0.6 ? 0.5 : 2);
    /* 音多的时候两拍一个音会顶出 16 拍，先按音数压一压 */
    step = Math.min(step, MAX_IN_BEATS / Math.max(1, n));

    var notes = [];
    var beat = 0;
    for (var i = 0; i < n; i++) {
      /* 后面还剩几个音：留白和合并都不能把它们挤出 16 拍 */
      var remain = n - i - 1;

      /* 原谱里的停顿按新格距等比例保留，最多空两格 */
      if (i > 0) {
        var gap = rawNotes[i].b - (rawNotes[i - 1].b + (rawNotes[i - 1].d || 1));
        if (gap > 0.01) {
          var rest = Math.min(2 * step, Math.max(step, Math.round(gap / step) * step));
          if (beat + rest + step * (remain + 1) <= MAX_IN_BEATS + 1e-9) beat += rest;
        }
      }
      if (beat + step * (remain + 1) > MAX_IN_BEATS + 1e-9) break;

      var d = step;
      /* 长音合并：偶尔把两格并成一个，句子才有长短；后面的音还放得下才并 */
      if (remain > 0 && r() < 0.22
        && beat + step * 2 + step * remain <= MAX_IN_BEATS + 1e-9) d = step * 2;

      notes.push({ b: beat, d: d, m: 60 + tonic + semis[i] });
      beat += d;
    }
    if (notes.length < 2) {
      notes = [{ b: 0, d: 1, m: 60 + tonic + semis[0] }, { b: 1, d: 1, m: 60 + tonic }];
    }

    /* 音区收进 48~84：太低抬八度，太高降八度，别把旋律挤出画布 */
    var minM = 99, maxM = 0;
    notes.forEach(function (x) {
      minM = Math.min(minM, x.m); maxM = Math.max(maxM, x.m);
    });
    while (minM < 48) { shiftNotes(notes, 12); minM += 12; maxM += 12; }
    while (maxM > 84) { shiftNotes(notes, -12); minM -= 12; maxM -= 12; }

    return {
      mood: '', vibe: VIEW_NAME[view] || '自动', vibeId: view,
      style: '简谱变奏', styleId: 'typed',
      view: view, contour: 'keep', bpm: bpm,
      tonic: tonic, mode: mode, pools: null, timbreHint: null,
      notes: notes,
      degrees: notes.map(function (x) { return degreeLabelOf(x.m, tonic, mode); })
    };
  }

  /* opts.view 指定时三段都按这一档节奏；不给则自动 / 半拍 / 长音各一段。
     速度也按三档分开挑：三张卡摆在眼前，快慢得听得出差别 */
  function typedBatch(rawNotes, seed, opts) {
    opts = opts || {};
    var base = seed || L.GROOVE.newSeed();
    var views = opts.view ? [opts.view, opts.view, opts.view] : VIEWS;
    var shuffleR = L.GROOVE.rngOf(base + 4711);
    var bands = BPM_BANDS.slice();
    for (var i = bands.length - 1; i > 0; i--) {
      var j = Math.floor(shuffleR() * (i + 1));
      var t = bands[i]; bands[i] = bands[j]; bands[j] = t;
    }

    var out = [];
    for (var k = 0; k < 3; k++) {
      var tries = 0;
      var bpm = bands[k % bands.length];
      var cand = typedOne(rawNotes, L.GROOVE.rngOf(base + (k + 1) * 6151), { view: views[k], bpm: bpm });
      while (!distinctEnough(cand, out) && tries++ < 6) {
        cand = typedOne(rawNotes, L.GROOVE.rngOf(base + (k + 1) * 6151 + tries * 733),
          { view: views[k], bpm: bpm });
      }
      out.push(cand);
    }
    return out;
  }

  /* 「换一版」：只动细节与移调，节奏档与速度保留，微调而不是重来 */
  function typedRoll(rawNotes, seed, keep) {
    keep = keep || {};
    var base = seed || L.GROOVE.newSeed();
    return typedOne(rawNotes, L.GROOVE.rngOf(base), {
      view: keep.view || 'auto',
      bpm: keep.bpm,
      mode: keep.mode
    });
  }

  L.COMPOSE = {
    bestKey: bestKey,
    chooseChords: chooseChords,
    rollChords: rollChords,
    buildSong: buildSong,
    parseDegrees: parseDegrees,
    randomBatch: randomBatch,
    melodyBatch: melodyBatch,
    typedBatch: typedBatch,
    typedRoll: typedRoll,
    views: VIEW_NAME,
    degrees: DEGREES,
    pcOf: pcOf,
    progressions: progressions,
    progOf: progOf
  };
})();
