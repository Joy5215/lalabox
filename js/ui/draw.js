/* ============================================================
 * ui/draw.js — 所有 canvas 绘制
 * 音高轨迹 / 四轨卷帘 / 录音环形频谱
 * 暴露：LALA.DRAW
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;

  var LANES = [
    { keys: ['kick', 'snare', 'hat', 'openhat', 'clap'], label: '鼓', color: '#FF3D9A' },
    { keys: ['bass'], label: '贝斯', color: '#7C4DFF' },
    { keys: ['chord'], label: '和弦', color: '#00E5FF' },
    { keys: ['lead'], label: '主旋律', color: '#35F0A0' }
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

    c.strokeStyle = 'rgba(255,255,255,.055)';
    c.lineWidth = 1;
    for (var bar = 0; bar <= 4; bar++) {
      c.beginPath();
      c.moveTo(X(bar * 4), padT);
      c.lineTo(X(bar * 4), h - padB);
      c.stroke();
    }

    var grad = c.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#8B5CFF');
    grad.addColorStop(.5, '#7C4DFF');
    grad.addColorStop(1, '#00E5FF');

    c.strokeStyle = grad;
    c.lineWidth = 2.2;
    c.lineJoin = 'round';
    c.shadowColor = 'rgba(124,77,255,.75)';
    c.shadowBlur = 12;
    c.beginPath();
    song.notes.forEach(function (n, i) {
      var x0 = X(n.b), x1 = X(n.b + n.d), y = Y(n.m);
      if (i === 0) c.moveTo(x0, y); else c.lineTo(x0, y);
      c.lineTo(x1, y);
    });
    c.stroke();
    c.shadowBlur = 0;

    song.notes.forEach(function (n) {
      var active = posBeat >= n.b && posBeat < n.b + n.d;
      c.beginPath();
      c.arc(X(n.b), Y(n.m), active ? 4.4 : 2.6, 0, Math.PI * 2);
      c.fillStyle = active ? '#fff' : 'rgba(255,255,255,.75)';
      c.shadowColor = active ? '#00E5FF' : 'rgba(124,77,255,.9)';
      c.shadowBlur = active ? 16 : 8;
      c.fill();
      c.shadowBlur = 0;
    });

    if (posBeat > 0) {
      var px = X(posBeat);
      var lg = c.createLinearGradient(0, padT, 0, h - padB);
      lg.addColorStop(0, 'rgba(0,229,255,0)');
      lg.addColorStop(1, 'rgba(0,229,255,.55)');
      c.strokeStyle = lg;
      c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(px, padT); c.lineTo(px, h - padB); c.stroke();
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
      c.fillStyle = 'rgba(255,255,255,.32)';
      c.fillText(lane.label, 0, cy);
      c.strokeStyle = 'rgba(255,255,255,.04)';
      c.beginPath();
      c.moveTo(padL, padT + laneH * i);
      c.lineTo(w - 2, padT + laneH * i);
      c.stroke();
    });

    for (var bar = 0; bar <= 4; bar++) {
      c.strokeStyle = 'rgba(255,255,255,.05)';
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
        c.globalAlpha = active ? 1 : 0.62;
        c.fillStyle = lane.color;
        if (active) { c.shadowColor = lane.color; c.shadowBlur = 12; }
        rr(c, x, cy - bh / 2, bw, bh, 2.5);
        c.fill();
        c.shadowBlur = 0;
      }
      c.globalAlpha = 1;
    });

    if (posBeat > 0) {
      var px = X(posBeat);
      var lg = c.createLinearGradient(0, 0, Math.max(1, px), 0);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(1, 'rgba(255,255,255,.32)');
      c.strokeStyle = lg;
      c.lineWidth = 6;
      c.beginPath(); c.moveTo(Math.max(padL, px - 26), 0); c.lineTo(px, 0); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.6)';
      c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(px, padT); c.lineTo(px, h - padB); c.stroke();
    }
  }

  function record(cv, spectrum, level, phase) {
    var o = fit(cv), c = o.c, w = o.w, h = o.h;
    var cx = w / 2, cy = h / 2;
    var R = Math.min(w, h) / 2 - 6;

    var glow = c.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.1);
    glow.addColorStop(0, 'rgba(124,77,255,' + (0.1 + level * 0.35) + ')');
    glow.addColorStop(1, 'rgba(124,77,255,0)');
    c.fillStyle = glow;
    c.beginPath(); c.arc(cx, cy, R * 1.1, 0, Math.PI * 2); c.fill();

    c.strokeStyle = 'rgba(255,255,255,.09)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();

    var N = 72;
    for (var i = 0; i < N; i++) {
      var v = 0;
      if (spectrum) {
        var si = Math.floor(i / N * spectrum.length * 0.55);
        v = spectrum[si] / 255;
      }
      v = Math.pow(v, 1.3);
      var a = (i / N) * Math.PI * 2 - Math.PI / 2;
      var r0 = R - 26;
      var r1 = r0 + 4 + v * 26;
      var hue = i / N;
      c.strokeStyle = 'hsl(' + (262 - hue * 100) + ',100%,' + (58 + v * 22) + '%)';
      c.globalAlpha = 0.35 + v * 0.65;
      c.lineWidth = 3;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      c.stroke();
    }
    c.globalAlpha = 1;

    c.strokeStyle = 'rgba(0,229,255,' + (0.25 + level * 0.75) + ')';
    c.lineWidth = 2;
    c.beginPath();
    for (var k = 0; k <= 60; k++) {
      var ang = (k / 60) * Math.PI * 2 + phase;
      var rr2 = R - 6 + Math.sin(ang * 3 + phase * 2) * 4;
      var x = cx + Math.cos(ang) * rr2, y = cy + Math.sin(ang) * rr2;
      if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    c.stroke();
  }

  L.DRAW = { fit: fit, melody: melody, band: band, record: record, rr: rr };
})();
