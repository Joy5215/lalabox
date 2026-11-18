/* ============================================================
 * music/arrange.js — 把 Song 展开成四条轨的事件列表
 * 每件乐器用自己的「曲调（心情）+ 种子」现场生成（music/groove.js），
 * 和音与贝斯的音高按当前调、当前小节的和弦现算。
 * 事件：{ t: 轨道, b: 起始拍, d: 时值(拍), v: 力度, bi: 乐器下标, m: MIDI, ms: 和弦音组 }
 * 暴露：LALA.ARRANGE
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var C = L.C;

  function scaleOf(song) { return song.mode === 'major' ? C.MAJ : C.MIN; }

  function tones(pc, song) {
    var sc = scaleOf(song);
    var deg = ((pc - song.tonic) % 12 + 12) % 12;
    var i = sc.indexOf(deg);
    if (i < 0) return [0, 4, 7];
    return [0, (sc[(i + 2) % 7] - deg + 12) % 12, (sc[(i + 4) % 7] - deg + 12) % 12];
  }

  /* vo：转位与音区，来自 seeds.chord 派生的 variant。
     转位把最低音往上翻，音区整体挪一个八度，换种子才真的换了个味。 */
  function chordMidis(pc, song, vo) {
    var t = tones(pc, song);
    if (vo && vo.inv) {
      var inv = vo.inv % 3;
      t = t.slice(inv).concat(t.slice(0, inv).map(function (x) { return x + 12; }));
    }
    var root = 48 + (pc % 12) + ((vo && vo.oct) || 0);
    var hi = Math.max.apply(null, t);
    while (root + hi > 80) root -= 12;
    while (root < 34) root += 12;
    return t.map(function (x) { return root + x; });
  }

  function barOf(beat) {
    var b = Math.floor(beat / 4);
    return b < 0 ? 0 : b > 3 ? 3 : b;
  }

  /* 乐器的曲调（心情 + 种子）存在每件乐器自己身上：
     同一类加两件，就是两份独立的律动。老数据没有这两项时回落到 song.mood / song.seeds */
  function moodOf(song, it) {
    if (it.mood) return it.mood;
    var m = song.mood || song.feel;
    return (m && m[it.k]) || '晴天';
  }

  function arrange(song) {
    var G = L.GROOVE;
    var band = song.band || [];
    /* 缓存 key 必须覆盖每件乐器的音色 / 曲调 / 音量 / 静音 / 整串片段区间，以及和弦走向 */
    var key = band.map(function (it) {
      var cs = L.util.bandClips(it).map(function (c) {
        var s = c.from + '-' + c.to + (c.mute ? 'm' : '');
        if (c.notes && c.notes.length) {
          s += ':' + c.notes.map(function (n) {
            return n.b + '/' + n.d + '/' + n.m;
          }).join(',');
        }
        return s;
      }).join(',');
      return [it.k, it.id, it.mood, it.seed, it.vol, it.mute ? 1 : 0, cs,
        L.util.bandRate(it)].join(':');
    }).join('|')
      + '|' + (song.bars || []).join(',')
      + '|' + song.tonic + (song.mode === 'major' ? 'M' : 'm');
    if (song._arr && song._arr.key === key) return song._arr.evs;

    var bars = song.bars.slice(0, 4);
    while (bars.length < 4) bars.push(song.tonic);

    var pcs = [];
    var roots = [];
    for (var bar = 0; bar < 4; bar++) {
      var pc = bars[bar] % 12;
      pcs.push(pc);
      roots.push(36 + pc);
    }

    var evs = [];

    /* 主旋律现在也是 band 里的普通一条（k='lead'），走和其它乐器一样的
       片段 / 静音 / 音量口径；老数据没有这条轨时才用后面的兼容分支 */
    var leadEnd = 0;
    song.notes.forEach(function (n) { leadEnd = Math.max(leadEnd, n.b + n.d); });
    var repeatLead = leadEnd <= C.BEATS + 1e-6;
    var leadNotes = [];
    song.notes.forEach(function (n) {
      leadNotes.push({ b: n.b, d: n.d, m: n.m, v: 0.9 });
      if (repeatLead) leadNotes.push({ b: n.b + C.BEATS, d: n.d, m: n.m, v: 0.86 });
    });
    function leadEvents(it, idx) {
      var clips = L.util.bandClips(it);
      /* 片段已经物化出自己的音符：按 clip.from + n.b 发声，内容跟着片段走 */
      var hasClipNotes = clips.some(function (c) { return c.notes && c.notes.length; });
      if (hasClipNotes) {
        clips.forEach(function (c) {
          if (c.mute) return;
          (c.notes || []).forEach(function (n) {
            var b = c.from + n.b;
            evs.push({
              t: 'lead', b: b, d: Math.max(0.05, Math.min(n.d, c.to - b)),
              m: n.m, v: 0.9, bi: idx
            });
          });
        });
        return;
      }
      /* 老数据 / 未物化：照旧按全局乐句 + 窗口过滤 */
      function endAt(b) {
        for (var i = 0; i < clips.length; i++) {
          var c = clips[i];
          if (b >= c.from - 1e-6 && b < c.to - 1e-6) return c.mute ? null : c.to;
        }
        return null;
      }
      leadNotes.forEach(function (n) {
        var end = endAt(n.b);
        if (end === null) return;
        evs.push({
          t: 'lead', b: n.b, d: Math.max(0.05, Math.min(n.d, end - n.b)),
          m: n.m, v: n.v, bi: idx
        });
      });
    }

    /* 一件乐器一份事件：bi 指向 song.band 里的下标，引擎靠它找音色和音量 */
    var hasLead = false;
    band.forEach(function (it, idx) {
      if (it && it.k === 'lead') {
        /* 有 lead 轨就不再走兼容分支：整轨静音时应该真的没有主旋律 */
        hasLead = true;
        if (!it.mute) leadEvents(it, idx);
        return;
      }
      var gen = G[it.k];
      if (!gen) return;
      /* 静音只影响本机播放：整条轨不进事件，也不进分享码 */
      if (it.mute) return;
      var mood = moodOf(song, it);
      var seed = it.seed || (song.seeds && song.seeds[it.k]) || 101;
      /* 片段区间：一件可以有多段。只保留起点落在某一段里的事件，时值截到那一段的终点。
         整段的乐器（绝大多数）走原路径，结果与以前完全一致 */
      var clips = L.util.bandClips(it);
      /* 这一层自己的律动倍率：时间与时长一起缩放，再折回 16 拍。
         2x 会把后半圈压回前半圈、听起来更密；0.5x 只占前 8 拍、更疏 */
      var rate = L.util.bandRate(it);
      var timeAt = function (b) {
        return rate === 1 ? b : (b / rate) % L.util.LOOP_BEATS;
      };
      /* 落在哪一段里：返回那一段的终点；不落在任何一段、或那一段被静音，都返回 null */
      var clipEnd = function (b) {
        for (var i = 0; i < clips.length; i++) {
          var c = clips[i];
          if (b >= c.from - 1e-6 && b < c.to - 1e-6) return c.mute ? null : c.to;
        }
        return null;
      };
      var keep = function (b) { return clipEnd(b) !== null; };
      var durAt = function (b, d) {
        var end = clipEnd(b);
        if (end === null) return 0.05;
        return Math.max(0.05, Math.min((d || 0.25) / rate, end - b));
      };

      if (it.k === 'chord') {
        var vo = G.variant ? G.variant(seed) : null;
        var chords = pcs.map(function (p) { return chordMidis(p, song, vo); });
        gen(seed, mood).forEach(function (e) {
          var b = timeAt(e.b);
          if (!keep(b)) return;
          var ms = chords[barOf(b)];
          evs.push({
            t: 'chord', b: b, d: durAt(b, e.d), v: e.v, bi: idx,
            ms: e.n === undefined ? ms.slice() : [ms[e.n % ms.length]]
          });
        });
      } else if (it.k === 'bass') {
        gen(seed, mood).forEach(function (e) {
          var b = timeAt(e.b);
          if (!keep(b)) return;
          var shift = e.n === 'fifth' ? 7 : (e.n === 'oct' ? 12 : 0);
          evs.push({
            t: 'bass', b: b, d: durAt(b, e.d), v: e.v, bi: idx,
            m: roots[barOf(b)] + shift
          });
        });
      } else {
        gen(seed, mood).forEach(function (e) {
          var b = timeAt(e.b);
          if (!keep(b)) return;
          evs.push({ t: e.t, b: b, d: durAt(b, e.d), v: e.v, bi: idx });
        });
      }
    });

    /* 老数据 / 候选短歌没有 lead 轨：照旧把乐句重复一遍，保证不丢主旋律 */
    if (!hasLead) {
      leadNotes.forEach(function (n) {
        evs.push({ t: 'lead', b: n.b, d: n.d, m: n.m, v: n.v });
      });
    }

    evs.sort(function (a, b) { return a.b - b.b; });
    song._arr = { key: key, evs: evs };
    return evs;
  }

  L.ARRANGE = { arrange: arrange, chordMidis: chordMidis, tones: tones };
})();
