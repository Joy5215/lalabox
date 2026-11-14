/* ============================================================
 * music/arrange.js — 把 Song 展开成四条轨的事件列表
 * 事件：{ t: 轨道, b: 起始拍, d: 时值(拍), v: 力度, m: MIDI, ms: 和弦音组 }
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

  function chordMidis(pc, song) {
    var t = tones(pc, song);
    var root = 48 + (pc % 12);
    if (root + t[2] > 70) root -= 12;
    return t.map(function (x) { return root + x; });
  }

  function arrange(song) {
    if (song._arr && song._arr.style === song.style) return song._arr.evs;

    var evs = [];
    var style = song.style;
    var bars = song.bars.slice(0, 4);
    while (bars.length < 4) bars.push(song.tonic);

    for (var bar = 0; bar < 4; bar++) {
      var pc = bars[bar] % 12;
      var ms = chordMidis(pc, song);
      var bassRoot = 36 + pc;
      var o = bar * 4;

      var add = function (t, b, d, v, m, chord) {
        var e = { t: t, b: o + b, d: d, v: v };
        if (m !== undefined) e.m = m;
        if (chord) e.ms = chord;
        evs.push(e);
      };

      if (style === 'edm') {
        [0, 1, 2, 3].forEach(function (b) { add('kick', b, 0.2, 1); });
        add('clap', 1, 0.2, 0.85); add('clap', 3, 0.2, 0.85);
        for (var b1 = 0.5; b1 < 4; b1 += 1) add('hat', b1, 0.1, 0.5);
        add('openhat', 3.5, 0.2, 0.5);
        [0.5, 1.5, 2.5, 3.5].forEach(function (b) { add('bass', b, 0.34, 0.95, bassRoot); });
        [0.5, 1.5, 2.5, 3.5].forEach(function (b) { add('chord', b, 0.3, 0.8, undefined, ms); });
      } else if (style === 'lofi') {
        add('kick', 0, 0.3, 0.95); add('kick', 2.5, 0.3, 0.82);
        add('snare', 2, 0.3, 0.78);
        for (var b2 = 0; b2 < 4; b2 += 0.5) {
          var swing = (Math.round(b2 * 2) % 2) ? 0.07 : 0;
          add('hat', b2 + swing, 0.08, 0.36);
        }
        add('bass', 0, 0.9, 0.9, bassRoot);
        add('bass', 1.5, 0.45, 0.7, bassRoot + 7);
        add('bass', 2.5, 0.9, 0.85, bassRoot);
        add('bass', 3.5, 0.4, 0.65, bassRoot + 7);
        add('chord', 0, 1.8, 0.85, undefined, ms);
        add('chord', 2.5, 1.3, 0.72, undefined, ms);
      } else if (style === 'rock') {
        add('kick', 0, 0.25, 1); add('kick', 1.5, 0.25, 0.78);
        add('kick', 2, 0.25, 0.9); add('kick', 2.75, 0.2, 0.66);
        add('snare', 1, 0.25, 0.9); add('snare', 3, 0.25, 0.9);
        for (var b3 = 0; b3 < 4; b3 += 0.5) add('hat', b3, 0.07, 0.44);
        for (var b4 = 0; b4 < 4; b4 += 0.5) add('bass', b4, 0.4, 0.9, bassRoot);
        add('chord', 0, 1.8, 0.92, undefined, ms);
        add('chord', 2, 1.8, 0.92, undefined, ms);
      } else {
        add('kick', 0, 0.3, 1); add('kick', 2, 0.3, 0.88);
        add('snare', 1, 0.3, 0.84); add('snare', 3, 0.3, 0.84);
        for (var b5 = 0; b5 < 4; b5 += 0.5) add('hat', b5, 0.07, 0.4);
        add('openhat', 3.5, 0.2, 0.42);
        add('bass', 0, 1.4, 0.95, bassRoot);
        add('bass', 2, 1.4, 0.88, bassRoot);
        add('bass', 3.5, 0.4, 0.7, bassRoot + 7);
        add('chord', 0, 3.7, 0.9, undefined, ms);
      }
    }

    song.notes.forEach(function (n) {
      evs.push({ t: 'lead', b: n.b, d: n.d, m: n.m, v: 0.9 });
      if (style === 'edm' && n.d >= 0.5) {
        evs.push({ t: 'lead', b: n.b, d: n.d, m: n.m + 12, v: 0.3 });
      }
    });

    evs.sort(function (a, b) { return a.b - b.b; });
    song._arr = { style: style, evs: evs };
    return evs;
  }

  L.ARRANGE = { arrange: arrange, chordMidis: chordMidis, tones: tones };
})();
