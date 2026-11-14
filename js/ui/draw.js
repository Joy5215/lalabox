/* ============================================================
 * ui/draw.js — 所有 canvas 绘制（治愈系配色，无发光）
 * 音高轨迹 / 四轨卷帘 / 录音环形频谱
 * 暴露：LALA.DRAW
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;

  var INK = '#3E3A33';
  var SAGE = '#6F8F6C';
  var SAGE_M = '#8FAE8B';
  var SKY = '#A3C1D4';
  var CLAY = '#D99C8A';
  var SAND = '#C9B48C';
  var LINE = 'rgba(62,58,51,.07)';
  var LABEL = 'rgba(62,58,51,.38)';

  var LANES = [
    { keys: ['kick', 'snare', 'hat', 'openhat', 'clap'], label: '鼓', color: CLAY },
    { keys: ['bass'], label: '贝斯', color: SAGE_M },
    { keys: ['chord'], label: '和弦', color: SKY },
    { keys: ['lead'], label: '主旋律', color: SAND }
  ];

  function fit(cv) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var r = cv.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    return { c: c, w: w, h: h };
  }

  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function melody(cv, song, posBeat) {
    var o = fit(cv), c = o.c, w = o.w, h = o.h;
    if (!song || !song.notes.length) return;

    var minM = 99, maxM = 0;
    song.notes.forEach(function (n) {
      minM = Math.min(minM, n.m);
      maxM = Math.max(maxM, n.m);
    });
    minM -= 2; maxM += 2;

    var padL = 6, padR = 6, padB = 12, padT = 8;
    var X = function (b) { return padL + (b / 16) * (w - padL - padR); };
    var Y = function (m) {
      return h - padB - ((m - minM) / Math.max(6, maxM - minM)) * (h - padB - padT);
    };

    c.strokeStyle = LINE;
    c.lineWidth = 1;
    for (var bar = 0; bar <= 4; bar++) {
      c.beginPath();
      c.moveTo(X(bar * 4), padT);
      c.lineTo(X(bar * 4), h - padB);
      c.stroke();
    }

    var grad = c.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, SAGE);
    grad.addColorStop(.55, SAGE_M);
    grad.addColorStop(1, SKY);

    c.strokeStyle = grad;
    c.lineWidth = 2.2;
    c.lineJoin = 'round';
    c.beginPath();
    song.notes.forEach(function (n, i) {
      var x0 = X(n.b), x1 = X(n.b + n.d), y = Y(n.m);
      if (i === 0) c.moveTo(x0, y); else c.lineTo(x0, y);
      c.lineTo(x1, y);
    });
    c.stroke();

    song.notes.forEach(function (n) {
      var active = posBeat >= n.b && posBeat < n.b + n.d;
      c.beginPath();
      c.arc(X(n.b), Y(n.m), active ? 4.2 : 2.4, 0, Math.PI * 2);
      c.fillStyle = active ? SAGE : SAND;
      c.fill();
      if (active) {
        c.strokeStyle = 'rgba(111,143,108,.35)';
        c.lineWidth = 2;
        c.stroke();
      }
    });

    if (posBeat > 0) {
      var px = X(posBeat);
      c.save();
      c.setLineDash([3, 3]);
      c.strokeStyle = 'rgba(62,58,51,.28)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(px, padT); c.lineTo(px, h - padB); c.stroke();
      c.restore();
    }
  }

  function band(cv, song, posBeat) {
    var o = fit(cv), c = o.c, w = o.w, h = o.h;
    if (!song) return;

    var labelW = 34;
    var padL = labelW + 4, padT = 6, padB = 4;
    var X = function (b) { return padL + (b / 16) * (w - padL - 4); };
    var laneH = (h - padT - padB) / LANES.length;
    var evs = L.ARRANGE.arrange(song);

    c.font = '10px "PingFang SC",system-ui,sans-serif';
    c.textBaseline = 'middle';
    LANES.forEach(function (lane, i) {
      var cy = padT + laneH * i + laneH / 2;
      c.fillStyle = LABEL;
      c.fillText(lane.label, 0, cy);
      c.strokeStyle = 'rgba(62,58,51,.05)';
      c.beginPath();
      c.moveTo(padL, padT + laneH * i);
      c.lineTo(w - 2, padT + laneH * i);
      c.stroke();
    });

    for (var bar = 0; bar <= 4; bar++) {
      c.strokeStyle = LINE;
      c.beginPath();
      c.moveTo(X(bar * 4), padT);
      c.lineTo(X(bar * 4), h - padB);
      c.stroke();
    }

    LANES.forEach(function (lane, i) {
      var cy = padT + laneH * i + laneH / 2;
      var bh = Math.min(9, laneH - 6);
      for (var k = 0; k < evs.length; k++) {
        var e = evs[k];
        if (lane.keys.indexOf(e.t) < 0) continue;
        var active = posBeat >= e.b && posBeat < e.b + (e.d || 0.25);
        var x = X(e.b);
        var bw = Math.max(3, X(e.b + (e.d || 0.25)) - x - 1);
        c.globalAlpha = active ? 1 : 0.55;
        c.fillStyle = lane.color;
        rr(c, x, cy - bh / 2, bw, bh, 2.5);
        c.fill();
      }
      c.globalAlpha = 1;
    });

    if (posBeat > 0) {
      var px = X(posBeat);
      c.save();
      c.setLineDash([3, 3]);
      c.strokeStyle = 'rgba(62,58,51,.3)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(px, padT); c.lineTo(px, h - padB); c.stroke();
      c.restore();
    }
  }

  function lerpHex(a, b, t) {
    var pa = [parseInt(a.substr(1, 2), 16), parseInt(a.substr(3, 2), 16), parseInt(a.substr(5, 2), 16)];
    var pb = [parseInt(b.substr(1, 2), 16), parseInt(b.substr(3, 2), 16), parseInt(b.substr(5, 2), 16)];
    var r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    var g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    var bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  function record(cv, spectrum, level, phase) {
    var o = fit(cv), c = o.c, w = o.w, h = o.h;
    var cx = w / 2, cy = h / 2;
    var R = Math.min(w, h) / 2 - 6;

    var glow = c.createRadialGradient(cx, cy, R * 0.25, cx, cy, R);
    glow.addColorStop(0, 'rgba(143,174,139,' + (0.10 + level * 0.22) + ')');
    glow.addColorStop(1, 'rgba(143,174,139,0)');
    c.fillStyle = glow;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();

    c.strokeStyle = 'rgba(62,58,51,.10)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, R - 2, 0, Math.PI * 2); c.stroke();

    c.setLineDash([2, 5]);
    c.strokeStyle = 'rgba(62,58,51,.09)';
    c.beginPath(); c.arc(cx, cy, R - 34, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);

    var N = 72;
    for (var i = 0; i < N; i++) {
      var v = 0;
      if (spectrum) {
        var si = Math.floor(i / N * spectrum.length * 0.55);
        v = spectrum[si] / 255;
      }
      v = Math.pow(v, 1.35);
      var a = (i / N) * Math.PI * 2 - Math.PI / 2;
      var r0 = R - 28;
      var r1 = r0 + 3 + v * 22;
      c.strokeStyle = lerpHex('#B7CDB2', '#A3C1D4', i / N);
      c.globalAlpha = 0.4 + v * 0.6;
      c.lineWidth = 3;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      c.stroke();
    }
    c.globalAlpha = 1;

    c.strokeStyle = 'rgba(217,156,138,' + (0.45 + level * 0.4) + ')';
    c.lineWidth = 1.6;
    c.beginPath();
    for (var k = 0; k <= 60; k++) {
      var ang = (k / 60) * Math.PI * 2 + phase * 0.4;
      var rr2 = R - 10 + Math.sin(ang * 3 + phase * 0.8) * 3;
      var x = cx + Math.cos(ang) * rr2, y = cy + Math.sin(ang) * rr2;
      if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    c.stroke();
  }

  L.DRAW = { fit: fit, melody: melody, band: band, record: record, rr: rr };
})();
