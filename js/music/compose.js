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

  function bestKey(hist) {
    var best = { score: -1e9, tonic: 9, mode: 'minor' };
    for (var t = 0; t < 12; t++) {
      for (var mi = 0; mi < 2; mi++) {
        var prof = mi === 0 ? MAJOR_PROFILE : MINOR_PROFILE;
        var s = 0;
        for (var pc = 0; pc < 12; pc++) s += hist[(pc + t) % 12] * prof[pc];
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

  function chooseChords(notes, tonic, mode) {
    var sc = mode === 'major' ? C.MAJ : C.MIN;
    var pools = mode === 'major'
      ? [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [3, 4, 2, 5], [0, 3, 4, 0]]
      : [[0, 5, 2, 6], [0, 3, 4, 0], [5, 2, 0, 6], [0, 6, 5, 4]];

    var bestProg = pools[0], bestScore = -1e9;
    for (var pi = 0; pi < pools.length; pi++) {
      var prog = pools[pi];
      var score = (pools.length - pi) * 0.15;
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
      if (score > bestScore) { bestScore = score; bestProg = prog; }
    }
    return bestProg.map(function (d) { return (tonic + sc[d % 7]) % 12; });
  }

  function buildSong(rawNotes) {
    var notes = rawNotes.map(function (n) { return { b: n.b, d: n.d, m: n.m }; });

    var minM = 99, maxM = 0;
    notes.forEach(function (n) {
      minM = Math.min(minM, n.m);
      maxM = Math.max(maxM, n.m);
    });
    while (minM < 55) { notes.forEach(function (n) { n.m += 12; }); minM += 12; maxM += 12; }
    while (maxM > 82) { notes.forEach(function (n) { n.m -= 12; }); minM -= 12; maxM -= 12; }

    var hist = new Array(12).fill(0);
    notes.forEach(function (n) { hist[((n.m % 12) + 12) % 12] += n.d; });
    var key = bestKey(hist);
    var sc = key.mode === 'major' ? C.MAJ : C.MIN;

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

    return {
      v: 1, bpm: C.BPM, tonic: key.tonic, mode: key.mode, style: 'pop',
      bars: chooseChords(notes, key.tonic, key.mode),
      notes: notes
    };
  }

  L.COMPOSE = {
    bestKey: bestKey,
    chooseChords: chooseChords,
    buildSong: buildSong
  };
})();
