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

  /* 卷帘按「每件乐器一行」画，主旋律也是其中一行（k='lead'） */
  var ROW_COLOR = {
    drums: CLAY, bass: SAGE_M, chord: SKY,
    voice: '#B3A9C9', amb: '#A7B7AD', lead: SAND
  };

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
    if (!song) return;

    /* 画编曲后的主旋律事件：8 拍乐句在后两小节会重复一次，
       只读 song.notes 的话右半边永远是空的，听到的和看到的对不上。
       现在主旋律可能存进 lead 片段（per-clip notes），统一读 arrange 的 lead 事件 */
    var evs = L.ARRANGE.arrange(song).filter(function (e) { return e.t === 'lead'; });
    if (!evs.length) return;

    var minM = 99, maxM = 0;
    evs.forEach(function (n) {
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
    evs.forEach(function (n, i) {
      var x0 = X(n.b), x1 = X(n.b + n.d), y = Y(n.m);
      if (i === 0) c.moveTo(x0, y); else c.lineTo(x0, y);
      c.lineTo(x1, y);
    });
    c.stroke();

    evs.forEach(function (n) {
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

    /* 每件乐器一行，行名就是音色名；lead 轨也是普通一行，名字跟着选的主音走 */
    var rows = [];
    (song.band || []).forEach(function (it, idx) {
      if (!it || !ROW_COLOR[it.k]) return;
      rows.push({
        bi: idx,
        kind: it.k,
        label: L.TIMBRE.nameOf(it.k, it.id) || L.TIMBRE.familyName(it.k, it.id) || '乐器',
        color: ROW_COLOR[it.k]
      });
    });

    var padT = 6, padB = 4;
    var laneH = (h - padT - padB) / rows.length;

    /* 行多了就一起压薄：字号跟着行高走，标签宽度按最长名字算 */
    var fs = L.util.clamp(Math.floor(laneH) - 2, 7, 10);
    var maxChars = rows.reduce(function (m, r) { return Math.max(m, r.label.length); }, 3);
    var labelW = L.util.clamp(Math.ceil(maxChars * fs * 0.95) + 6, 34, 56);
    var padL = labelW + 4;
    var X = function (b) { return padL + (b / 16) * (w - padL - 4); };
    var bh = L.util.clamp(laneH - 2, 2, 9);

    var evs = L.ARRANGE.arrange(song);
    var byBi = {};
    for (var i = 0; i < evs.length; i++) {
      var one = evs[i];
      if (one.bi === undefined || one.bi === null) continue;
      (byBi[one.bi] || (byBi[one.bi] = [])).push(one);
    }

    c.font = fs + 'px "PingFang SC",system-ui,sans-serif';
    c.textBaseline = 'middle';
    rows.forEach(function (row, i) {
      var cy = padT + laneH * i + laneH / 2;
      c.fillStyle = LABEL;
      c.fillText(row.label, 0, cy, labelW - 2);   /* maxWidth 兜底，别压到时间轴上 */
      if (laneH < 9) return;                      /* 行太密就不画分隔线，免得糊成一片 */
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

    rows.forEach(function (row, i) {
      var cy = padT + laneH * i + laneH / 2;
      /* 人声 / 氛围没有排程事件：人声是录音循环，氛围是持续铺底，
         都按自己的每一段画底色带（整段时就是贯穿整条） */
      if (row.kind === 'voice' || row.kind === 'amb') {
        c.globalAlpha = 0.32;
        c.fillStyle = row.color;
        L.util.bandClips(song.band[row.bi]).forEach(function (cl) {
          var x0 = X(cl.from);
          rr(c, x0, cy - bh / 2, Math.max(3, X(cl.to) - x0 - 1), bh, Math.min(2.5, bh / 2));
          c.fill();
        });
        c.globalAlpha = 1;
        return;
      }
      var list = byBi[row.bi] || [];
      var radius = Math.min(2.5, bh / 2);
      for (var k = 0; k < list.length; k++) {
        var e = list[k];
        var active = posBeat >= e.b && posBeat < e.b + (e.d || 0.25);
        var x = X(e.b);
        var bw = Math.max(3, X(e.b + (e.d || 0.25)) - x - 1);
        c.globalAlpha = active ? 1 : 0.55;
        c.fillStyle = row.color;
        rr(c, x, cy - bh / 2, bw, bh, radius);
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
