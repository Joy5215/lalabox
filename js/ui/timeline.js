/* ============================================================
 * ui/timeline.js — 全屏多轨时间线（「编曲」）
 * 每件乐器 / 人声 / 氛围各占一条轨道，主旋律是一条只读参考轨。
 * 这里只做视图与指针交互：数据仍然归 app.js，改完通过 ctx 回调写回，
 * 拖动过程只改本地 ghost 样式，松手才 onChange（避免每一像素都重启音频）。
 * 暴露：LALA.TIMELINE
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var U = L.util;

  var LOOP = U.LOOP_BEATS;
  var HEAD_W = 84;      /* 轨道头宽度，必须和 css 的 .tl-head 一致 */
  var EDGE = 12;        /* 片段两端各留 12px 裁剪热区 */
  var MIN_PX = 4;       /* 超过 4px 才算拖动，避免误触 */
  var NEW_PX = 10;      /* 空白处至少横向拖出 10px 才新建，点一下不算 */
  var MAX_TRACKS = 12;  /* 与 app.js / codec 的「最多 12 件」一致 */

  var COLOR = {
    drums: '#D99C8A', bass: '#A7B7AD', chord: '#A3C1D4',
    voice: '#B3A9C9', amb: '#93A9A2', lead: '#C9B48C'
  };
  var KIND_CN = {
    drums: '鼓', bass: '贝斯', chord: '和音', voice: '人声', amb: '氛围', lead: '旋律'
  };

  var el = {};
  var ctx = null;
  var opened = false;
  var mode = 'edit';
  var sel = { bi: -1, ci: -1 };
  var step = 0.5;
  var drag = null;
  var scrub = null;
  var gridW = 0, laneW = 0;
  var splitBtn = null;
  var lastPlaying = null;
  var clipboard = null;   /* 复制 / 剪切留下的那一段：{from,to,mute} */
  /* 每帧要高亮的片段与「正在响」提示：建造时登记，tick 里只改 class，不碰 DOM 结构 */
  var clipNodes = [];
  var liveHint = null;
  /* 拖动片段时临时出现在最下面的「新轨道」投放区；松手 / 取消就收掉 */
  var dropRow = null;

  function $(id) { return document.getElementById(id); }
  function say(msg) { if (ctx && ctx.onSay) ctx.onSay(msg); }
  function band() { return (ctx && ctx.song && ctx.song.band) || []; }
  function itemOf(bi) {
    if (bi === -1) return (mode === 'preview' && ctx) ? ctx.preview : null;
    return band()[bi] || null;
  }
  function clipsOf(bi) {
    var it = itemOf(bi);
    return it ? U.bandClips(it) : [];
  }
  function beatText(v) { return (Math.round(v * 2) / 2).toFixed(1); }
  function snap(b) { return Math.round(b * 2) / 2; }
  function nowBeat() {
    var b = ctx && ctx.getBeat ? ctx.getBeat() : 0;
    b = (typeof b === 'number' && isFinite(b)) ? b : 0;
    b = b % LOOP;
    return b < 0 ? b + LOOP : b;
  }
  function isPlaying() { return !!(ctx && ctx.isPlaying && ctx.isPlaying()); }

  function line(cls) {
    var d = document.createElement('div');
    d.className = 'tl-bar-line' + (cls ? ' ' + cls : '');
    return d;
  }
  function button(text, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls || 'tl-btn soft';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  /* ---------- 骨架 ---------- */
  function mount() {
    if (el.root) return true;
    el.root = $('sheetEdit');
    if (!el.root) return false;
    el.meta = $('tlMeta');
    el.play = $('tlPlay');
    el.done = $('tlDone');
    el.back = $('tlBack');
    el.grid = $('tlGrid');
    el.body = el.root.querySelector('.tl-body');   /* 轨道区的滚动容器 */
    el.ruler = $('tlRuler');
    el.rows = $('tlRows');
    el.ph = $('tlPh');
    el.bar = $('tlBar');

    el.back.addEventListener('click', function () {
      if (mode === 'preview' && ctx.onCancel) ctx.onCancel();
      else if (ctx.onDone) ctx.onDone();
    });
    el.done.addEventListener('click', function () {
      if (mode === 'preview' && ctx.onJoin) ctx.onJoin();
      else if (ctx.onDone) ctx.onDone();
    });
    el.play.addEventListener('click', function () {
      if (ctx.onPlayToggle) ctx.onPlayToggle();
      refresh();
    });
    el.root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (mode === 'preview' && ctx.onCancel) ctx.onCancel();
        else if (ctx.onDone) ctx.onDone();
      }
    });
    window.addEventListener('resize', function () {
      if (!opened) return;
      measure();
      tick(nowBeat());
    });
    return true;
  }

  /* ---------- 时间尺 ---------- */
  function buildRuler() {
    el.ruler.innerHTML = '';
    var gutter = document.createElement('div');
    gutter.className = 'tl-gutter';
    gutter.textContent = '小节';
    el.ruler.appendChild(gutter);

    var ticks = document.createElement('div');
    ticks.className = 'tl-ticks';
    for (var b = 0; b <= LOOP; b++) {
      var t = document.createElement('i');
      t.className = 'tl-tick' + (b % 4 === 0 ? ' bar' : '');
      t.style.left = (b / LOOP * 100) + '%';
      ticks.appendChild(t);
    }
    for (var bar = 0; bar < 4; bar++) {
      var n = document.createElement('span');
      n.className = 'tl-bar-no';
      n.style.left = (bar * 4 / LOOP * 100) + '%';
      n.textContent = String(bar + 1);
      ticks.appendChild(n);
    }
    ticks.addEventListener('pointerdown', onRulerDown);
    el.ruler.appendChild(ticks);
  }

  function beatFromX(x, rect) {
    if (!rect || !rect.width) return 0;
    return U.clamp(snap((x - rect.left) / rect.width * LOOP), 0, LOOP);
  }

  function onRulerDown(e) {
    if (!opened) return;
    var box = e.currentTarget;
    var rect = box.getBoundingClientRect();
    scrub = { rect: rect, beat: beatFromX(e.clientX, rect) };
    placePlayhead(scrub.beat);
    try { box.setPointerCapture(e.pointerId); } catch (err) {}
    window.addEventListener('pointermove', onRulerMove);
    window.addEventListener('pointerup', onRulerUp);
    window.addEventListener('pointercancel', onRulerUp);
    e.preventDefault();
  }

  function onRulerMove(e) {
    if (!scrub) return;
    scrub.beat = beatFromX(e.clientX, scrub.rect);
    placePlayhead(scrub.beat);
  }

  function onRulerUp() {
    window.removeEventListener('pointermove', onRulerMove);
    window.removeEventListener('pointerup', onRulerUp);
    window.removeEventListener('pointercancel', onRulerUp);
    if (!scrub) return;
    var b = scrub.beat;
    scrub = null;
    if (ctx.onSeek) ctx.onSeek(b);
    tick(nowBeat());
  }

  /* ---------- 轨道 ---------- */
  function buildRows() {
    el.rows.innerHTML = '';
    dropRow = null;        /* innerHTML 清空时投放区也一起没了，别留悬空引用 */
    clipNodes = [];
    var list = band();
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || !COLOR[list[i].k]) continue;
      el.rows.appendChild(trackRow(i, list[i], false));
    }
    if (mode === 'preview' && ctx.preview) {
      el.rows.appendChild(trackRow(-1, ctx.preview, true));
    }
  }

  function trackRow(bi, it, isPreview) {
    var row = document.createElement('div');
    row.className = 'tl-row' + (sel.bi === bi ? ' on' : '') + (it.mute ? ' muted' : '');
    row.setAttribute('data-bi', String(bi));

    var head = document.createElement('div');
    head.className = 'tl-head';
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-label', (L.TIMBRE.nameOf(it.k, it.id) || '乐器') + ' 的轨道');

    var name = document.createElement('b');
    name.className = 'tl-name';
    name.textContent = L.TIMBRE.nameOf(it.k, it.id) || '乐器';
    head.appendChild(name);

    var kind = document.createElement('span');
    kind.className = 'tl-kind';
    kind.textContent = (isPreview ? '试听中' : (KIND_CN[it.k] || '')) + (it.mute ? ' · 静音' : '');
    head.appendChild(kind);

    if (!isPreview) {
      /* 轨道静音：小喇叭，点亮 + 斜杠 = 这一轨暂时不出声（不进分享码） */
      var mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'tl-mute' + (it.mute ? ' on' : '');
      mute.setAttribute('aria-label', it.mute ? '取消静音这一轨' : '静音这一轨');
      mute.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor">'
        + '<path d="M4 9.4h3.1L12 5.5v13l-4.9-3.9H4z"/>'
        + '<path d="M15.3 8.4a5.3 5.3 0 0 1 0 7.2" fill="none" stroke="currentColor"'
        + ' stroke-width="1.7" stroke-linecap="round"/></svg>';
      mute.addEventListener('click', function (e) {
        e.stopPropagation();
        if (ctx.onToggleMute) ctx.onToggleMute(bi);
        refresh();
      });
      head.appendChild(mute);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'tl-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', '删掉这一轨');
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (ctx.onDeleteTrack) ctx.onDeleteTrack(bi);
        if (!opened) return;
        /* 后面的下标整体前移，选中态直接清掉，别指到另一件上 */
        sel = { bi: -1, ci: -1 };
        refresh();
      });
      head.appendChild(del);
    }

    var pick = function () { selectTrack(bi); };
    head.addEventListener('click', pick);
    head.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pick();
    });

    var lane = document.createElement('div');
    lane.className = 'tl-lane' + (it.k === 'voice' || it.k === 'amb' ? ' soft' : '');
    lane.setAttribute('data-bi', String(bi));
    var clips = U.bandClips(it);
    for (var ci = 0; ci < clips.length; ci++) {
      var node = clipEl(bi, ci, clips[ci], it.k);
      lane.appendChild(node);
      clipNodes.push({ node: node, bi: bi, c: clips[ci], air: false });
    }
    lane.addEventListener('pointerdown', onLaneDown);

    row.appendChild(head);
    row.appendChild(lane);
    return row;
  }

  function clipEl(bi, ci, c, kind) {
    var b = document.createElement('div');
    b.className = 'tl-clip' + (sel.bi === bi && sel.ci === ci ? ' on' : '')
      + (c.mute ? ' mute' : '');
    b.setAttribute('data-ci', String(ci));
    b.style.setProperty('--c', COLOR[kind] || '#A7B7AD');
    var lab = document.createElement('span');
    lab.className = 'tl-clip-lab';
    b.appendChild(lab);
    /* 正在发声的小喇叭：默认隐藏，tick 里按拍位点亮 */
    var air = document.createElement('i');
    air.className = 'tl-air';
    air.setAttribute('aria-hidden', 'true');
    air.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor">'
      + '<path d="M4 9.4h3.1L12 5.5v13l-4.9-3.9H4z"/>'
      + '<path d="M15.3 8.4a5.3 5.3 0 0 1 0 7.2" fill="none" stroke="currentColor"'
      + ' stroke-width="1.7" stroke-linecap="round"/></svg>';
    b.appendChild(air);
    var l = document.createElement('i');
    l.className = 'tl-edge l';
    var r = document.createElement('i');
    r.className = 'tl-edge r';
    b.appendChild(l);
    b.appendChild(r);
    paintClip(b, c);
    return b;
  }

  function paintClip(node, c) {
    node.style.left = (c.from / LOOP * 100) + '%';
    node.style.width = Math.max(0.4, (c.to - c.from) / LOOP * 100) + '%';
    var lab = node.querySelector('.tl-clip-lab');
    if (lab) lab.textContent = beatText(c.from) + '–' + beatText(c.to);
  }

  function syncSelection() {
    var rows = el.rows.querySelectorAll('.tl-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('on', Number(rows[i].getAttribute('data-bi')) === sel.bi);
    }
    var clips = el.rows.querySelectorAll('.tl-clip');
    for (var k = 0; k < clips.length; k++) {
      var row = clips[k].parentNode;
      var hit = Number(row.getAttribute('data-bi')) === sel.bi
        && Number(clips[k].getAttribute('data-ci')) === sel.ci;
      clips[k].classList.toggle('on', hit);
    }
  }

  function selectClip(bi, ci) {
    sel = { bi: bi, ci: ci };
    syncSelection();
    buildBar();
  }

  function selectTrack(bi) {
    sel = { bi: bi, ci: -1 };
    syncSelection();
    buildBar();
    if (ctx.onSelectTrack) ctx.onSelectTrack(bi);
  }

  function laneOf(bi) {
    var lanes = el.rows.querySelectorAll('.tl-lane');
    for (var i = 0; i < lanes.length; i++) {
      if (Number(lanes[i].getAttribute('data-bi')) === bi) return lanes[i];
    }
    return null;
  }

  /* ---------- 拖动 / 裁剪 / 新建 ---------- */
  /* 落点落在哪一段里（半开区间），找不到返回 -1 */
  function hitOf(clips, b) {
    for (var i = 0; i < clips.length; i++) {
      if (b >= clips[i].from - 1e-6 && b < clips[i].to - 1e-6) return i;
    }
    return -1;
  }

  /* 没有命中元素时（点在片段上下的空白），按拍位算这个片段在屏幕上的横向范围 */
  function clipBox(laneRect, c) {
    var w = laneRect.width;
    return {
      left: laneRect.left + c.from / LOOP * w,
      right: laneRect.left + c.to / LOOP * w
    };
  }

  /* ---------- 跨轨拖动 ---------- */
  /* 拖动「整段移动」时，在轨道最下面临时摆一条虚线轨：拖到那儿 =
     用同一件乐器另起一轨，只放搬过去的那一段 */
  function ensureDropRow() {
    if (dropRow || mode === 'preview' || band().length >= MAX_TRACKS) return;
    var row = document.createElement('div');
    row.className = 'tl-row tl-row-new';
    row.setAttribute('data-bi', '-3');

    var head = document.createElement('div');
    head.className = 'tl-head';
    var name = document.createElement('b');
    name.className = 'tl-name';
    name.textContent = '＋ 新轨';
    head.appendChild(name);
    var kind = document.createElement('span');
    kind.className = 'tl-kind';
    kind.textContent = '松手另起一轨';
    head.appendChild(kind);

    var lane = document.createElement('div');
    lane.className = 'tl-lane';
    lane.setAttribute('data-bi', '-3');

    row.appendChild(head);
    row.appendChild(lane);
    /* 永远放在最后：拖动中插在中间会把别的轨顶下去，落点会跟着跳 */
    el.rows.appendChild(row);
    dropRow = row;
  }

  function removeDropRow() {
    var row = dropRow;
    dropRow = null;
    if (!row) return;
    try { row.parentNode.removeChild(row); } catch (e) {}
  }

  /* 指针落在哪条轨上：返回轨道下标；-3 = 新轨道；null = 这一带不收；
     undefined = 落在行与行的缝里，保持上一次的目标，免得来回抖 */
  function dropTargetAt(y, d) {
    if (d && d.bi === -1) return null;              /* 试听候选轨不参与跨轨 */
    var rows = el.rows.querySelectorAll('.tl-row');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      var bi = Number(rows[i].getAttribute('data-bi'));
      if (bi === -3) return mode === 'preview' ? null : -3;
      if (bi === -1) return null;                   /* 试听候选轨：不接收 */
      if (bi === -2) {
        /* 主旋律参考轨在最底下，当成「新轨道」的延伸区，往下拖不用绕过它 */
        return (mode === 'preview' || band().length >= MAX_TRACKS) ? null : -3;
      }
      return bi;
    }
    /* 所有轨道下面那一大片空区 = 另起一轨 */
    var box = el.rows.getBoundingClientRect();
    if (y > box.bottom) {
      if (mode === 'preview' || band().length >= MAX_TRACKS) return null;
      return -3;
    }
    return undefined;
  }

  /* 目标轨高亮：只标真正要接住这一段的那一条 */
  function markDrop(bi) {
    var rows = el.rows.querySelectorAll('.tl-row');
    for (var i = 0; i < rows.length; i++) {
      var b = Number(rows[i].getAttribute('data-bi'));
      var on = bi !== null && b === bi && !(bi >= 0 && drag && bi === drag.bi);
      rows[i].classList.toggle('tl-drop-on', on);
    }
  }

  /* 拖到屏幕上下边缘时滚轨道区，别让第 10 条轨拖不到 */
  function autoScroll(y) {
    var body = el.body;
    if (!body) return;
    var r = body.getBoundingClientRect();
    if (y < r.top + 34) body.scrollTop -= 12;
    else if (y > r.bottom - 34) body.scrollTop += 12;
  }

  function onLaneDown(e) {
    if (!opened || e.button === 2) return;
    var lane = e.currentTarget;
    var bi = Number(lane.getAttribute('data-bi'));
    if (bi < -1) return;                      /* 主旋律轨（-2）只读 */
    if (bi === -1 && mode !== 'preview') return;   /* -1 是试听候选那条临时轨 */
    var rect = lane.getBoundingClientRect();
    if (!rect.width) return;

    var clips = clipsOf(bi).map(function (c) {
      var o = { from: c.from, to: c.to };
      if (c.mute) o.mute = 1;
      if (c.notes) o.notes = c.notes.map(function (n) { return { b: n.b, d: n.d, m: n.m }; });
      return o;
    });
    var beat0 = U.clamp(snap((e.clientX - rect.left) / rect.width * LOOP), 0, LOOP);
    var d = {
      bi: bi, rect: rect, clips: clips, node: null, ci: -1,
      kind: 'blank', x0: e.clientX, y0: e.clientY,
      beat0: beat0, moved: false, next: null, from: 0, to: 0, dxAbs: 0,
      target: bi     /* 拖动中的落点轨：默认还是这一条，竖向移动才会换 */
    };

    /* 片段块只有 28px 高，点在它上下那几像素的空白里也要算「点中这一段」：
       先看命中的元素，没有命中就按拍位落点再找一次，都落空才是空白处新建 */
    var node = e.target.closest ? e.target.closest('.tl-clip') : null;
    var hit = (node && lane.contains(node)) ? node : null;
    var ci = hit ? Number(hit.getAttribute('data-ci')) : hitOf(clips, beat0);
    if (ci >= 0 && clips[ci]) {
      var c = clips[ci];
      var nr = hit ? hit.getBoundingClientRect() : clipBox(rect, c);
      var nearL = (e.clientX - nr.left) <= EDGE;
      var nearR = (nr.right - e.clientX) <= EDGE;
      d.ci = ci;
      d.node = hit;
      d.from = c.from;
      d.to = c.to;
      d.kind = (nearL && !nearR) ? 'trimL' : (nearR && !nearL ? 'trimR' : 'move');
      if (sel.bi !== bi || sel.ci !== ci) selectClip(bi, ci);
    }

    drag = d;
    try { lane.setPointerCapture(e.pointerId); } catch (err) {}
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragCancel);
    e.preventDefault();
  }

  /* 把被拖的那一段放进新位置：压到别的段就吃掉重叠的那一截（拖动的优先）。
     carry 是跨轨时从源轨带过来的那一段（idx 在目标轨里没有意义） */
  function placeClip(clips, idx, from, to, carry) {
    var out = [];
    for (var i = 0; i < clips.length; i++) {
      if (i === idx) continue;
      var c = clips[i];
      if (c.to <= from + 1e-6 || c.from >= to - 1e-6) {
        out.push(seg(c.from, c.to, c));
        continue;
      }
      if (c.from < from - 1e-6) out.push(seg(c.from, from, c));
      if (c.to > to + 1e-6) out.push(seg(to, c.to, c));
    }
    out.push(moveSeg(from, to, carry || clips[idx]));
    return U.normClips(out);
  }

  function computeNext(d, db) {
    var clips = d.clips;
    var c = clips[d.ci];
    if (!c) return null;
    if (d.kind === 'move') {
      var len = c.to - c.from;
      var from = U.clamp(c.from + db, 0, LOOP - len);
      return { next: placeClip(clips, d.ci, from, from + len), from: from, to: from + len };
    }
    if (d.kind === 'trimL') {
      var prevTo = d.ci > 0 ? clips[d.ci - 1].to : 0;
      var f = U.clamp(c.from + db, prevTo, c.to - U.MIN_CLIP);
      var a = clips.slice();
      a[d.ci] = seg(f, c.to, c);
      return { next: a, from: f, to: c.to };
    }
    if (d.kind === 'trimR') {
      var nextFrom = d.ci < clips.length - 1 ? clips[d.ci + 1].from : LOOP;
      var t = U.clamp(c.to + db, c.from + U.MIN_CLIP, nextFrom);
      var b = clips.slice();
      b[d.ci] = seg(c.from, t, c);
      return { next: b, from: c.from, to: t };
    }
    return null;
  }

  function onDragMove(e) {
    if (!drag) return;
    var dx = e.clientX - drag.x0;
    drag.dxAbs = Math.abs(dx);
    if (!drag.moved) {
      if (Math.abs(dx) < MIN_PX && Math.abs(e.clientY - drag.y0) < 6) return;
      drag.moved = true;
      if (drag.kind !== 'blank' && drag.node) drag.node.classList.add('dragging');
      if (drag.kind === 'blank') {
        var ghost = document.createElement('div');
        ghost.className = 'tl-clip ghost';
        ghost.style.setProperty('--c', '#8FAE8B');
        var lane = laneOf(drag.bi);
        if (lane) {
          lane.appendChild(ghost);
          drag.node = ghost;
        }
      } else if (drag.kind === 'move') {
        ensureDropRow();
      }
    }

    autoScroll(e.clientY);

    if (drag.kind === 'blank') {
      var at = U.clamp(snap((e.clientX - drag.rect.left) / drag.rect.width * LOOP), 0, LOOP);
      var from = Math.min(drag.beat0, at);
      var to = Math.max(drag.beat0, at);
      if (to - from < U.MIN_CLIP) to = Math.min(LOOP, from + U.MIN_CLIP);
      drag.from = from;
      drag.to = to;
      if (drag.node) paintClip(drag.node, { from: from, to: to });
      return;
    }

    /* 竖向拖到别的轨：目标轨跟着走，落点按目标轨的拍位算。
       试听候选轨（bi = -1）只在自己那条里挪，不参与跨轨 */
    if (drag.kind === 'move' && drag.bi >= 0) {
      var t = dropTargetAt(e.clientY, drag);
      if (t === null) t = drag.bi;      /* 落在不收的带子上 = 回原轨 */
      if (t !== undefined && t !== drag.target) {
        drag.target = t;
        drag.next = null;               /* 换了轨，原来那条轨的排布作废 */
        markDrop(t !== drag.bi ? t : null);
      }
    }

    var db = Math.round(dx / drag.rect.width * LOOP * 2) / 2;

    if (drag.kind === 'move' && drag.target !== drag.bi) {
      var host = laneOf(drag.target);
      if (!host) return;
      if (drag.node && drag.node.parentNode !== host) host.appendChild(drag.node);
      var c = drag.clips[drag.ci];
      if (!c) return;
      var len = c.to - c.from;
      var nf = U.clamp(snap(c.from + db), 0, LOOP - len);
      drag.from = nf;
      drag.to = nf + len;
      if (drag.node) paintClip(drag.node, { from: nf, to: nf + len });
      return;
    }

    /* 回到原来的轨：节点也挪回去，再按原轨的排布算 */
    if (drag.kind === 'move') {
      var home = laneOf(drag.bi);
      if (home && drag.node && drag.node.parentNode !== home) home.appendChild(drag.node);
    }

    var res = computeNext(drag, db);
    if (!res) return;
    drag.next = res.next;
    drag.from = res.from;
    drag.to = res.to;
    if (drag.node) paintClip(drag.node, res);
  }

  /* 手机竖滑被浏览器接管时会抛 pointercancel：这次拖动直接作废 */
  function onDragCancel() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragCancel);
    var d = drag;
    drag = null;
    removeDropRow();
    if (!d) return;
    if (d.node && d.node.classList) {
      d.node.classList.remove('dragging');
      if (d.node.classList.contains('ghost')) {
        try { d.node.parentNode.removeChild(d.node); } catch (err) {}
      }
    }
    refresh();
  }

  function onDragUp() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragCancel);
    var d = drag;
    drag = null;
    removeDropRow();
    if (!d) return;

    if (d.node && d.node.classList) {
      d.node.classList.remove('dragging');
      if (d.node.classList.contains('ghost')) {
        try { d.node.parentNode.removeChild(d.node); } catch (err) {}
      }
    }

    if (!d.moved) {
      /* 空白处点一下只选轨，不新建：删掉片段后顺手点一下空白，不该又长出一段 */
      if (d.kind === 'blank') selectTrack(d.bi);
      else selectClip(d.bi, d.ci);
      return;
    }
    if (d.kind === 'blank') {
      /* 空白处横向拖出一段才新建；只是点了 / 竖着滑一下都不算 */
      if ((d.dxAbs || 0) < NEW_PX) { selectTrack(d.bi); return; }
      if (d.clips.length >= U.MAX_CLIPS) {
        say('这一轨最多 ' + U.MAX_CLIPS + ' 段了');
        selectTrack(d.bi);
        return;
      }
      if (d.to - d.from < U.MIN_CLIP) { selectTrack(d.bi); return; }
      commit(d.bi, d.clips.concat([{ from: d.from, to: d.to }]), d.from, true);
      return;
    }
    if (d.kind === 'move' && d.target !== d.bi) { dropAcross(d); return; }
    /* 拖了半天还落在原来的格子上：不写数据，免得白重启一次音频 */
    if (d.next && !sameClips(d.next, d.clips)) commit(d.bi, d.next, d.from, false);
    else selectClip(d.bi, d.ci);
  }

  /* 松手在别的轨上：源轨留下其余段，目标轨接住这一段。
     数据由 app.js 一次写完（含原轨搬空就整轨收起），这里只负责算两侧的区间 */
  function dropAcross(d) {
    var carry = d.clips[d.ci];
    if (!carry) return;
    var target;
    if (d.target === -3) {
      if (band().length >= MAX_TRACKS) { say('最多 ' + MAX_TRACKS + ' 条轨，先删一条再开新的'); refresh(); return; }
      target = [moveSeg(d.from, d.to, carry)];
    } else {
      var list = clipsOf(d.target);
      if (list.length >= U.MAX_CLIPS) {
        say('目标轨已经 ' + U.MAX_CLIPS + ' 段了，先删一段再拖过来');
        refresh();
        return;
      }
      target = placeClip(list, -1, d.from, d.to, carry);
    }
    var left = U.normClips(d.clips.filter(function (c, i) { return i !== d.ci; }));
    var to = ctx.onMoveClip ? ctx.onMoveClip({
      fromBi: d.bi,
      toBi: d.target === -3 ? -1 : d.target,
      clips: left,
      target: target
    }) : -1;
    refresh();
    if (typeof to === 'number' && to >= 0) {
      var after = clipsOf(to);
      for (var i = 0; i < after.length; i++) {
        if (Math.abs(after[i].from - d.from) < 1e-6) { selectClip(to, i); break; }
      }
    }
  }

  function sameClips(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (Math.abs(a[i].from - b[i].from) > 1e-6) return false;
      if (Math.abs(a[i].to - b[i].to) > 1e-6) return false;
      if (!sameNotes(a[i].notes, b[i].notes)) return false;
    }
    return true;
  }

  function sameNotes(a, b) {
    a = a || []; b = b || [];
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (Math.abs(a[i].b - b[i].b) > 1e-6) return false;
      if (Math.abs(a[i].d - b[i].d) > 1e-6) return false;
      if (a[i].m !== b[i].m) return false;
    }
    return true;
  }

  /* ---------- 写回 ---------- */
  /* 只有「新建片段」才带播放头与自动播放；裁剪 / 分割 / 步进都不动播放位置，
     否则正在听的时候一改片段就跳回开头 */
  function commit(bi, next, focusFrom, autoplay) {
    var list = U.normClips(next);
    if (!list.length) {
      removeTrack(bi);
      return;
    }
    var opts = autoplay ? { seek: focusFrom, play: true } : null;
    if (ctx.onChange) ctx.onChange(bi, list, opts);
    if (!opened) return;
    var after = clipsOf(bi);
    var ci = -1;
    for (var i = 0; i < after.length; i++) {
      if (Math.abs(after[i].from - focusFrom) < 1e-6) { ci = i; break; }
    }
    if (ci < 0 && after.length) ci = 0;
    sel = { bi: bi, ci: ci };
    refresh();
  }

  function removeTrack(bi) {
    if (bi === -1) {
      /* 试听轨不能删：删最后一段就是回到整段 */
      if (ctx.onChange) ctx.onChange(-1, [{ from: 0, to: LOOP }], { seek: 0, play: false });
      if (!opened) return;
      sel = { bi: -1, ci: 0 };
      refresh();
      return;
    }
    if (ctx.onDeleteTrack) ctx.onDeleteTrack(bi);
    if (!opened) return;
    /* 后面的下标整体前移：落到相邻那一条上，别留一个空选中 */
    var left = band().length;
    sel = { bi: left ? Math.min(bi, left - 1) : -1, ci: -1 };
    refresh();
  }

  /* ---------- 底部操作条 ---------- */
  function buildBar() {
    el.bar.innerHTML = '';
    splitBtn = null;
    liveHint = null;

    var it = itemOf(sel.bi);
    var clips = (sel.bi !== -1 || mode === 'preview') ? clipsOf(sel.bi) : [];
    var clip = (sel.ci >= 0 && clips[sel.ci]) ? clips[sel.ci] : null;
    var isStatic = !!(it && (it.k === 'voice' || it.k === 'amb'));

    if (mode === 'preview') {
      var pr = line('tl-bar-preview');
      var tag = document.createElement('span');
      tag.className = 'tl-bar-tag';
      tag.textContent = '试听中 · ' + (it ? (L.TIMBRE.nameOf(it.k, it.id) || '这一件') : '这一件');
      pr.appendChild(tag);
      var gap = document.createElement('span');
      gap.className = 'tl-bar-gap';
      pr.appendChild(gap);
      pr.appendChild(button('取消', 'tl-btn soft', function () {
        if (ctx.onCancel) ctx.onCancel();
      }));
      pr.appendChild(button('加入乐队', 'tl-btn primary', function () {
        if (ctx.onJoin) ctx.onJoin();
      }));
      el.bar.appendChild(pr);
    }

    if (!it) {
      var hint = line();
      var h = document.createElement('span');
      h.className = 'tl-bar-hint';
      h.textContent = '点一条轨道开始调';
      hint.appendChild(h);
      el.bar.appendChild(hint);
      return;
    }

    if (clip) {
      el.bar.appendChild(stepsLine(clip));
      el.bar.appendChild(actionLine(clip));
      el.bar.appendChild(listenLine(clip));
    } else {
      var hint2 = line();
      var h2 = document.createElement('span');
      h2.className = 'tl-bar-hint';
      h2.textContent = '点一个片段调整，或在空白处横向拖一下新建一段';
      hint2.appendChild(h2);
      el.bar.appendChild(hint2);
    }

    el.bar.appendChild(trackLine(it, isStatic));
  }

  function stepsLine(clip) {
    var row = line('tl-bar-steps');
    row.appendChild(stepGroup('起点', 'from', clip));
    row.appendChild(stepGroup('终点', 'to', clip));
    var seg = document.createElement('div');
    seg.className = 'seg tl-seg';
    [{ v: 0.5, n: '½ 拍' }, { v: 1, n: '1 拍' }].forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = step === o.v ? 'on' : '';
      b.textContent = o.n;
      b.addEventListener('click', function () {
        if (step === o.v) return;
        step = o.v;
        buildBar();
      });
      seg.appendChild(b);
    });
    row.appendChild(seg);

    /* 整段前后挪：长度不变，被邻段与 0~16 拍夹住 */
    var mv = document.createElement('div');
    mv.className = 'tl-stepgrp tl-movegrp';
    var mk = document.createElement('span');
    mk.className = 'tl-bar-k';
    mk.textContent = '整段';
    mv.appendChild(mk);
    var back = button('←', 'tl-btn tiny', function () { moveClip(-step); });
    back.setAttribute('data-move', '-1');
    back.setAttribute('aria-label', '把整段往前挪');
    mv.appendChild(back);
    var fwd = button('→', 'tl-btn tiny', function () { moveClip(step); });
    fwd.setAttribute('data-move', '1');
    fwd.setAttribute('aria-label', '把整段往后挪');
    mv.appendChild(fwd);
    row.appendChild(mv);
    return row;
  }

  function stepGroup(label, end, clip) {
    var g = document.createElement('div');
    g.className = 'tl-stepgrp';
    g.setAttribute('data-end', end);
    var k = document.createElement('span');
    k.className = 'tl-bar-k';
    k.textContent = label;
    g.appendChild(k);
    var minus = button('−', 'tl-btn tiny', function () { nudge(end, -step); });
    minus.setAttribute('data-dir', '-1');
    g.appendChild(minus);
    var v = document.createElement('b');
    v.className = 'tl-val';
    v.textContent = beatText(end === 'from' ? clip.from : clip.to);
    g.appendChild(v);
    var plus = button('＋', 'tl-btn tiny', function () { nudge(end, step); });
    plus.setAttribute('data-dir', '1');
    g.appendChild(plus);
    return g;
  }

  /* 整段平移：只改起点、终点跟着走，长度与静音标记都不动。
     前边界是上一段的终点，后边界是下一段的起点，再夹进 0~16 拍 */
  function moveClip(d) {
    var clips = clipsOf(sel.bi);
    var c = clips[sel.ci];
    if (!c) return;
    var len = c.to - c.from;
    var prev = sel.ci > 0 ? clips[sel.ci - 1].to : 0;
    var next = sel.ci < clips.length - 1 ? clips[sel.ci + 1].from : LOOP;
    var hi = Math.max(prev, next - len);
    var from = U.clamp(snap(c.from + d), prev, hi);
    if (Math.abs(from - c.from) < 1e-6) {
      say(d > 0 ? '再往后就压到下一段了' : '再往前就压到上一段了');
      return;
    }
    var list = clips.slice();
    list[sel.ci] = moveSeg(from, from + len, c);
    commit(sel.bi, list, list[sel.ci].from, false);
  }

  function nudge(end, d) {
    var clips = clipsOf(sel.bi);
    var c = clips[sel.ci];
    if (!c) return;
    var prev = sel.ci > 0 ? clips[sel.ci - 1].to : 0;
    var next = sel.ci < clips.length - 1 ? clips[sel.ci + 1].from : LOOP;
    var list = clips.slice();
    if (end === 'from') {
      var f = U.clamp(snap(c.from + d), prev, c.to - U.MIN_CLIP);
      list[sel.ci] = seg(f, c.to, c);
    } else {
      var t = U.clamp(snap(c.to + d), c.from + U.MIN_CLIP, next);
      list[sel.ci] = seg(c.from, t, c);
    }
    commit(sel.bi, list, list[sel.ci].from, false);
  }

  /* 造一段，顺带把静音标记带过去（拖动 / 分割 / 步进不该悄悄取消静音）。
     lead 片段的音符也跟着走：切割取落在 [from,to) 内的音，平移则整体搬。 */
  function seg(from, to, src) {
    var o = { from: from, to: to };
    if (src && src.mute) o.mute = 1;
    if (src && src.notes && src.notes.length) {
      var abs = src.notes.map(function (n) { return { b: src.from + n.b, d: n.d, m: n.m }; });
      var ns = U.sliceNotes(abs, from, to);
      if (ns.length) o.notes = ns;
    }
    return o;
  }

  /* 平移一整段：区间换位置，音符相对坐标不变（内容跟着走），时值截到新段长 */
  function moveSeg(from, to, src) {
    var o = { from: from, to: to };
    if (src && src.mute) o.mute = 1;
    if (src && src.notes && src.notes.length) {
      var len = to - from;
      var ns = [];
      src.notes.forEach(function (n) {
        if (n.b >= len - 1e-6) return;
        var d = Math.min(n.d, len - n.b);
        if (d < 1e-6) return;
        ns.push({ b: n.b, d: d, m: n.m });
      });
      if (ns.length) o.notes = ns;
    }
    return o;
  }

  function actionLine(clip) {
    var row = line('tl-bar-acts');
    var sp = button('分割', 'tl-btn soft', doSplit);
    sp.disabled = !canSplit(nowBeat());
    splitBtn = sp;
    row.appendChild(sp);

    row.appendChild(button('删除', 'tl-btn soft danger', doDelete));
    row.appendChild(button('整段', 'tl-btn soft', function () {
      commit(sel.bi, [{ from: 0, to: LOOP }], 0, false);
    }));
    row.appendChild(button('复制', 'tl-btn soft', doCopy));
    row.appendChild(button('剪切', 'tl-btn soft', doCut));

    var paste = button('粘贴', 'tl-btn soft', doPaste);
    paste.setAttribute('data-act', 'paste');
    paste.disabled = !clipboard;
    row.appendChild(paste);

    /* 片段级静音：只影响本机试听（和轨道静音分开，别混成一个开关） */
    var cm = button(clip.mute ? '片段出声' : '片段静音',
      'tl-btn soft' + (clip.mute ? ' on' : ''), doMuteClip);
    cm.setAttribute('data-act', 'mute-clip');
    row.appendChild(cm);
    return row;
  }

  /* 三种试听口径，别混：
     「循环这段」= 只循环这一个片段（引擎把循环窗口收到段长）；
     「整轨循环」= 整条轨按 16 拍整圈走，它所有的段照常进出；
     「这段全部」= 循环窗口同样是这一段，但整支乐队一起响（静音的轨自己跳过） */
  function listenLine(clip) {
    var row = line('tl-bar-listen');
    var onClip = !!(ctx.isAudition && ctx.isAudition(sel.bi, 'clip'));
    var onTrack = !!(ctx.isAudition && ctx.isAudition(sel.bi, 'track'));
    var onSec = !!(ctx.isAudition && ctx.isAudition(sel.bi, 'section'));

    var k = document.createElement('span');
    k.className = 'tl-bar-k';
    k.textContent = '试听';
    row.appendChild(k);

    var bClip = button(onClip ? '停止' : '循环这段',
      'tl-btn ' + (onClip ? 'primary' : 'soft'), function () {
        if (ctx.onAudition) ctx.onAudition(sel.bi, { from: clip.from, to: clip.to });
        refresh();
      });
    bClip.setAttribute('data-act', 'loop-clip');
    row.appendChild(bClip);

    var bTrack = button(onTrack ? '停止' : '整轨循环',
      'tl-btn ' + (onTrack ? 'primary' : 'soft'), function () {
        if (ctx.onAuditionTrack) ctx.onAuditionTrack(sel.bi);
        refresh();
      });
    bTrack.setAttribute('data-act', 'loop-track');
    row.appendChild(bTrack);

    var bSec = button(onSec ? '停止' : '这段全部',
      'tl-btn ' + (onSec ? 'primary' : 'soft'), function () {
        if (ctx.onAuditionSection) ctx.onAuditionSection(sel.bi, { from: clip.from, to: clip.to });
        refresh();
      });
    bSec.setAttribute('data-act', 'loop-section');
    bSec.setAttribute('aria-label', '这一段里所有没静音的轨一起循环');
    row.appendChild(bSec);

    var hint = document.createElement('span');
    hint.className = 'tl-bar-hint';
    hint.textContent = onClip ? '这一段在循环'
      : (onTrack ? '整条轨在循环'
        : (onSec ? '这一段所有轨一起循环' : ''));
    row.appendChild(hint);

    /* 实时提示：正在响哪一段 / 这一段是空档（tick 里更新，不重建 DOM） */
    var live = document.createElement('span');
    live.className = 'tl-bar-hint tl-live';
    row.appendChild(live);
    liveHint = live;
    return row;
  }

  function canSplit(b) {
    var clips = clipsOf(sel.bi);
    var c = clips[sel.ci];
    if (!c) return false;
    b = snap(b);
    return b > c.from + 1e-6 && b < c.to - 1e-6;
  }

  function doSplit() {
    var clips = clipsOf(sel.bi);
    var c = clips[sel.ci];
    if (!c) return;
    var at = snap(nowBeat());
    if (at <= c.from + 1e-6 || at >= c.to - 1e-6) {
      say('播放头要落在这一段里面才能分割');
      return;
    }
    var list = clips.slice();
    list.splice(sel.ci, 1, seg(c.from, at, c), seg(at, c.to, c));
    commit(sel.bi, list, c.from, false);
  }

  function doDelete() {
    var clips = clipsOf(sel.bi);
    if (!clips[sel.ci]) return;
    var list = clips.filter(function (c, i) { return i !== sel.ci; });
    commit(sel.bi, list, list.length ? list[0].from : 0, false);
  }

  function doCopy() {
    var clips = clipsOf(sel.bi);
    var c = clips[sel.ci];
    if (!c) return;
    clipboard = { from: c.from, to: c.to, mute: c.mute, notes: c.notes };
    say('复制了一段 ' + (c.to - c.from).toFixed(1) + ' 拍，点轨道后可以粘贴');
    refresh();
  }

  function doCut() {
    var clips = clipsOf(sel.bi);
    var c = clips[sel.ci];
    if (!c) return;
    clipboard = { from: c.from, to: c.to, mute: c.mute, notes: c.notes };
    var list = clips.filter(function (x, i) { return i !== sel.ci; });
    say('剪切走了一段 ' + (c.to - c.from).toFixed(1) + ' 拍');
    commit(sel.bi, list, c.from, false);
  }

  function doPaste() {
    if (!clipboard) return;
    var bi = sel.bi;
    if (bi < 0 && mode !== 'preview') {
      say('先点一条轨道，再粘贴');
      return;
    }
    var list = clipsOf(bi);
    var len = Math.max(U.MIN_CLIP, clipboard.to - clipboard.from);
    var gap = freeGap(list, snap(nowBeat()), len);
    if (!gap) {
      say('这里放不下 ' + len.toFixed(1) + ' 拍，先把后面的片段挪开');
      return;
    }
    /* 粘贴 = 内容原样搬：音符相对坐标不变，时值截到粘贴后的段长 */
    var pasted = { from: gap.from, to: gap.to };
    if (clipboard.mute) pasted.mute = 1;
    if (clipboard.notes && clipboard.notes.length) {
      var plen = gap.to - gap.from;
      var pn = [];
      clipboard.notes.forEach(function (n) {
        if (n.b >= plen - 1e-6) return;
        var d = Math.min(n.d, plen - n.b);
        if (d < 1e-6) return;
        pn.push({ b: n.b, d: d, m: n.m });
      });
      if (pn.length) pasted.notes = pn;
    }
    commit(bi, list.concat([pasted]), gap.from, true);
  }

  /* 从播放头往后找第一个放得下 len 拍的空档 */
  function freeGap(clips, at, len) {
    var sorted = U.normClips(clips);
    var cursor = U.clamp(at, 0, LOOP);
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      if (c.to <= cursor + 1e-6) continue;
      if (c.from >= cursor + len - 1e-6) break;
      cursor = c.to;
    }
    var to = Math.min(LOOP, cursor + len);
    if (to - cursor < U.MIN_CLIP - 1e-6) return null;
    return { from: cursor, to: to };
  }

  function doMuteClip() {
    var clips = clipsOf(sel.bi);
    var c = clips[sel.ci];
    if (!c) return;
    var list = clips.slice();
    var one = seg(c.from, c.to, c);
    if (!c.mute) one.mute = 1;
    list[sel.ci] = one;
    say(c.mute ? '这一段又出声了' : '这一段单独静音（只在这台设备上）');
    commit(sel.bi, list, c.from, false);
  }

  function trackLine(it, isStatic) {
    var row = line('tl-bar-track');
    /* 整轨静音：暂时不想听到这一轨时点这里（和片段静音分开，只在本机生效） */
    if (sel.bi >= 0) {
      var mute = button(it.mute ? '这一轨出声' : '静音这一轨',
        'tl-btn soft' + (it.mute ? ' on' : ''), function () {
          if (ctx.onToggleMute) ctx.onToggleMute(sel.bi);
          refresh();
        });
      mute.setAttribute('data-act', 'mute-track');
      mute.setAttribute('aria-label', it.mute ? '取消静音这一轨' : '静音这一轨');
      row.appendChild(mute);
    }
    if (!isStatic) {
      var lab = document.createElement('span');
      lab.className = 'tl-bar-k';
      lab.textContent = '律动';
      row.appendChild(lab);
      var rate = U.bandRate(it);
      [{ v: 0.5, n: '慢一半' }, { v: 1, n: '标准' }, { v: 2, n: '快一倍' }].forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'tl-chip' + (rate === o.v ? ' on' : '');
        b.setAttribute('data-rate', String(o.v));
        b.textContent = o.n;
        b.addEventListener('click', function () {
          if (ctx.onRate) ctx.onRate(sel.bi, o.v);
          refresh();
        });
        row.appendChild(b);
      });
    }

    var kl = document.createElement('span');
    kl.className = 'tl-bar-k';
    kl.textContent = '调性';
    row.appendChild(kl);
    var kd = button('−', 'tl-btn tiny', function () {
      if (ctx.onKey) ctx.onKey(-1);
      refresh();
    });
    kd.setAttribute('data-key-dir', '-1');
    row.appendChild(kd);
    var kv = document.createElement('b');
    kv.className = 'tl-key';
    var song = ctx.song || {};
    kv.textContent = (L.C.PCN_CN[song.tonic] || 'C') + (song.mode === 'major' ? ' 大调' : ' 小调');
    row.appendChild(kv);
    var ku = button('＋', 'tl-btn tiny', function () {
      if (ctx.onKey) ctx.onKey(1);
      refresh();
    });
    ku.setAttribute('data-key-dir', '1');
    row.appendChild(ku);
    return row;
  }

  /* ---------- 播放头 ---------- */
  function measure() {
    if (!opened || !el.grid) return;
    var w = el.grid.clientWidth || 0;
    if (!w) return;
    gridW = w;
    laneW = Math.max(1, w - HEAD_W);
  }

  function placePlayhead(b) {
    if (!el.ph) return;
    if (!laneW) measure();
    var x = HEAD_W + U.clamp(b, 0, LOOP) / LOOP * laneW;
    /* 最后一拍别顶出 1px 撑出横向滚动条 */
    if (gridW) x = Math.min(x, gridW - 1);
    el.ph.style.transform = 'translateX(' + x.toFixed(1) + 'px)';
  }

  function tick(b) {
    if (!opened) return;
    if (scrub) b = scrub.beat;
    if (typeof b !== 'number' || !isFinite(b)) b = 0;
    b = b % LOOP;
    if (b < 0) b += LOOP;
    placePlayhead(b);
    paintAir(b);
    if (splitBtn) splitBtn.disabled = !canSplit(b);
    var play = isPlaying();
    if (play !== lastPlaying) {
      lastPlaying = play;
      if (el.play) {
        el.play.textContent = play ? '暂停' : '播放';
        el.play.classList.toggle('on', play);
      }
    }
    el.root.classList.toggle('playing', play);
  }

  /* 哪一段正在发声：播放头落在「未静音」的片段里就点亮小喇叭。
     单独试听时只有那一条轨在响，别的轨一律不亮；
     「循环这段」的循环窗口就是这一段，整段都会亮。
     顺带把「正在响 x–y 拍 / 这一段是空档」写到底部提示里，
     整轨循环里片段与片段之间没声音时一眼能看出来。 */
  function paintAir(b) {
    var playing = isPlaying();
    var aud = (playing && ctx && ctx.audition) ? ctx.audition() : null;
    /* 「这段全部」是整队一起响，所有轨都该亮；另外两种只亮试听的那一条 */
    var scope = (aud && aud.mode !== 'section') ? aud.bi : null;
    var shown = '';
    for (var i = 0; i < clipNodes.length; i++) {
      var one = clipNodes[i];
      var on = false;
      if (playing && !one.c.mute) {
        var it = itemOf(one.bi);
        if (it && !it.mute && (scope === null || scope === one.bi)) {
          on = b >= one.c.from - 1e-6 && b < one.c.to - 1e-6;
        }
      }
      if (on && aud) shown = beatText(one.c.from) + '–' + beatText(one.c.to);
      if (on !== one.air) {
        one.air = on;
        one.node.classList.toggle('air', on);
      }
    }
    if (!liveHint) return;
    var text = '';
    if (playing && aud) {
      if (aud.full) text = '整段在循环 · 片段暂时没排上音';
      else if (aud.mode === 'section') {
        text = '所有轨在循环 ' + beatText(aud.from) + '–' + beatText(aud.to) + ' 拍';
      } else {
        text = shown ? '正在响 ' + shown + ' 拍' : '这一段是空档，没有声音';
      }
    }
    if (liveHint.textContent !== text) liveHint.textContent = text;
  }

  function refresh() {
    if (!opened) return;
    var song = ctx.song || {};
    if (el.meta) {
      el.meta.textContent = (L.C.PCN_CN[song.tonic] || 'C')
        + (song.mode === 'major' ? ' 大调' : ' 小调')
        + ' · ' + (song.bpm || L.C.BPM) + ' BPM'
        + (mode === 'preview' ? ' · 试听中' : '');
    }
    if (el.play) {
      el.play.textContent = isPlaying() ? '暂停' : '播放';
      el.play.classList.toggle('on', isPlaying());
    }
    if (el.done) el.done.textContent = mode === 'preview' ? '加入' : '完成';
    buildRuler();
    buildRows();
    buildBar();
    measure();
    tick(nowBeat());
  }

  /* ---------- 对外 ---------- */
  function open(c) {
    if (!mount()) return;
    ctx = c || {};
    mode = ctx.preview ? 'preview' : 'edit';
    step = 0.5;
    drag = null;
    scrub = null;
    lastPlaying = null;
    opened = true;
    el.root.classList.add('open');
    el.root.classList.toggle('previewing', mode === 'preview');
    el.root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('tl-lock');

    if (mode === 'preview') {
      sel = { bi: -1, ci: 0 };
    } else {
      var bi = (typeof ctx.bi === 'number') ? ctx.bi : 0;
      if (bi >= 0 && band()[bi]) sel = { bi: bi, ci: 0 };
      else if (band().length) sel = { bi: 0, ci: 0 };
      else sel = { bi: -1, ci: -1 };
    }
    refresh();
  }

  function close() {
    if (!opened) return;
    opened = false;
    drag = null;
    scrub = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragCancel);
    window.removeEventListener('pointermove', onRulerMove);
    window.removeEventListener('pointerup', onRulerUp);
    window.removeEventListener('pointercancel', onRulerUp);
    if (el.root) {
      el.root.classList.remove('open');
      el.root.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('tl-lock');
  }

  L.TIMELINE = {
    open: open,
    close: close,
    refresh: refresh,
    tick: tick,
    isOpen: function () { return opened; }
  };
})();
