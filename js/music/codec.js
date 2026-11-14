/* ============================================================
 * music/codec.js — Song 与紧凑 base36 字符串互转
 * 用途：URL 分享（?s=）与云存储 value（≤1024 字节）
 * 暴露：LALA.CODEC
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var U = L.util, C = L.C;

  function enc2(n) {
    n = U.clamp(n | 0, 0, 1295);
    return U.pad2(U.b36(Math.floor(n / 36)) + U.b36(n % 36));
  }
  function dec2(s) { return U.unb36(s.charAt(0)) * 36 + U.unb36(s.charAt(1)); }

  function encode(song) {
    var s = '1';
    s += U.b36(C.STYLE_ORDER.indexOf(song.style));
    s += U.b36(song.tonic);
    s += song.mode === 'major' ? '0' : '1';

    var n = Math.min(song.notes.length, 64);
    s += U.pad2(U.b36(Math.floor(n / 36)) + U.b36(n % 36));
    for (var i = 0; i < 4; i++) s += U.b36(song.bars[i] % 12);

    var prev = 0;
    for (var k = 0; k < n; k++) {
      var nt = song.notes[k];
      var on = Math.round(nt.b * 2);
      var d = U.clamp(Math.round(nt.d * 2), 1, 35);
      var m = U.clamp(nt.m, 36, 99) - 36;
      s += U.b36(U.clamp(on - prev, 0, 35));
      s += U.b36(d);
      s += enc2(m);
      prev = on;
    }
    return s;
  }

  function decode(str) {
    if (!str || typeof str !== 'string') return null;
    if (str.length < 10 || str.length > 512) return null;
    if (!/^[0-9a-z]+$/.test(str)) return null;

    try {
      var p = 0;
      if (str.charAt(p++) !== '1') return null;

      var si = U.unb36(str.charAt(p++));
      if (si < 0 || si > 3) return null;

      var tonic = U.unb36(str.charAt(p++));
      if (tonic < 0 || tonic > 11) return null;

      var modeChar = str.charAt(p++);
      if (modeChar !== '0' && modeChar !== '1') return null;

      var n = dec2(str.substr(p, 2));
      p += 2;
      if (!(n >= 0 && n <= 64)) return null;

      var bars = [];
      for (var i = 0; i < 4; i++) {
        var pc = U.unb36(str.charAt(p++));
        if (pc < 0 || pc > 11) return null;
        bars.push(pc);
      }

      var notes = [], prev = 0;
      for (var k = 0; k < n; k++) {
        var dOn = U.unb36(str.charAt(p++));
        if (dOn < 0) return null;
        var dDur = U.unb36(str.charAt(p++));
        if (dDur < 1) return null;
        var m = dec2(str.substr(p, 2));
        p += 2;
        var midi = m + 36;
        if (midi < 36 || midi > 99) return null;
        var on = prev + dOn;
        notes.push({ b: on / 2, d: dDur / 2, m: midi });
        prev = on;
      }

      return {
        v: 1, bpm: C.BPM, tonic: tonic,
        mode: modeChar === '0' ? 'major' : 'minor',
        style: C.STYLE_ORDER[si], bars: bars, notes: notes
      };
    } catch (e) {
      return null;
    }
  }

  L.CODEC = { encode: encode, decode: decode };
})();
