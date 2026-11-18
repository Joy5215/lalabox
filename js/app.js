/* ============================================================
 * app.js — 状态机与界面逻辑
 * 依赖：utils / bridge / arrange / codec / analyze / compose / engine / draw
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var U = L.util, C = L.C;
  var Bridge = L.Bridge, ENG = L.ENG, DRAW = L.DRAW, DIAG = L.DIAG;
  var ANALYZE = L.ANALYZE, CODEC = L.CODEC, COMPOSE = L.COMPOSE;
  var TIMBRE = L.TIMBRE, GROOVE = L.GROOVE;

  var $ = U.$;
  var $$ = U.$$;
  var SPB = C.SPB;

  /* ?debug=1：把这次录音的 PCM 与识别结果 POST 给 tools/dump-server.js。
     手机浏览器没有 devtools，识别准不准只能把真实录音捞回电脑离线复跑 */
  var DEBUG_DUMP = /[?&]debug=1/.test(location.search);

  /* 页面一打开就打一声招呼：能在 dump-server 日志里看到，说明反向通道是通的 */
  if (DEBUG_DUMP) {
    try {
      fetch('http://localhost:8099/hello?ua=' + encodeURIComponent(navigator.userAgent.slice(0, 60)),
        { method: 'POST', body: 'hello' }).catch(function () {});
    } catch (e) { /* 通道没起来也不该挡住页面 */ }
  }

  var state = {
    screen: 'idle', song: null, playing: false,
    works: [], micBusy: false, posterUrl: '', lastCode: '',
    voiceBuf: null, voiceStart: 0, timbre: 'soft', voiceFx: 'raw',
    /* 播放头停在第几拍：暂停时记下、时间线拖动时改它，播放一律从这里起 */
    seekBeat: 0,
    /* 录音有两条去向：main = 首页哼唱出整首歌；band = 乐队面板里现录一层人声 */
    recMode: 'main',
    degreeText: ''
  };
  var rec = null;

  /* ---------- DOM ---------- */
  var elMic = $('#btnMic');
  var elMicLabel = $('#micLabel');
  var elRecCount = $('#recCount');
  var elRecHint = $('#recHint');
  var elCvRec = $('#cvRec');
  var elLevelWrap = $('#levelWrap');
  var elLevelBar = $('#levelBar');
  var elBeatLights = $$('#beatLights i');
  var elCvMelody = $('#cvMelody');
  var elCvBand = $('#cvBand');
  var elVoices = $('#voiceList');
  var elFxRow = $('#voiceFxRow');
  var elBandList = $('#bandList');
  var elBandAdd = $('#bandAdd');
  var elBandTabs = $('#bandTabs');
  var btnPlay = $('#btnPlay');
  var resultScreen = $('.screen[data-screen="result"]');

  /* ---------- 通用 UI ---------- */
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, ms || 2200);
  }

  function setScreen(name) {
    state.screen = name;
    $$('.screen').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-screen') === name);
    });
    $$('.dock-group').forEach(function (el) {
      el.classList.toggle('hide', el.getAttribute('data-dock') !== name);
    });
  }

  function keyName(song) {
    return C.PCN_CN[song.tonic] + (song.mode === 'major' ? ' 大调' : ' 小调');
  }

  /* ---------- 结果态 ---------- */
  function playOpts() {
    return {
      timbre: state.timbre,
      voiceBuf: state.voiceBuf, voiceStart: state.voiceStart,
      voiceFx: state.voiceFx,
      voiceDur: C.BEATS * SPB,
      /* 整首变调后，录音也跟着改速率，免得人声和伴奏打架 */
      voiceRate: Math.pow(2, ((state.song && state.song.shift) || 0) / 12),
      /* 从播放头这一拍起播：时间线上点哪里就从哪里开始 */
      seekBeat: state.seekBeat || 0
    };
  }

  /* 换歌时把上一次的录音丢掉；主音色还停在「原声」的话要回落到合成音，
     否则这次没有人声、也没有合成主旋律，等于没声音 */
  function dropVoice() {
    state.voiceBuf = null;
    state.voiceStart = 0;
    if (state.timbre === 'voice') {
      state.timbre = 'soft';
      state.voiceFx = 'raw';
    }
  }

  /* 可选主音：原声 + 几种常见乐器 */
  var VOICE_UI = [
    { k: 'voice', n: '我的原声', s: '你哼的那一版' },
    { k: 'piano', n: '钢琴', s: '干净的颗粒感' },
    { k: 'guitar', n: '木吉他', s: '拨弦的木头味' },
    { k: 'guzheng', n: '古筝', s: '亮，带一点揉弦' },
    { k: 'soft', n: '柔和合成', s: '带一点颤音' },
    { k: 'flute', n: '笛子', s: '气声多一点' },
    { k: 'chip', n: '8-bit', s: '像素游戏味' }
  ];

  /* 人声效果：值必须和 engine.js 里 voiceChain / renderSong 认的 key 一致 */
  var VOICE_FX = [
    { k: 'raw', n: '原声' },
    { k: 'octave', n: '八度' },
    { k: 'tune', n: '电音' },
    { k: 'reverb', n: '混响' },
    { k: 'delay', n: '延迟' }
  ];
  var FX_NAME = {};
  VOICE_FX.forEach(function (f) { FX_NAME[f.k] = f.n; });

  function vocalName(fx) {
    return FX_NAME[fx] || FX_NAME.raw;
  }

  /* 效果只叠在「我的原声」上，合成音色自己就是成品 */
  function buildFxRow() {
    if (!elFxRow) return;
    elFxRow.innerHTML = '';
    VOICE_FX.forEach(function (f) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (f.k === state.voiceFx ? ' on' : '');
      chip.textContent = f.n;
      chip.addEventListener('click', function () {
        if (state.voiceFx === f.k) return;
        state.voiceFx = f.k;
        buildFxRow();
        buildVoices();
        if (state.timbre !== 'voice' || !state.voiceBuf) return;
        ENG.stop();
        state.playing = false;
        syncPlayBtn();
        ENG.previewVoice('voice', state.song && U.leadNotes(state.song), state.voiceBuf,
          state.voiceStart, state.voiceFx);
      });
      elFxRow.appendChild(chip);
    });
  }

  function buildVoices() {
    if (!elVoices) return;
    elVoices.innerHTML = '';
    VOICE_UI.forEach(function (v) {
      var missed = v.k === 'voice' && !state.voiceBuf;
      var sub = v.s;
      if (v.k === 'voice' && state.voiceFx !== 'raw') sub = '人声 · ' + vocalName(state.voiceFx);
      var b = document.createElement('button');
      b.className = 'voice' + (v.k === state.timbre ? ' on' : '') + (missed ? ' off' : '');
      b.innerHTML = '<b>' + v.n + '</b><span>' + (missed ? '这次没留下原声' : sub) + '</span>';
      b.addEventListener('click', function () {
        if (missed) { toast('这次没留下原声，换个音色吧', 2400); return; }
        setLeadVoice(v.k);
        $$('.voice', elVoices).forEach(function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        ENG.stop();
        state.playing = false;
        syncPlayBtn();
        ENG.previewVoice(v.k, state.song && U.leadNotes(state.song), state.voiceBuf,
          state.voiceStart, state.voiceFx);
      });
      elVoices.appendChild(b);
    });
  }

  function openVoicePicker(autoplay) {
    state.pendingAutoplay = autoplay !== false;
    buildFxRow();
    buildVoices();
    ENG.stop();
    state.playing = false;
    syncPlayBtn();
    openSheet('#sheetVoice');
  }

  function applyVoice() {
    closeSheets();
    ENG.stopPreview();
    if (!state.song || !state.pendingAutoplay) { syncPlayBtn(); return; }
    state.playing = true;
    ENG.play(state.song, playOpts());
    syncPlayBtn();
  }

  /* ---------- 你的乐队 ---------- */
  /* 乐器清单存在 song.band 上，同一层可以叠多件；曲调（心情 + 种子）属于每一件乐器自己。
     面板两栏：已经加上的（点一行换它的曲调）/ 添加乐器。
     song.mood 与 song.seeds 只为老数据与老链接保留，是缺字段时的回落值。 */
  /* 默认全部收起：先看到一排家族，点哪个才展开哪个。
     previewSel 是当前正在试听的那一件，加入乐队要另外点按钮。
     openRowIdx 是当前展开的那一行（曲调 + 片段区间），同时只展开一件，-1 表示全收起 */
  var openFamily = '';
  var previewSel = null;
  var openRowIdx = -1;
  /* 面板顶部两个页签：乐器 / 氛围。入口都是结果页的 ＋，进来先落在乐器 */
  var bandTab = 'inst';

  /* 当前该画到第几拍：播放时跟指针走，暂停时停在播放头 */
  function nowBeat() {
    return state.playing ? ENG.beatPos() : (state.seekBeat || 0);
  }

  function timelineOpen() {
    return !!(L.TIMELINE && L.TIMELINE.isOpen && L.TIMELINE.isOpen());
  }

  function bandOf() {
    if (!state.song) return [];
    if (!state.song.band) state.song.band = [];
    return state.song.band;
  }

  function moodOf() {
    if (!state.song) return GROOVE.feelDefaults();
    if (!state.song.mood) state.song.mood = state.song.feel || GROOVE.feelDefaults();
    return state.song.mood;
  }

  /* 新乐器的默认曲调：沿用老数据的全队心情，没有就是「晴天」 */
  function teamMood() {
    var m = moodOf();
    return m.chord || m.drums || m.bass || '晴天';
  }

  function instrumentNames(limit) {
    var names = [];
    bandOf().forEach(function (it) {
      var n = TIMBRE.nameOf(it.k, it.id);
      if (n && names.indexOf(n) < 0) names.push(n);
    });
    return limit ? names.slice(0, limit) : names;
  }

  /* 从播放头起播：整队、或正在试听时用候选那一条临时 Song */
  function startPlaying() {
    if (!state.song) return;
    clearAudition();         /* 正常播放接管试听位；ENG.play 会把那条临时音轨换掉 */
    state.playing = true;
    if (previewSel) { playPreview(); return; }
    ENG.play(state.song, playOpts());
    syncPlayBtn();
  }

  /* ---------- 单独试听：这一段 / 这一轨 / 这一段的所有轨 ----------
     三种口径别混：
       mode 'clip'    = 只循环**这一个片段**（引擎按 loop 窗口循环，圈长就是段长）
       mode 'track'   = 整条轨按 16 拍整圈循环，它所有的段都照常进出
       mode 'section' = 这一段的时长里，**所有没静音的轨**一起循环（听这一段配器）
     clip / track 只把这一件放进临时 Song；section 用整支乐队。都不写 song.band，
     再点同一个按钮即停 */
  var audition = null;

  function auditionOn(bi, mode) {
    return !!(audition && audition.bi === bi && audition.mode === mode);
  }
  function clearAudition() { audition = null; }

  function endAudition() {
    if (!audition) return;
    var from = audition.from;
    audition = null;
    ENG.stop();
    state.playing = false;
    state.seekBeat = from;
    syncPlayBtn();
    if (timelineOpen()) L.TIMELINE.refresh();
  }

  function auditionItem(src) {
    var one = { k: src.k, id: src.id, vol: src.vol === undefined ? 0.8 : src.vol };
    if (src.mood) one.mood = src.mood;
    if (src.seed) one.seed = src.seed;
    if (src.rate) one.rate = src.rate;
    return one;
  }

  function startAudition(bi, mode, clip) {
    var song = state.song;
    if (!song) return;
    var src = bi === -1 ? (previewSel && previewAsItem()) : bandOf()[bi];
    if (!src) return;
    var loop = null;
    var start = 0;
    var one = null;
    if (mode === 'clip') {
      if (!clip) return;
      one = auditionItem(src);
      one.clips = [{ from: clip.from, to: clip.to }];
      loop = { from: clip.from, to: clip.to };
      start = clip.from;
    } else if (mode === 'track') {
      /* 整轨：静音的段仍然跳过，剩下的段照常进出。
         起播点放在第一段开头 —— 片段不在 0 拍时从 0 起播会先静好几秒，
         听起来就像「整轨循环没出声」 */
      var live = U.bandClips(src).filter(function (c) { return !c.mute; });
      if (!live.length) { toast('这一轨的片段都静音了', 1600); return; }
      one = auditionItem(src);
      one.clips = live;
      start = live[0].from;
    } else {
      /* 这一段的所有轨：循环窗口收到这一段，谁在这一段里有声音就响谁。
         整队进临时 Song（候选轨就再加上候选那一条），静音的轨由 arrange / 引擎自己跳过 */
      if (!clip) return;
      loop = { from: clip.from, to: clip.to };
      start = clip.from;
    }
    var tmp;
    if (one) {
      tmp = Object.assign({}, song, { band: [one], _arr: null });
    } else {
      var list = bandOf().slice();
      if (bi === -1) list.push(src);
      tmp = Object.assign({}, song, { band: list, _arr: null });
    }
    var full = false;
    /* 片段区间与律动倍率凑在一起可能一段都排不上音（例如快一倍 + 片段在后半圈）。
       这时退回整段，至少能听见这一轨，并说清楚为什么 */
    if (mode === 'track' && (src.k === 'drums' || src.k === 'bass' || src.k === 'chord')) {
      var evs = L.ARRANGE.arrange(tmp) || [];
      var audible = false;
      for (var ei = 0; ei < evs.length; ei++) {
        if (evs[ei].t !== 'lead') { audible = true; break; }
      }
      if (!audible) {
        delete one.clips;
        tmp._arr = null;
        start = 0;
        full = true;
        toast('这一轨的片段没排上音，先按整段听（改回标准律动，或把片段挪进有声音的范围）', 2800);
      }
    }
    var opts = playOpts();
    opts.lead = false;                  /* 别把主旋律也带上 */
    opts.seekBeat = start;
    if (loop) opts.loop = loop;
    audition = {
      bi: bi, mode: mode, full: full,
      from: opts.seekBeat, to: loop ? loop.to : U.LOOP_BEATS
    };
    state.playing = true;
    state.seekBeat = opts.seekBeat;
    ENG.play(tmp, opts);
    syncPlayBtn();
    if (timelineOpen()) L.TIMELINE.refresh();
  }

  function toggleAudition(bi, mode, clip) {
    if (auditionOn(bi, mode)) { endAudition(); return; }
    startAudition(bi, mode, clip);
  }

  function replay() {
    if (!state.song) return;
    ENG.stop();
    startPlaying();
    syncPlayBtn();
  }

  /* 把播放头挪到某一拍；正在播放时立刻从新拍位重播 */
  function seekTo(beat, play) {
    state.seekBeat = U.clamp(Math.round(beat * 2) / 2, 0, U.LOOP_BEATS);
    if (play || state.playing) startPlaying();
  }

  /* 边听边改：从当前这一拍接着重排，别跳回开头 */
  function restartHere() {
    if (!state.playing) return;
    state.seekBeat = Math.round(ENG.beatPos() * 2) / 2;
    replay();
  }

  /* 试听：只让传进来的这几件响，主旋律不跟着走。
     arrange 按 song.band 生成事件，所以这里临时做一份只含这几件的 Song，
     既不动真正的 song.band，也不污染它的编曲缓存 */
  function previewOnly(list) {
    var song = state.song;
    if (!song) return;
    var tmp = {};
    for (var k in song) {
      if (Object.prototype.hasOwnProperty.call(song, k)) tmp[k] = song[k];
    }
    tmp.band = list;
    tmp._arr = null;

    var o = playOpts();
    o.lead = false;
    ENG.stop();
    clearAudition();       /* 整段试听接管「循环这一段 / 整轨循环」 */
    state.playing = true;
    ENG.play(tmp, o);
    syncPlayBtn();
    requestAnimationFrame(function () {
      DRAW.melody(elCvMelody, song, 0);
      DRAW.band(elCvBand, song, 0);
    });
  }

  /* 页面上只有一个圆按钮，件数和名字写在旁边的副标题里 */
  function updateBandEntry() {
    var btn = $('#btnBand');
    var n = bandOf().length;
    if (btn) {
      btn.textContent = n ? String(n) : '＋';
      btn.classList.toggle('on', n > 0);
      btn.setAttribute('aria-label', n ? '乐队有 ' + n + ' 件' : '添加乐器或氛围');
    }
    var sum = $('#bandSummary');
    if (sum) {
      var names = instrumentNames();
      sum.textContent = names.length ? names.join(' · ') : '还没有加乐器';
    }
  }

  /* 页签只切下面的「添加」区：最上面的已加入清单始终是整支乐队（乐器 + 氛围），
     不管加的是哪一类，加入后都立刻出现在那张清单里 */
  function syncBandTabs() {
    if (!elBandTabs) return;
    $$('button', elBandTabs).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === bandTab);
    });
  }

  function setBandTab(tab) {
    var next = (tab === 'amb' || tab === 'demo') ? tab : 'inst';
    if (next === bandTab) return;
    var wasPreview = !!previewSel && state.playing;
    bandTab = next;
    if (next === 'amb') openFamily = 'amb';
    else openFamily = '';
    previewSel = null;
    openRowIdx = -1;
    syncBand();
    /* 正在试听时切页，退回整队，别让上一件孤零零地继续响 */
    if (wasPreview && state.playing) replay();
  }

  /* 拍数显示：一律半拍对齐，保留一位小数 */
  function beatText(v) { return (Math.round(v * 2) / 2).toFixed(1); }

  /* 乐队行上的摘要：整段 / 一段区间 / 几段 */
  function clipsLabel(clips) {
    if (!clips || !clips.length) return '整段';
    if (clips.length === 1) {
      if (U.isFullWindow(clips[0])) return '整段';
      return beatText(clips[0].from) + '–' + beatText(clips[0].to) + ' 拍';
    }
    return clips.length + ' 段';
  }

  /* 整首变调：主旋律音高与调性一起挪，和弦 / 贝斯 / 和音都跟 song.tonic 走；
     录音层靠 engine 的播放速率跟着变（见 playOpts.voiceRate） */
  function transposeBy(d) {
    var song = state.song;
    if (!song) return;
    var notes = U.leadNotes(song);
    for (var i = 0; i < notes.length; i++) {
      var m = notes[i].m + d;
      if (m < 36 || m > 99) {
        toast(d > 0 ? '再升就超出音域了' : '再降就超出音域了', 1400);
        return;
      }
    }
    U.mapLeadNotes(song, function (n) { n.m += d; });
    song.tonic = (song.tonic + d + 12) % 12;
    /* 和弦也得跟着搬：bars 存的是绝对 pitch class，只改 tonic 会让伴奏比旋律低半音，
       示范区的「当前走向」也会因此认不出来 */
    if (song.bars && song.bars.length) {
      song.bars = song.bars.map(function (pc) { return (pc + d + 12) % 12; });
    }
    song.shift = (song.shift || 0) + d;
    song._arr = null;
    $('#badgeKey').textContent = keyName(song);
    if (state.playing) startPlaying();
    if (!timelineOpen()) syncBand();
  }

  /* 这一层的律动快慢：0.5 / 1 / 2，只改它自己事件的疏密，不动整首 BPM */
  function setLayerRate(it, r) {
    if (r === 1) delete it.rate;
    else it.rate = r;
    state.song._arr = null;
    restartHere();
    if (!timelineOpen()) syncBand();
  }

  /* 第一栏：所有已经在响的（乐器 / 人声 / 氛围），不按页签过滤。
     点名字展开这一行换曲调；片段区间与分割都进全屏时间线（「编曲」） */
  function buildBandList() {
    if (!elBandList) return;
    elBandList.innerHTML = '';
    var band = bandOf();
    if (!band.length) {
      var em = document.createElement('div');
      em.className = 'band-empty';
      em.textContent = '还没有乐器或氛围。下面挑一件，点一下只响它，听听顺不顺耳。';
      elBandList.appendChild(em);
      return;
    }

    band.forEach(function (it, idx) {
      /* 人声是录音循环，氛围是铺底，主旋律的音色在主音色面板里换：
         三者都没有曲调，但有片段区间 */
      var isVoice = it.k === 'voice';
      var isAmb = it.k === 'amb';
      var isLead = it.k === 'lead';
      var isStatic = isVoice || isAmb || isLead;
      var open = openRowIdx === idx;
      var clips = U.bandClips(it);

      var rowEl = document.createElement('div');
      rowEl.className = 'band-row';

      var item = document.createElement('div');
      item.className = 'band-item' + (open ? ' open' : '');

      var name = document.createElement('div');
      name.className = 'band-item-name';
      var b = document.createElement('b');
      b.textContent = TIMBRE.nameOf(it.k, it.id) || '乐器';
      var sp = document.createElement('span');
      var sub = isLead ? '旋律 · 主音色面板可换'
        : isVoice ? '人声'
          : isAmb ? '氛围'
            : TIMBRE.familyName(it.k, it.id) + ' · ' + (it.mood || moodOf()[it.k]);
      sp.textContent = sub + ' · ' + clipsLabel(clips) + (it.mute ? ' · 静音' : '');
      name.appendChild(b);
      name.appendChild(sp);

      name.setAttribute('role', 'button');
      name.setAttribute('tabindex', '0');
      name.setAttribute('aria-expanded', open ? 'true' : 'false');
      name.setAttribute('aria-label',
        (isStatic ? '编曲' : '展开') + '「' + (TIMBRE.nameOf(it.k, it.id) || '乐器') + '」');
      var toggle = function () {
        /* 人声 / 氛围没有曲调可换：点名字直接进编曲 */
        if (isStatic) { openTimeline({ bi: idx }); return; }
        var next = open ? -1 : idx;
        openRowIdx = next;
        syncBand();
      };
      name.addEventListener('click', toggle);
      name.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggle();
      });

      /* 编曲入口：打开全屏时间线并选中这一轨（片段拖拽 / 裁剪 / 分割都在那里） */
      var tune = document.createElement('button');
      tune.className = 'band-tune';
      tune.textContent = '编曲';
      tune.setAttribute('aria-label',
        '打开「' + (TIMBRE.nameOf(it.k, it.id) || '乐器') + '」的编曲时间线');
      tune.addEventListener('click', function (e) {
        e.stopPropagation();
        openTimeline({ bi: idx });
      });

      var vol = document.createElement('input');
      vol.className = 'band-vol';
      vol.type = 'range';
      vol.min = '10';
      vol.max = '100';
      vol.step = '5';
      vol.value = String(Math.round((it.vol === undefined ? 0.8 : it.vol) * 100));
      vol.setAttribute('aria-label', '音量');
      vol.addEventListener('input', function () {
        it.vol = U.clamp(vol.value / 100, 0.1, 1);
      });
      vol.addEventListener('change', function () { replay(); });

      var x = document.createElement('button');
      x.className = 'band-x';
      x.textContent = '✕';
      x.setAttribute('aria-label', '删掉这一轨');
      x.addEventListener('click', function () { removeInstrument(idx); });

      item.appendChild(name);
      item.appendChild(tune);
      item.appendChild(vol);
      item.appendChild(x);
      rowEl.appendChild(item);

      if (open) {
        if (!isStatic) {
          var moods = document.createElement('div');
          moods.className = 'band-moods';
          var cur = it.mood || moodOf()[it.k];
          TIMBRE.moods.forEach(function (m) {
            var chip = document.createElement('button');
            chip.className = 'chip' + (m.name === cur ? ' on' : '');
            chip.textContent = m.name;
            chip.addEventListener('click', function () { setInstrumentMood(idx, m.name); });
            moods.appendChild(chip);
          });
          rowEl.appendChild(moods);
        }
      }

      elBandList.appendChild(rowEl);
    });
  }

  /* 换某一件的曲调：心情和种子一起重抽，节奏型 / 拍位 / 音区都换一版。
     只让这一件响，方便和上一版对比；列表保持展开，可以连着试几个心情 */
  function setInstrumentMood(idx, name) {
    var it = bandOf()[idx];
    if (!it) return;
    if (!TIMBRE.mood(name)) return;      /* 只认 TIMBRE.moods 里的名字 */
    it.mood = name;
    it.seed = GROOVE.newSeed();
    state.song._arr = null;
    syncBand();
    previewOnly([it]);
    toast('换成「' + name + '」，现在只响它', 1600);
  }

  /* 点家族 = 展开 + 先听它的代表音色；点音色 = 只换试听对象；
     真正加进乐队要点下面的「加入乐队」。
     试听默认连着已经加上的乐队一起响：孤零零一件听不出合不合群；
     想听干净的单件，用「整队 / 单件」切过去。
     曲调（心情 + 种子）在选中时抽一次，试听到的就是加进去的那一版；
     「换一版」按当前氛围再抽一条 */
  var previewSolo = false;
  var previewVibe = '';        /* '' = 跟随这首歌的曲调 */

  function rollPreviewMood() {
    return L.STYLE ? L.STYLE.rollMood(previewVibe, teamMood()) : teamMood();
  }

  function selectPreview(kind, id) {
    if (!previewSel || previewSel.k !== kind || previewSel.id !== id) {
      /* 氛围没有曲调与种子，别掷一份没人用的数据 */
      previewSel = kind === 'amb'
        ? { k: kind, id: id }
        : { k: kind, id: id, seed: GROOVE.newSeed(), mood: rollPreviewMood() };
      /* 试听候选与已加入行的微调同时只展开一个 */
      if (openRowIdx !== -1) {
        openRowIdx = -1;
        buildBandList();
      }
    }
    buildAdd();          /* 先让选中态和「加入乐队」出现 */
    /* 人声层放的是这一次的录音；还没有就提示去「哼一段」，别放空 */
    if (kind === 'voice' && !state.voiceBuf) {
      toast('还没有人声，点下面「哼一段」现录一条', 2200);
      return;
    }
    playPreview();
  }

  /* 换一版：曲调重新掷一次（氛围里换曲调 / 换个种子），再听一遍 */
  function rerollPreview() {
    if (!previewSel) return;
    previewSel.mood = rollPreviewMood();
    previewSel.seed = GROOVE.newSeed();
    buildAdd();
    playPreview();
  }

  /* 候选先拼成一件 band 项：试听与加入乐队都用它，
     所以加入前在时间线上调过的片段 / 律动能原样带进去 */
  function previewAsItem() {
    var it = { k: previewSel.k, id: previewSel.id, vol: 0.9 };
    if (previewSel.k !== 'amb') {
      it.mood = previewSel.mood;
      it.seed = previewSel.seed;
    }
    var clips = U.bandClips(previewSel);
    if (!(clips.length === 1 && U.isFullWindow(clips[0]))) it.clips = clips;
    if (previewSel.rate) it.rate = previewSel.rate;
    return it;
  }

  /* 试听中按「取消试听」：丢掉候选，回到整队 */
  function cancelPreview() {
    previewSel = null;
    previewSolo = false;
    state.song._arr = null;
    if (state.playing) replay();
    syncBand();
  }

  function playPreview() {
    if (!previewSel) return;
    var band = bandOf();
    previewOnly((previewSolo || !band.length) ? [previewAsItem()] : band.concat([previewAsItem()]));
  }

  /* ---------- 示范区：常用和弦走向 + 氛围底色 ---------- */
  /* 级数 → 和弦名：顺手按当前调算三度音，写出 C / Am / Bdim 这种 */
  function chordLabel(deg, tonic, mode) {
    var sc = mode === 'major' ? L.C.MAJ : L.C.MIN;
    var base = sc[deg % 7];
    var third = (sc[(deg + 2) % 7] - base + 12) % 12;
    var fifth = (sc[(deg + 4) % 7] - base + 12) % 12;
    var name = L.C.PCN[(tonic + base) % 12] || 'C';
    if (third === 3) return name + 'm';
    if (fifth === 6) return name + 'dim';
    return name;
  }

  function buildDemos() {
    var song = state.song;
    if (!song) return;

    var head = document.createElement('p');
    head.className = 'band-label';
    head.textContent = '常用和弦走向 · 点一条，整支乐队立刻跟着变';
    elBandAdd.appendChild(head);

    var props = L.COMPOSE.progressions(song.tonic, song.mode);
    var cur = L.COMPOSE.progOf(song.bars, song.tonic, song.mode);
    var grid = document.createElement('div');
    grid.className = 'demo-grid';
    props.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'demo-card' + (p.id === cur ? ' on' : '');
      b.setAttribute('data-prog', p.id);
      var t = document.createElement('b');
      t.className = 'demo-name';
      t.textContent = p.lab;
      var s = document.createElement('span');
      s.className = 'demo-hint';
      s.textContent = p.deg.map(function (d) {
        return chordLabel(d, song.tonic, song.mode);
      }).join('→');
      b.appendChild(t);
      b.appendChild(s);
      b.addEventListener('click', function () { applyProgression(p); });
      grid.appendChild(b);
    });
    elBandAdd.appendChild(grid);

    var head2 = document.createElement('p');
    head2.className = 'band-label';
    head2.textContent = '底色 · 常用氛围铺底，点一下整组叠上去';
    elBandAdd.appendChild(head2);

    var have = {};
    bandOf().forEach(function (it) { if (it.k === 'amb') have[it.id] = true; });
    var grid2 = document.createElement('div');
    grid2.className = 'demo-grid';
    TIMBRE.ambPresets.forEach(function (p) {
      var all = p.layers.every(function (l) { return have[l.id]; });
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'demo-card' + (all ? ' on' : '');
      b.setAttribute('data-amb', p.id);
      var t = document.createElement('b');
      t.className = 'demo-name';
      t.textContent = p.name;
      var s = document.createElement('span');
      s.className = 'demo-hint';
      s.textContent = all ? '已在铺底' : p.hint;
      b.appendChild(t);
      b.appendChild(s);
      b.addEventListener('click', function () { applyAmbPreset(p); });
      grid2.appendChild(b);
    });
    elBandAdd.appendChild(grid2);
  }

  /* 换走向：写 bars（4 个 pitch class，和 codec / arrange 的口径一致）。
     乐队里一件和音乐器都没有时顺手加一层钢琴，否则换完什么都听不到 */
  function applyProgression(p) {
    var song = state.song;
    if (!song || !p || !p.bars) return;
    var band = bandOf();
    var hasChord = band.some(function (it) { return it.k === 'chord'; });
    var added = false;
    if (!hasChord && band.length < 12) {
      band.push({ k: 'chord', id: 'piano', vol: 0.8, mood: teamMood(), seed: GROOVE.newSeed() });
      added = true;
    }
    song.bars = p.bars.slice();
    song._arr = null;
    toast('和弦换成 ' + p.lab + (added ? '，顺手加了钢琴来弹' : '，整支乐队一起变'), 1800);
    if (state.playing) restartHere(); else replay();
    syncBand();
  }

  /* 底色：把这一组氛围层一起叠上（已有的跳过，音量按主铺底 + 点缀配好） */
  function applyAmbPreset(p) {
    if (!p) return;
    var band = bandOf();
    var added = 0, full = false;
    p.layers.forEach(function (l) {
      var has = band.some(function (it) { return it.k === 'amb' && it.id === l.id; });
      if (has) return;
      if (band.length >= 12) { full = true; return; }
      band.push({ k: 'amb', id: l.id, vol: l.vol });
      added++;
    });
    if (!added) {
      toast(full ? '最多 12 件，先卸一件再加' : '「' + p.name + '」已经在铺底了', 1600);
      syncBand();
      return;
    }
    state.song._arr = null;
    syncBand();
    if (state.playing) restartHere(); else replay();
    toast('底色 · ' + p.name + ' 加进来了', 1600);
  }

  function buildAdd() {
    if (!elBandAdd) return;
    elBandAdd.innerHTML = '';
    if (bandTab === 'demo') { buildDemos(); return; }

    /* 当前页签只列自己这边的家族：乐器页不出现氛围，氛围页只有氛围 */
    var fams = TIMBRE.families.filter(function (f) {
      return (f.kind === 'amb') === (bandTab === 'amb');
    });

    if (bandTab !== 'amb') {
      var cats = document.createElement('div');
      cats.className = 'band-cats';
      fams.forEach(function (fam) {
        var on = openFamily === fam.id;
        var btn = document.createElement('button');
        btn.className = 'band-cat' + (on ? ' on' : '');
        btn.innerHTML = fam.name + '<i>' + (on ? '▲' : '＋') + '</i>';
        btn.addEventListener('click', function () {
          if (on) {
            openFamily = '';
            buildAdd();
            return;
          }
          openFamily = fam.id;
          selectPreview(fam.kind, fam.ids[0]);
        });
        cats.appendChild(btn);
      });
      elBandAdd.appendChild(cats);
    } else {
      /* 氛围只有一家，不必再多一层家族按钮，直接把八条摆出来 */
      openFamily = 'amb';
    }

    var fam = null;
    fams.forEach(function (f) { if (f.id === openFamily) fam = f; });

    if (fam) {
      var chips = document.createElement('div');
      chips.className = 'band-add-chips';
      TIMBRE.list(fam.kind).forEach(function (item) {
        if (fam.ids.indexOf(item.id) < 0) return;
        var on = previewSel && previewSel.k === fam.kind && previewSel.id === item.id;
        var b = document.createElement('button');
        b.className = 'chip' + (on ? ' on' : '');
        b.textContent = item.name;
        b.addEventListener('click', function () {
          selectPreview(fam.kind, item.id);
        });
        chips.appendChild(b);
      });
      elBandAdd.appendChild(chips);
    }

    /* 试听和加入分开：试听只出声，加入才写进 song.band */
    if (previewSel) {
      var isVoice = previewSel.k === 'voice';
      var isAmb = previewSel.k === 'amb';

      /* 曲调氛围：选一个，这件乐器的拍位与和声就从这组曲调里掷，掷完还能再换。
         人声与氛围没有节奏型与和声，这一行对它们没意义 */
      if (!isVoice && !isAmb) {
        var vibeLabel = document.createElement('p');
        vibeLabel.className = 'band-label';
        vibeLabel.textContent = '曲调氛围 · 掷一条出来听听';
        elBandAdd.appendChild(vibeLabel);

        var vibeRow = document.createElement('div');
        vibeRow.className = 'chip-row';
        [{ id: '', name: '跟随这首歌' }].concat(L.STYLE.vibes).forEach(function (v) {
          var chip = document.createElement('button');
          chip.className = 'chip' + (previewVibe === v.id ? ' on' : '');
          chip.textContent = v.name;
          chip.addEventListener('click', function () {
            if (previewVibe === v.id) return;
            previewVibe = v.id;
            rerollPreview();
          });
          vibeRow.appendChild(chip);
        });
        elBandAdd.appendChild(vibeRow);
      } else if (isVoice) {
        var humNote = document.createElement('p');
        humNote.className = 'band-label';
        humNote.textContent = state.voiceBuf
          ? '这一段已经录好了，可以直接叠进来；也可以重录一条'
          : '还没录人声：点「哼一段」，流程和首页一样（四拍倒计时 + 八拍）';
        elBandAdd.appendChild(humNote);
      } else {
        var ambNote = document.createElement('p');
        ambNote.className = 'band-label';
        ambNote.textContent = '氛围没有曲调，加入后可以叠多条、各自调音量';
        elBandAdd.appendChild(ambNote);
      }

      var pick = document.createElement('div');
      pick.className = 'band-pick';

      var head = document.createElement('div');
      head.className = 'band-pick-head';

      var label = document.createElement('span');
      if (isVoice) {
        label.innerHTML = state.voiceBuf ? '<b>人声</b> · 整段循环' : '<b>人声</b> · 还没录';
      } else if (isAmb) {
        label.innerHTML = '正在试听 <b>'
          + (TIMBRE.nameOf(previewSel.k, previewSel.id) || '氛围') + '</b> · 氛围';
      } else {
        label.innerHTML = '正在试听 <b>'
          + (TIMBRE.nameOf(previewSel.k, previewSel.id) || '乐器') + '</b>'
          + (previewSel.mood ? ' · ' + previewSel.mood : '');
      }
      head.appendChild(label);

      /* 乐队还空着时整队和单件声音一样，就不摆这个开关 */
      if (bandOf().length) {
        var seg = document.createElement('div');
        seg.className = 'seg';
        [{ solo: false, name: '整队' }, { solo: true, name: '单件' }].forEach(function (m) {
          var b = document.createElement('button');
          b.className = previewSolo === m.solo ? 'on' : '';
          b.textContent = m.name;
          b.addEventListener('click', function () {
            if (previewSolo === m.solo) return;
            previewSolo = m.solo;
            buildAdd();
            playPreview();
          });
          seg.appendChild(b);
        });
        head.appendChild(seg);
      }

      /* 编曲：把候选当成一条临时轨进时间线，区间 / 律动都调好再加入 */
      var tuneBtn = document.createElement('button');
      tuneBtn.className = 'band-tune';
      tuneBtn.setAttribute('data-preview-tune', '1');
      tuneBtn.textContent = '编曲';
      tuneBtn.setAttribute('aria-label', '把这一件放进时间线调片段与律动');
      tuneBtn.addEventListener('click', function () { openTimeline({ preview: true }); });
      head.appendChild(tuneBtn);
      pick.appendChild(head);

      var acts = document.createElement('div');
      acts.className = 'band-pick-acts';

      if (isVoice) {
        /* 人声这一层没有曲调可掷：要么重录一条，要么把已录好的叠进去 */
        var hum = document.createElement('button');
        hum.className = state.voiceBuf ? 'btn soft' : 'btn primary';
        hum.textContent = state.voiceBuf ? '重录一条' : '哼一段';
        hum.setAttribute('aria-label', '像首页那样录一段哼唱');
        hum.addEventListener('click', startBandHum);
        acts.appendChild(hum);

        if (state.voiceBuf) {
          var putVoice = document.createElement('button');
          putVoice.className = 'btn primary';
          putVoice.textContent = '加入乐队';
          putVoice.addEventListener('click', function () {
            addInstrument('voice', 'hum');
          });
          acts.appendChild(putVoice);
        }
      } else {
        /* 氛围没有曲调可掷，只留「加入氛围」 */
        if (!isAmb) {
          var roll = document.createElement('button');
          roll.className = 'btn soft';
          roll.textContent = '换一版';
          roll.setAttribute('aria-label', '按当前氛围再掷一条曲调');
          roll.addEventListener('click', rerollPreview);
          acts.appendChild(roll);
        }

        var add = document.createElement('button');
        add.className = 'btn primary';
        add.textContent = isAmb ? '加入氛围' : '加入乐队';
        add.addEventListener('click', function () {
          addInstrument(previewSel.k, previewSel.id);
        });
        acts.appendChild(add);
      }
      pick.appendChild(acts);
      elBandAdd.appendChild(pick);
    }
  }

  function syncBand() {
    updateBandEntry();
    if (!state.song) return;
    syncBandTabs();
    buildBandList();
    buildAdd();
  }

  /* 加一件：每件自带曲调与种子，同一层加两件就是两份独立律动。
     上限 12 与 codec 的 MAX_BAND 对齐，不然第 13 件会在分享时被静默截掉 */
  function addInstrument(kind, id) {
    if (!state.song) return;
    if (kind === 'voice' && !state.voiceBuf) {
      toast('这次没留下原声，加不了人声层', 2000);
      return;
    }
    var band = bandOf();
    if (band.length >= 12) {
      toast('最多 12 件，先卸一件再加', 1800);
      return;
    }
    /* 沿用刚才试听那一版的种子与曲调：听过的就是加进来的。
       氛围没有曲调与种子，默认音量也压低一档，当铺底用 */
    var picked = (previewSel && previewSel.k === kind && previewSel.id === id) ? previewSel : null;
    var item = kind === 'amb'
      ? { k: kind, id: id, vol: 0.6 }
      : {
        k: kind, id: id, vol: 0.8,
        mood: (picked && picked.mood) || teamMood(),
        seed: (picked && picked.seed) || GROOVE.newSeed()
      };
    /* 试听时在时间线上调过的片段与律动，加入后原样保留 */
    if (picked) {
      var pickedClips = U.bandClips(picked);
      if (!(pickedClips.length === 1 && U.isFullWindow(pickedClips[0]))) item.clips = pickedClips;
      if (picked.rate) item.rate = picked.rate;
    }
    band.push(item);
    state.song._arr = null;
    /* 加完就收起「加入」那一行，避免连点重复加同一件 */
    previewSel = null;
    syncBand();
    /* 加完立刻整队一起响，接着刚才试听的声音往下走，不用关面板才听得到合奏 */
    if (state.playing) restartHere(); else replay();
    toast('已加入 · ' + TIMBRE.nameOf(kind, id) + '，整支乐队一起响', 1800);
  }

  function removeInstrument(idx) {
    var band = bandOf();
    var it = band[idx];
    if (!it) return;
    band.splice(idx, 1);
    state.song._arr = null;
    openRowIdx = -1;       /* 下标已经变了，收起展开行，别指到别的乐器上 */
    syncBand();
    if (state.playing) restartHere(); else replay();
    toast('删掉了「' + TIMBRE.nameOf(it.k, it.id) + '」这一轨', 1500);
  }

  function openBand() {
    if (!state.song) return;
    /* 每次打开都回到「第一页、全部收起、没有在试听」的状态 */
    bandTab = 'inst';
    openFamily = '';
    previewSel = null;
    openRowIdx = -1;
    updateStyleHint();
    openSheet('#sheetBand');
    syncBand();
  }

  /* 在乐队面板里现录一层人声：流程和首页一样（四拍倒计时 + 八拍）。
     区别只在录完的去向：首页是出整首歌，这里是叠成一条「我的哼唱」 */
  function startBandHum() {
    if (!state.song || state.micBusy) return;
    state.recMode = 'band';
    closeSheets();
    startRecording();
  }

  function endBandHum(ok, msg) {
    state.recMode = 'main';
    if (!state.song) { setScreen('idle'); return; }
    setScreen('result');
    if (!ok) {
      toast(msg || '这一段没录到声音，再试一次', 2600);
      openBand();
      return;
    }
    var band = bandOf();
    var item = null;
    for (var i = 0; i < band.length; i++) {
      if (band[i] && band[i].k === 'voice') { item = band[i]; break; }
    }
    if (!item) {
      item = { k: 'voice', id: 'hum', vol: 0.8, mood: teamMood(), seed: GROOVE.newSeed() };
      band.push(item);
    }
    state.song._arr = null;
    openBand();          /* 回面板：列表里已经有「我的哼唱」了 */
    replay();
    toast('人声录好了，已经叠进乐队', 2000);
  }

  /* 风格给的配器倾向写成一行提示，加乐器时心里有个底 */
  function updateStyleHint() {
    var el = $('#bandHint');
    if (!el) return;
    var st = state.song && state.song.style;
    var text = '';
    if (st && st.timbreHint && L.STYLE) {
      var names = L.STYLE.timbreText(st.timbreHint);
      if (names) text = '这首走的是「' + st.name + '」的路子，常用配器：' + names;
    }
    el.textContent = text;
    el.classList.toggle('hide', !text);
  }

  function syncPlayBtn() {
    btnPlay.innerHTML = state.playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.6-6.8c.6-.4.6-1.4 0-1.8L9.6 4.3c-.7-.4-1.6.1-1.6.9z"/></svg>';
  }

  /* 老链接解出来的 Song 没有 band / mood / bpm，进结果页前补齐 */
  function normalizeSong(song) {
    if (!song.band) song.band = [];
    if (!song.mood) song.mood = song.feel || GROOVE.feelDefaults();
    if (!song.seeds) song.seeds = GROOVE.seedDefaults();
    if (!song.bpm) song.bpm = C.BPM;
    /* 主旋律现在就是一条普通轨：老歌 / 老链接没有它时补一条，
       名字跟着当前选的主音走，之后和其它乐器一样能静音、调片段、拖动 */
    var hasLead = song.band.some(function (it) { return it && it.k === 'lead'; });
    if (!hasLead) {
      var id = state.timbre;
      if (id === 'voice' && !state.voiceBuf) id = 'soft';
      if (!L.TIMBRE.nameOf('lead', id)) id = 'soft';
      song.band.unshift({ k: 'lead', id: id, vol: 1 });
      state.timbre = id;
    } else {
      var lead = song.band.filter(function (it) { return it && it.k === 'lead'; })[0];
      /* 分享串 / 云作品里带不过来录音：原声轨落到柔和合成，别变成一条静音轨 */
      if ((lead.id === 'voice' && !state.voiceBuf) || !L.TIMBRE.nameOf('lead', lead.id)) {
        lead.id = 'soft';
        song._arr = null;
      }
      state.timbre = lead.id;
    }
    song._arr = null;
    return song;
  }

  /* 主音色面板改选：直接改 lead 轨的 id，声音、画布、时间线名字一起变 */
  function setLeadVoice(k) {
    state.timbre = k;
    var song = state.song;
    if (!song) return;
    var lead = song.band.filter(function (it) { return it && it.k === 'lead'; })[0];
    if (lead) {
      lead.id = k;
      song._arr = null;
    }
    syncBand();
    if (timelineOpen()) L.TIMELINE.refresh();
  }

  function showResult(song, opts) {
    state.seekBeat = 0;
    state.song = normalizeSong(song);
    $('#badgeKey').textContent = keyName(song);
    $('#badgeBpm').textContent = song.bpm + ' BPM';
    /* 简谱 / 随机旋律不是「哼」出来的，标题要说实话 */
    var src = opts && opts.source;
    var title = $('#melodyTitle');
    if (title) {
      title.textContent = src === 'typed' ? '你的简谱'
        : src === 'random' ? '随机旋律' : '你的哼唱';
    }
    syncBand();
    resultScreen.classList.remove('analyzing');
    setScreen('result');

    requestAnimationFrame(function () {
      DRAW.melody(elCvMelody, song, 0);
      DRAW.band(elCvBand, song, 0);
    });

    /* 先让用户挑声音再出声，不再一进结果页就把整支乐队砸出来 */
    openVoicePicker(!opts || opts.autoplay !== false);
  }

  function togglePlay() {
    if (!state.song) return;
    if (state.playing) {
      /* 暂停时把播放头留在这一拍：时间线打开就从这里开始 */
      var at = ENG.beatPos();
      clearAudition();
      state.seekBeat = Math.round(at * 2) / 2;
      ENG.stop();
      state.playing = false;
    } else {
      state.pendingAutoplay = true;
      startPlaying();
    }
    syncPlayBtn();
  }

  /* ---------- 编曲时间线 ---------- */
  /* 时间线只做视图：下面这些回调负责把改动写回数据并重排声音。
     bi = -1 是试听候选那一条临时轨，数据挂在 previewSel 上，不进 song.band */
  function timelineContext(bi, preview) {
    return {
      song: state.song,
      preview: preview ? previewSel : null,
      bi: bi,
      getBeat: nowBeat,
      isPlaying: function () { return !!state.playing; },
      onPlayToggle: function () { togglePlay(); },
      onSeek: function (b) { seekTo(b, state.playing); },
      onSelectTrack: function () {},
      onChange: function (b, clips, opts) { applyClips(b, clips, opts); },
      /* 片段拖到别的轨 / 拖到底部新开一轨：一次写完两侧，返回新的轨道下标 */
      onMoveClip: function (p) { return moveClipToTrack(p); },
      onDeleteTrack: function (b) { removeInstrument(b); },
      onToggleMute: function (b) { toggleMute(b); },
      onRate: function (b, r) { applyRate(b, r); },
      onKey: function (d) { transposeBy(d); },
      onAudition: function (b, clip) { toggleAudition(b, 'clip', clip); },
      onAuditionTrack: function (b) { toggleAudition(b, 'track'); },
      onAuditionSection: function (b, clip) { toggleAudition(b, 'section', clip); },
      isAudition: function (b, mode) { return auditionOn(b, mode); },
      /* 时间线问「现在单独试听的是哪一条」：只让那一条轨亮小喇叭 */
      audition: function () {
        if (!audition) return null;
        return {
          bi: audition.bi, mode: audition.mode, full: !!audition.full,
          from: audition.from, to: audition.to
        };
      },
      onSay: function (msg) { toast(msg, 1600); },
      onJoin: function () { joinTimelinePreview(); },
      onCancel: function () { cancelTimelinePreview(); },
      onDone: function () { closeTimeline(); }
    };
  }

  function openTimeline(opts) {
    opts = opts || {};
    if (!state.song) return;
    var preview = !!opts.preview && !!previewSel;
    /* 进时间线编辑时把 8 拍乐句物化进各 lead 片段，之后移动 / 切割片段旋律才会跟着走 */
    if (!preview) U.materializeLead(state.song);
    L.TIMELINE.open(timelineContext(preview ? -1 : (opts.bi || 0), preview));
  }

  /* 关掉时间线：播放头归零，乐队行上的摘要跟着刷新。
     正在单独试听就直接回整队，别留一条临时音轨在响 */
  function closeTimeline() {
    clearAudition();
    L.TIMELINE.close();
    state.seekBeat = 0;
    if (state.song) syncBand();
    if (state.playing) replay();
  }

  /* 试听轨上的改动：写回 previewSel（不是 song.band），重排候选试听 */
  function applyClips(bi, clips, opts) {
    if (bi === -1) {
      if (!previewSel) return;
      U.writeClips(previewSel, clips);
      if (state.playing) playPreview();
      return;
    }
    var it = bandOf()[bi];
    if (!it) return;
    U.writeClips(it, clips);
    state.song._arr = null;
    if (opts && typeof opts.seek === 'number') {
      /* 新建片段：播放头挪到它开头 */
      state.seekBeat = U.clamp(Math.round(opts.seek * 2) / 2, 0, U.LOOP_BEATS);
    } else if (state.playing) {
      /* 裁剪 / 分割 / 步进不打断听感：从当前这一拍接着放 */
      state.seekBeat = Math.round(ENG.beatPos() * 2) / 2;
    }
    if (state.playing || (opts && opts.play)) startPlaying();
    if (!timelineOpen()) syncBand();
  }

  /* 搬去非 lead 轨时剥掉片段上的旋律音符，只留区间与静音位 */
  function stripNotes(clips) {
    return (clips || []).map(function (c) {
      var o = { from: c.from, to: c.to };
      if (c.mute) o.mute = 1;
      return o;
    });
  }

  /* 把一段搬到另一条轨上（toBi = -1 表示用同一件乐器另起一轨，只放这一段）。
     两侧的区间由时间线归一化好，这里一次事务写完再重排：先写目标轨，再动源轨，
     否则删掉源轨后目标下标会整体前移。返回这一段现在落在第几条轨，供时间线重新选中 */
  function moveClipToTrack(p) {
    if (!p) return -1;
    var band = bandOf();
    var src = band[p.fromBi];
    if (!src || p.fromBi === p.toBi) return -1;
    var name = TIMBRE.nameOf(src.k, src.id) || '这一件';
    var to = -1;
    var opened = false;
    var left = !!(p.clips && p.clips.length);

    if (p.toBi === -1) {
      if (band.length >= 12) { toast('最多 12 件，先卸一件再开新轨', 1800); return -1; }
      /* 同一件乐器的又一层：曲调 / 种子 / 律动照搬，听感才和原轨一致 */
      var one = { k: src.k, id: src.id, vol: src.vol === undefined ? 0.8 : src.vol };
      if (src.mood) one.mood = src.mood;
      if (src.seed) one.seed = src.seed;
      if (src.rate) one.rate = src.rate;
      U.writeClips(one, p.target);
      band.push(one);
      to = band.length - 1;
      opened = true;
    } else {
      var dst = band[p.toBi];
      if (!dst) return -1;
      /* 旋律音符只有 lead 轨消费：搬到别的轨就剥掉，别把脏数据带过去 */
      U.writeClips(dst, dst.k === 'lead' ? p.target : stripNotes(p.target));
      to = p.toBi;
    }

    state.song._arr = null;
    if (left) {
      U.writeClips(src, p.clips);
    } else {
      /* 原轨被搬空：和「删掉最后一段」一个口径，整轨收起 */
      band.splice(p.fromBi, 1);
      openRowIdx = -1;
      if (p.fromBi <= to) to -= 1;
    }

    if (opened) {
      toast(left
        ? '新开了一条「' + name + '」轨，只放这一段'
        : '新开了一条「' + name + '」轨；原轨搬空，已经收起', 2200);
    } else if (!left) {
      toast('原轨搬空了，已经收起', 1800);
    }

    if (state.playing) restartHere();
    if (!timelineOpen()) syncBand();
    return to;
  }

  function toggleMute(bi) {
    var it = bandOf()[bi];
    if (!it) return;
    if (it.mute) delete it.mute;
    else it.mute = true;
    state.song._arr = null;
    restartHere();
  }

  function applyRate(bi, r) {
    if (bi === -1) {
      if (!previewSel) return;
      if (r === 1) delete previewSel.rate;
      else previewSel.rate = r;
      if (state.playing) playPreview();
      return;
    }
    var it = bandOf()[bi];
    if (it) setLayerRate(it, r);
  }

  /* 从试听里按「加入乐队」：试听时调过的片段与律动原样带进去 */
  function joinTimelinePreview() {
    if (!previewSel) { closeTimeline(); return; }
    var kind = previewSel.k;
    var id = previewSel.id;
    L.TIMELINE.close();
    state.seekBeat = 0;
    addInstrument(kind, id);
  }

  function cancelTimelinePreview() {
    L.TIMELINE.close();
    state.seekBeat = 0;
    cancelPreview();
  }

  /* ---------- 录音 ---------- */
  function resetRecUI() {
    elRecCount.textContent = '4';
    elRecCount.classList.remove('small');
    elRecHint.textContent = '准备好，跟着「哒」开始哼';
    elLevelBar.style.width = '0%';
    elLevelWrap.classList.remove('low');
    elBeatLights.forEach(function (b) { b.classList.remove('on'); });
  }

  function startRecording() {
    if (state.micBusy) return;
    state.micBusy = true;
    elMicLabel.textContent = '等一下…';

    /* 关键：解锁音频与申请麦克风都必须同步发生在点击手势里，
       任何 Promise 前置都会让 Toy 平台拒绝授权 */
    var pending;
    try {
      ENG.unlock();
      pending = Bridge.requestMic();
    } catch (e) {
      pending = Promise.reject(e);
    }

    pending.then(function (stream) {
      elMicLabel.textContent = '开始唱';
      return ENG.resume().then(function () {
        return ENG.beginCapture(stream);
      }).then(function () {
        state.micBusy = false;
        resetRecUI();
        setScreen('record');
        var t = ENG.now();
        var t0 = t + 0.4;
        rec = {
          beat0: t0 + 4 * SPB,
          end: t0 + 4 * SPB + C.BEATS * SPB,
          captureStart: t,
          done: false
        };
        ENG.metronome(t0, SPB, 4);
      });
    }).catch(function (err) {
      state.micBusy = false;
      elMicLabel.textContent = '开始唱';
      var bandMode = state.recMode === 'band';
      state.recMode = 'main';
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      var timedOut = err && err.message === 'mic-timeout';
      toast(timedOut
        ? '浏览器没给麦克风，去手机设置里给浏览器开录音权限'
        : (denied ? '麦克风没被允许，看「麦克风自检」' : '没拿到麦克风，看「麦克风自检」'), 3400);
      /* 乐队里现录人声时失败：直接退回乐队面板，别把人甩到自检页 */
      if (bandMode && state.song) {
        openBand();
        return;
      }
      openDiag(err);
    });
  }

  function stopRecordingNow() {
    if (!rec || rec.done) return;
    rec.done = true;
    var offset = Math.max(0, rec.beat0 - rec.captureStart);
    var cap = ENG.endCapture();
    var blobP = ENG.takeRecorderBlob();
    Bridge.releaseMic();
    rec = null;
    state.lastCap = null;

    /* 乐队里现录的人声：不跑识别，只要这一段有声音就叠成一层 */
    if (state.recMode === 'band') {
      blobP.then(function (blob) {
        if (!blob) throw new Error('no-blob');
        return ENG.decodeBlob(blob).then(function (buf) {
          var pcm = buf.getChannelData(0);
          var peak = 0;
          for (var i = 0; i < pcm.length; i++) {
            var v = Math.abs(pcm[i]);
            if (v > peak) peak = v;
          }
          if (peak < 0.005) { endBandHum(false, '这一段没收到声音，再试一次'); return; }
          state.voiceBuf = buf;
          state.voiceStart = offset;
          endBandHum(true);
        });
      }).catch(function () { endBandHum(false, '录音解码失败，再试一次'); });
      return;
    }

    /* 留一份录音给「我的原声」用；解码不阻塞分析，慢一点也照样先出曲 */
    state.voiceBuf = null;
    blobP.then(function (blob) {
      if (!blob) return null;
      return ENG.decodeBlob(blob).then(function (buf) {
        state.voiceBuf = buf;
        state.voiceStart = offset;
        var sheet = $('#sheetVoice');
        if (sheet && sheet.classList.contains('open')) buildVoices();
      });
    }).catch(function () {});

    if (!state.forceRec && cap.pcm.length && cap.peak >= 0.005) {
      goAnalyze(cap, offset);
      return;
    }

    /* WebAudio 一路全静音（Android WebView 常见），改吃 MediaRecorder 的录音 */
    blobP.then(function (blob) {
      if (!blob) throw new Error('no-blob');
      return ENG.decodeBlob(blob).then(function (buf) {
        var pcm = buf.getChannelData(0);
        var peak = 0;
        for (var i = 0; i < pcm.length; i++) {
          var v = Math.abs(pcm[i]);
          if (v > peak) peak = v;
        }
        if (peak < 0.005) {
          state.lastCap = { mode: 'mediarecorder', frames: cap.frames, pcm: pcm, peak: peak };
          setScreen('idle');
          toast('两条链路都没收到声音，看「麦克风自检」', 3400);
          openDiag(null);
          return;
        }
        goAnalyze({
          pcm: pcm, sampleRate: buf.sampleRate,
          peak: peak, mode: 'mediarecorder', frames: 0
        }, offset);
      });
    }).catch(function () {
      state.lastCap = cap;
      setScreen('idle');
      toast('没收到声音，看「麦克风自检」查原因', 3200);
      openDiag(null);
    });
  }

  /* 只有 ?debug=1 时才跑：把采集参数、PCM 与识别出的音符一起发给 dump-server */
  function dumpCapture(cap, offset, notes) {
    try {
      var q = '?rate=' + cap.sampleRate + '&mode=' + cap.mode
        + '&offset=' + Number(offset || 0).toFixed(3)
        + '&frames=' + (cap.frames || 0)
        + '&samples=' + (cap.pcm ? cap.pcm.length : 0);
      fetch('http://localhost:8099/notes' + q, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(notes || [])
      }).catch(function () {});
      if (!cap.pcm || !cap.pcm.length) return;
      fetch('http://localhost:8099/pcm' + q, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: cap.pcm.buffer
      }).then(function () {
        toast('调试数据已上传', 1600);
      }).catch(function () {});
    } catch (e) { /* 调试通道失败不影响主流程 */ }
  }

  function goAnalyze(cap, offset) {
    setScreen('result');
    resultScreen.classList.add('analyzing');

    var scanText = $('#scanText');
    var scanBar = $('#scanBar');
    var phrases = ['正在听你的音高…', '正在找调…', '正在配和弦…', '正在编鼓…'];
    var pi = 0;
    scanText.textContent = phrases[0];
    scanBar.style.width = '8%';

    var timer = setInterval(function () {
      pi = (pi + 1) % phrases.length;
      scanText.textContent = phrases[pi];
    }, 520);

    ANALYZE.run(cap.pcm, cap.sampleRate, offset, function (p) {
      scanBar.style.width = Math.round(10 + p * 88) + '%';
    }).then(function (notes) {
      clearInterval(timer);
      if (DEBUG_DUMP) dumpCapture(cap, offset, notes);
      if (!notes || notes.length < 3) {
        resultScreen.classList.remove('analyzing');
        setScreen('idle');
        /* 有能量但几乎没有周期性 = 气声/悄悄话，这类声音没有音高，换嗓子才有用 */
        var s = ANALYZE.stats ? ANALYZE.stats() : null;
        var breathy = s && s.peak > 0.02 && s.frames > 20 &&
          s.voiced / Math.max(1, s.frames) < 0.15;
        toast(breathy
          ? '这是气声，没有音高可听——用正常嗓子哼一次'
          : '没太听清…靠近麦克风再哼一次？', 3400);
        return;
      }
      var song = COMPOSE.buildSong(notes);
      scanBar.style.width = '100%';
      setTimeout(function () { showResult(song); }, 260);
    }).catch(function () {
      clearInterval(timer);
      resultScreen.classList.remove('analyzing');
      setScreen('idle');
      toast('这段没分析出来，换示例试试？', 2800);
    });
  }

  /* ---------- 示例旋律 ---------- */
  function playSample() {
    var notes = [
      { b: 0, d: 1, m: 69 }, { b: 1, d: 0.5, m: 72 }, { b: 1.5, d: 0.5, m: 74 },
      { b: 2, d: 1, m: 72 }, { b: 3, d: 1, m: 69 }, { b: 4, d: 1, m: 67 },
      { b: 5, d: 0.5, m: 64 }, { b: 5.5, d: 0.5, m: 67 }, { b: 6, d: 1, m: 69 },
      { b: 7, d: 1, m: 72 }, { b: 8, d: 1.5, m: 76 }, { b: 9.5, d: 0.5, m: 74 },
      { b: 10, d: 1, m: 72 }, { b: 11, d: 1, m: 69 }, { b: 12, d: 1, m: 67 },
      { b: 13, d: 1, m: 69 }, { b: 14, d: 2, m: 69 }
    ];
    var song = {
      v: 5, bpm: C.BPM, tonic: 9, mode: 'minor',
      mood: GROOVE.feelDefaults(),
      band: [],
      seeds: {
        drums: GROOVE.newSeed(),
        bass: GROOVE.newSeed(),
        chord: GROOVE.newSeed()
      },
      bars: [9, 5, 0, 7], notes: notes
    };
    ENG.resume().then(function () { showResult(song); });
  }

  /* ---------- 不用麦克风：输入简谱 / 随机旋律 ---------- */
  /* 两条路最后都落到同一个 COMPOSE.buildSong(notes)，
     所以选音色、加乐器、存作品、分享、海报全都照旧 */

  /* ---------- 候选池：简谱变奏与随机旋律共用 ---------- */
  /* 生成 → 试听 → 就用这段，两个面板走同一套逻辑。
     source 记住这批候选从哪来，免得面板之间互相覆盖 */
  var cand = {
    source: '',        /* 'typed' | 'random' */
    list: [], idx: -1,
    playing: false, timer: null,
    seed: 0,
    notes: null,       /* 简谱变奏用：原谱音符 */
    view: 'auto'       /* 节奏档：auto / straight / half / long */
  };

  /* 随机偏好：简谱变奏与随机旋律共用一套。
     速度按百分比一档一档走（±8%，最多 ±40%），音高按八度（最多 ±1 个） */
  var PREFS = {
    tempo: { label: '速度', minus: '慢', plus: '快', step: 8, max: 40, min: 56, cap: 176 },
    pitch: { label: '音高', minus: '低', plus: '高', step: 12, max: 12 }
  };
  var randPref = { tempo: 0, pitch: 0 };

  /* 偏移量的读法：速度显示百分比，音高显示挪了几个八度 */
  function prefText(key, v) {
    if (!v) return key === 'tempo' ? '原速' : '原样';
    if (key === 'tempo') return (v > 0 ? '+' : '') + v + '%';
    return v > 0 ? '高八度' : '低八度';
  }

  /* 播放器式步进：点一次进一档，中间的读数就是累计偏移 */
  function renderPrefs() {
    $$('.pref-step').forEach(function (box) {
      var key = box.getAttribute('data-pref');
      var p = PREFS[key];
      if (!p) return;

      var v = randPref[key] || 0;

      function stepBtn(name, dir) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ps-btn';
        b.textContent = name;
        b.disabled = dir < 0 ? v <= -p.max : v >= p.max;
        b.addEventListener('click', function () {
          var next = U.clamp((randPref[key] || 0) + dir * p.step, -p.max, p.max);
          if (next === randPref[key]) return;
          randPref[key] = next;
          renderPrefs();
          reapplyPrefs(true);   /* 点完直接出声，不用再点候选 */
        });
        return b;
      }

      var val = document.createElement('em');
      val.className = 'ps-val';
      val.textContent = prefText(key, v);

      box.innerHTML = '';
      box.appendChild(stepBtn(p.minus, -1));
      box.appendChild(val);
      box.appendChild(stepBtn(p.plus, 1));
    });
  }

  /* 偏好一变就地重排这批（种子不动）：同一条旋律只换速度 / 音区，
     松手时把选中的那条放一遍，没选过就放第一条 */
  function reapplyPrefs(play) {
    var sheet = cand.source === 'typed' ? $('#sheetInput') : $('#sheetRandom');
    if (!sheet || !sheet.classList.contains('open')) return;

    var keep = cand.idx;
    if (cand.source === 'typed') buildTypedCands(true, true);
    else buildRandomCands(true);
    if (!cand.list.length) return;

    var i = (keep >= 0 && keep < cand.list.length) ? keep : 0;
    cand.idx = i;
    renderCands();
    if (play) previewCand(i);
  }

  /* 速度：按比例缩放，三条候选的快慢差不会被压平；
     56 以下像拖拍、176 以上唱不动，是硬临界值 */
  function prefBpm(bpm) {
    var p = PREFS.tempo;
    var b = (bpm || C.BPM) * (1 + (randPref.tempo || 0) / 100);
    return Math.round(U.clamp(b, p.min, p.cap));
  }

  /* 音高：整体挪八度，音级关系不动，所以和弦与调性照样成立 */
  function prefShift(item) {
    var d = randPref.pitch || 0;
    if (!d) return item;
    item.notes.forEach(function (n) { n.m += d; });
    return item;
  }

  function applyPrefs(list) {
    list.forEach(function (item) {
      item.bpm = prefBpm(item.bpm);
      prefShift(item);
    });
    return list;
  }

  function keyNameOf(tonic, mode) {
    return C.PCN_CN[tonic] + (mode === 'major' ? ' 大调' : ' 小调');
  }

  function candBox() {
    return $(cand.source === 'typed' ? '#typedList' : '#randList');
  }

  function candName(item) {
    if (cand.source === 'typed') {
      return (COMPOSE.views[item.view] || '自动') + ' · ' + keyNameOf(item.tonic, item.mode);
    }
    return item.style + ' · ' + item.vibe;
  }

  function renderCands() {
    var box = candBox();
    if (!box) return;
    box.innerHTML = '';

    cand.list.forEach(function (item, i) {
      var playing = cand.playing && cand.idx === i;
      var row = document.createElement('button');
      row.className = 'rand-item' + (cand.idx === i ? ' on' : '');
      row.setAttribute('aria-pressed', cand.idx === i ? 'true' : 'false');

      var b = document.createElement('b');
      b.textContent = candName(item);

      var bpm = document.createElement('em');
      bpm.className = 'rand-bpm';
      bpm.textContent = (item.bpm || C.BPM) + ' BPM';

      var sp = document.createElement('span');
      sp.textContent = item.degrees.join(' ') + ' · ' + item.notes.length + ' 个音'
        + (playing ? ' · 试听中' : '');

      row.appendChild(b);
      row.appendChild(bpm);
      row.appendChild(sp);
      row.addEventListener('click', function () { previewCand(i); });
      box.appendChild(row);
    });

    var use = $(cand.source === 'typed' ? '#btnTypedUse' : '#btnRandUse');
    if (use) use.disabled = !(cand.idx >= 0);
    if (cand.source === 'typed') {
      var more = $('#btnTypedMore');
      if (more) more.disabled = !cand.list.length;
    }
  }

  /* 试听与成曲都从候选现建一份 Song：候选里只有主旋律，band 空着 */
  function songOfCand(item) {
    return COMPOSE.buildSong(item.notes, {
      tonic: item.tonic, mode: item.mode, bpm: item.bpm,
      pools: item.pools, moodName: item.mood,
      style: item.styleId && item.styleId !== 'typed'
        ? { id: item.styleId, name: item.style, timbreHint: item.timbreHint }
        : null
    });
  }

  function previewCand(i) {
    var item = cand.list[i];
    if (!item) return;

    cand.idx = i;
    cand.playing = true;
    renderCands();

    ENG.stop();
    ENG.play(songOfCand(item), { timbre: state.timbre === 'voice' ? 'soft' : state.timbre });

    /* 试听时长按候选自己的速度算：快歌不被截断，慢歌也不用干等 */
    var end = 0;
    item.notes.forEach(function (n) { end = Math.max(end, n.b + n.d); });
    if (cand.timer) clearTimeout(cand.timer);
    cand.timer = setTimeout(stopCandPreview, (end * 60 / (item.bpm || C.BPM) + 0.6) * 1000);
  }

  function stopCandPreview() {
    if (cand.timer) {
      clearTimeout(cand.timer);
      cand.timer = null;
    }
    if (!cand.playing) return;
    cand.playing = false;
    ENG.stop();

    var sheet = cand.source === 'typed' ? $('#sheetInput') : $('#sheetRandom');
    if (sheet && sheet.classList.contains('open')) renderCands();
  }

  function useCand(i) {
    var item = cand.list[i];
    if (!item) return;
    var source = cand.source;
    stopCandPreview();

    var song = songOfCand(item);
    state.voiceBuf = null;          /* 别把上一次的录音当成这次的「原声」 */
    closeSheets();
    showResult(song, { source: source === 'typed' ? 'typed' : 'random' });
  }

  /* ---------- 输入简谱 ---------- */
  function openDegrees() {
    var input = $('#degreeInput');
    if (input) input.value = state.degreeText || '';
    cand.source = 'typed';
    updateDegreeHint();
    buildViewChips();
    renderPrefs();
    buildTypedCands(true);
    openSheet('#sheetInput');
    if (input) setTimeout(function () { input.focus(); }, 140);
  }

  function degreeParsed() {
    var input = $('#degreeInput');
    return COMPOSE.parseDegrees(input ? input.value : '');
  }

  function updateDegreeHint() {
    var hint = $('#degreeHint');
    var go = $('#btnDegreeGo');
    if (!hint || !go) return;

    var p = degreeParsed();
    var sheet = $('#sheetInput');
    var open = !!(sheet && sheet.classList.contains('open'));

    if (p.bad) {
      hint.textContent = '只认 1-7 和 0（0 是停顿），「' + p.bad + '」先去掉';
      go.disabled = true;
      if (open) buildTypedCands(true);
      return;
    }
    if (!p.notes.length) {
      hint.textContent = '写几个数字试试，例如 1 2 3 5 3 2 1';
      go.disabled = true;
      if (open) buildTypedCands(true);
      return;
    }
    hint.textContent = p.notes.length + ' 个音'
      + (p.rests ? ' + ' + p.rests + ' 个停顿' : '')
      + '，一个数字一拍'
      + (p.truncated ? '（最多 16 拍，后面多写的先不用）' : '');
    go.disabled = false;
    if (open) buildTypedCands(true);
  }

  /* 节奏档：自动 / 原拍 / 半拍 / 长音。换了档立刻重出一批候选 */
  var VIEW_CHIPS = [
    { id: 'auto', name: '自动' },
    { id: 'straight', name: '原拍' },
    { id: 'half', name: '半拍' },
    { id: 'long', name: '长音' }
  ];

  function buildViewChips() {
    var box = $('#typedViews');
    if (!box) return;
    box.innerHTML = '';
    VIEW_CHIPS.forEach(function (v) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (cand.view === v.id ? ' on' : '');
      chip.textContent = v.name;
      chip.addEventListener('click', function () {
        if (cand.view === v.id) return;
        cand.view = v.id;
        buildViewChips();
        buildTypedCands(true);
      });
      box.appendChild(chip);
    });
  }

  function typedNotes() {
    var p = degreeParsed();
    return (p.bad || !p.notes.length) ? null : p.notes;
  }

  function buildTypedCands(reroll, keepSeed) {
    cand.source = 'typed';
    var notes = typedNotes();
    if (!notes) {
      cand.list = [];
      cand.idx = -1;
      renderCands();
      return;
    }
    stopCandPreview();
    if ((reroll && !keepSeed) || !cand.notes) cand.seed = GROOVE.newSeed();
    cand.notes = notes;
    cand.list = applyPrefs(COMPOSE.typedBatch(notes, cand.seed,
      { view: cand.view === 'auto' ? '' : cand.view }));
    cand.idx = -1;
    renderCands();
  }

  /* 换一版：选中了就只换选中那条（保留节奏档与速度，做微调），
     没选中就整批重来 */
  function rollTyped() {
    var notes = typedNotes();
    if (!notes) { buildTypedCands(true); return; }
    if (cand.idx < 0 || !cand.list[cand.idx]) { buildTypedCands(true); return; }

    var one = cand.list[cand.idx];
    var next = COMPOSE.typedRoll(notes, GROOVE.newSeed(), {
      view: one.view, bpm: one.bpm, mode: one.mode
    });
    /* 速度沿用这一条已经调过的，只把音高补上，免得「换一版」越换越快 */
    prefShift(next);
    cand.list[cand.idx] = next;
    cand.notes = notes;
    cand.playing = false;
    cand.timer && clearTimeout(cand.timer);
    cand.timer = null;
    ENG.stop();
    renderCands();
    previewCand(cand.idx);
  }

  function makeFromDegrees() {
    var p = degreeParsed();
    if (p.bad || !p.notes.length) {
      updateDegreeHint();
      return;
    }
    var input = $('#degreeInput');
    state.degreeText = input ? input.value : '';
    var song = COMPOSE.buildSong(p.notes);
    state.voiceBuf = null;
    closeSheets();
    showResult(song, { source: 'typed' });
  }

  function openRandom() {
    stopCandPreview();
    cand.source = 'random';
    buildRandomChips();
    renderPrefs();
    buildRandomCands();
    openSheet('#sheetRandom');
  }

  /* ---------- 随机旋律：氛围 × 风格 ---------- */
  var randSel = { vibe: '', style: '' };   /* 空串 = 随机 */

  function chipButton(name, on, onClick) {
    var chip = document.createElement('button');
    chip.className = 'chip' + (on ? ' on' : '');
    chip.textContent = name;
    chip.addEventListener('click', onClick);
    return chip;
  }

  function buildRandomChips() {
    var S = L.STYLE;
    var vBox = $('#vibeRow');
    var sBox = $('#styleRow');

    if (vBox) {
      vBox.innerHTML = '';
      vBox.appendChild(chipButton('随机', randSel.vibe === '', function () {
        randSel.vibe = '';
        buildRandomChips();
        buildRandomCands();
      }));
      S.vibes.forEach(function (v) {
        vBox.appendChild(chipButton(v.name, randSel.vibe === v.id, function () {
          randSel.vibe = v.id;
          buildRandomChips();
          buildRandomCands();
        }));
      });
    }

    if (sBox) {
      sBox.innerHTML = '';
      sBox.appendChild(chipButton('随机', randSel.style === '', function () {
        randSel.style = '';
        buildRandomChips();
        buildRandomCands();
      }));
      S.styles.forEach(function (s) {
        sBox.appendChild(chipButton(s.name, randSel.style === s.id, function () {
          randSel.style = s.id;
          buildRandomChips();
          buildRandomCands();
        }));
      });
    }
  }

  function buildRandomCands(keepSeed) {
    cand.source = 'random';
    stopCandPreview();
    if (!keepSeed) cand.seed = GROOVE.newSeed();
    cand.list = applyPrefs(COMPOSE.melodyBatch(cand.seed,
      { vibe: randSel.vibe, style: randSel.style }));
    cand.idx = -1;
    renderCands();
  }

  function rerollRandoms() {
    buildRandomCands();
  }

  /* ---------- 作品库 ---------- */
  function drawMini(cv, song) {
    var c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    var notes = song ? U.leadNotes(song) : [];
    if (!notes.length) return;
    var minM = 99, maxM = 0;
    notes.forEach(function (n) {
      minM = Math.min(minM, n.m);
      maxM = Math.max(maxM, n.m);
    });
    var X = function (b) { return (b / 16) * (cv.width - 8) + 4; };
    var Y = function (m) {
      return cv.height - 10 - ((m - minM) / Math.max(1, maxM - minM)) * (cv.height - 22);
    };
    c.strokeStyle = 'rgba(255,255,255,.85)';
    c.lineWidth = 2.2;
    c.lineJoin = 'round';
    c.beginPath();
    notes.forEach(function (n, i) {
      if (i === 0) c.moveTo(X(n.b), Y(n.m)); else c.lineTo(X(n.b), Y(n.m));
      c.lineTo(X(n.b + n.d), Y(n.m));
    });
    c.stroke();
  }

  function renderWorks() {
    var box = $('#worksList');
    box.innerHTML = '';
    var list = state.works.filter(function (w) { return w && w.s; });

    if (!list.length) {
      var em = document.createElement('div');
      em.className = 'empty';
      em.innerHTML = '还没有作品<br>哼一段，然后点「存下来」';
      box.appendChild(em);
      return;
    }

    list.forEach(function (w, i) {
      var song = CODEC.decode(w.s);
      var row = document.createElement('div');
      row.className = 'work';

      var mini = document.createElement('div');
      mini.className = 'mini';
      var mc = document.createElement('canvas');
      mc.width = 84; mc.height = 84;
      mini.appendChild(mc);
      drawMini(mc, song);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var b = document.createElement('b');
      b.textContent = w.n || '未命名';
      var sp = document.createElement('span');
      sp.textContent = song ? (keyName(song) + ' · ' + song.bpm + ' BPM') : '已损坏';
      meta.appendChild(b);
      meta.appendChild(sp);

      var acts = document.createElement('div');
      acts.className = 'acts';

      var pb = document.createElement('button');
      pb.className = 'icon-btn';
      pb.textContent = '▶';
      pb.addEventListener('click', function () {
        if (!song) return;
        closeSheets();
        showResult(song);
      });

      var db = document.createElement('button');
      db.className = 'icon-btn danger';
      db.textContent = '✕';
      db.addEventListener('click', function () {
        state.works.splice(i, 1);
        Bridge.saveWorks(state.works);
        renderWorks();
      });

      acts.appendChild(pb);
      acts.appendChild(db);
      row.appendChild(mini);
      row.appendChild(meta);
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  /* ---------- 浮层 ---------- */
  function openSheet(id) { $(id).classList.add('open'); }
  function closeSheets() {
    var band = $('#sheetBand');
    var wasBand = !!(band && band.classList.contains('open'));
    /* 面板上面还压着时间线时，先把它一起关掉（回整队） */
    if (timelineOpen()) {
      L.TIMELINE.close();
      state.seekBeat = 0;
    }
    $$('.sheet').forEach(function (s) { s.classList.remove('open'); });
    if (cand.playing) stopCandPreview();
    /* 关掉乐队面板时回到整队：试听是面板内的临时状态 */
    if (wasBand) {
      previewSel = null;
      previewSolo = false;
      if (state.song && state.playing) replay();
    }
  }
  $$('.sheet').forEach(function (s) {
    s.addEventListener('click', function (e) { if (e.target === s) closeSheets(); });
    var x = s.querySelector('[data-close]');
    if (x) x.addEventListener('click', closeSheets);
  });

  /* ---------- 自检 ---------- */
  function openDiag(err) {
    openSheet('#sheetDiag');
    var text = '';
    if (err) {
      text += '错误      ' + (err.name || '-') + ' ' + (err.message || err) + '\n\n';
    }
    if (state.lastCap) {
      var c = state.lastCap;
      text += '上次采集  方式=' + c.mode
        + ' 回调=' + c.frames
        + ' 采样=' + c.pcm.length
        + ' 峰值=' + c.peak.toFixed(4) + '\n\n';
    }
    text += DIAG.envText();
    $('#diagText').textContent = text;
  }

  function runDiag() {
    var el = $('#diagText');
    el.textContent = '检测中…（约 2 秒，请允许麦克风）';
    DIAG.run().then(function (text) { el.textContent = text; });
  }

  /* ---------- 保存 ---------- */
  var ADJ = ['月亮', '橘子汽水', '夏夜', '海风', '雨天', '霓虹', '凌晨三点', '纸飞机',
    '小行星', '柠檬', '电量不足', '周四'];
  var NOUN = ['小曲', '小调', '絮语', '循环', '心跳', '散步', '圆舞曲', '进行曲', '泡泡'];

  function autoName(song) {
    var seed = song.tonic * 7
      + song.bars.reduce(function (a, b) { return a + b; }, 0)
      + U.leadNotes(song).length;
    return ADJ[seed % ADJ.length] + NOUN[(seed * 3) % NOUN.length];
  }

  function openSave() {
    if (!state.song) return;
    $('#saveName').value = autoName(state.song);
    openSheet('#sheetSave');
  }

  function confirmSave() {
    var name = ($('#saveName').value || '').trim().slice(0, 16) || autoName(state.song);
    Bridge.safety(name).then(function (r) {
      if (r === 'reject') { toast('这个名字不太行，换一个'); return; }
      if (r === 'unknown') { toast('暂时没法验证，稍后再试'); return; }

      var list = state.works.slice();
      if (list.length >= 3) list = list.slice(0, 2);
      list.unshift({ n: name, s: CODEC.encode(state.song) });
      state.works = list.slice(0, 3);

      Bridge.saveWorks(state.works).then(function (where) {
        closeSheets();
        renderWorks();
        toast(where === 'cloud' ? '已存进我的作品（云端）' : '已存进我的作品（本机）');
      });
    });
  }

  /* ---------- 分享 ---------- */
  function sharePath() {
    state.lastCode = CODEC.encode(state.song);
    return 'index.html?s=' + state.lastCode;
  }

  function openShare() {
    if (!state.song) return;
    var path = sharePath();
    Bridge.share(path).then(function (ok) {
      if (ok) { toast('已拉起分享面板'); return; }
      openSheet('#sheetShare');
      Bridge.qr(path, 360).then(function (b64) {
        $('#qrImg').src = b64 || 'https://placehold.co/360x360/12101F/B4AECB?text=QR';
      });
    });
  }

  /* ---------- 海报 ---------- */
  function openPoster() {
    if (!state.song) return;
    openSheet('#sheetPoster');

    var cv = $('#posterCv');
    var W = 540, H = 720;
    cv.width = W * 2;
    cv.height = H * 2;
    var c = cv.getContext('2d');
    c.setTransform(2, 0, 0, 2, 0, 0);

    var g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#FFFCF6');
    g.addColorStop(.55, '#F7F1E5');
    g.addColorStop(1, '#F1EADD');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    var rg = c.createRadialGradient(W * .16, H * .08, 20, W * .16, H * .08, W * .9);
    rg.addColorStop(0, 'rgba(237,223,196,.85)');
    rg.addColorStop(1, 'rgba(237,223,196,0)');
    c.fillStyle = rg;
    c.fillRect(0, 0, W, H);

    var rg2 = c.createRadialGradient(W * .92, H * .86, 10, W * .92, H * .86, W * .8);
    rg2.addColorStop(0, 'rgba(220,231,216,.75)');
    rg2.addColorStop(1, 'rgba(220,231,216,0)');
    c.fillStyle = rg2;
    c.fillRect(0, 0, W, H);

    c.fillStyle = 'rgba(62,58,51,.55)';
    c.font = '600 13px "PingFang SC",system-ui,sans-serif';
    c.fillText('LALABOX', 40, 56);
    c.fillStyle = 'rgba(62,58,51,.32)';
    c.font = '11px "PingFang SC",system-ui,sans-serif';
    c.fillText('哼两句，就成歌', 112, 56);

    c.fillStyle = '#3E3A33';
    c.font = '600 38px "Songti SC","Noto Serif SC",serif';
    c.fillText(autoName(state.song), 40, 148);

    c.fillStyle = 'rgba(62,58,51,.58)';
    c.font = '13px "PingFang SC",system-ui,sans-serif';
    var bandName = instrumentNames(2).join(' · ') || '清唱';
    c.fillText(keyName(state.song) + ' · ' + state.song.bpm + ' BPM · ' + bandName, 40, 182);

    var notes = U.leadNotes(state.song);
    var minM = 99, maxM = 0;
    notes.forEach(function (n) {
      minM = Math.min(minM, n.m);
      maxM = Math.max(maxM, n.m);
    });
    var X = function (b) { return 40 + (b / 16) * (W - 80); };
    var Y = function (m) {
      return 460 - ((m - minM) / Math.max(2, maxM - minM)) * 170;
    };

    c.strokeStyle = 'rgba(62,58,51,.07)';
    c.lineWidth = 1;
    for (var i = 0; i <= 16; i++) {
      c.beginPath();
      c.moveTo(X(i), 300);
      c.lineTo(X(i), 640);
      c.stroke();
    }

    var lg = c.createLinearGradient(40, 0, W - 40, 0);
    lg.addColorStop(0, '#6F8F6C');
    lg.addColorStop(.55, '#8FAE8B');
    lg.addColorStop(1, '#D99C8A');
    c.strokeStyle = lg;
    c.lineWidth = 3;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    notes.forEach(function (n, k) {
      if (k === 0) c.moveTo(X(n.b), Y(n.m)); else c.lineTo(X(n.b), Y(n.m));
      c.lineTo(X(n.b + n.d), Y(n.m));
    });
    c.stroke();

    c.strokeStyle = 'rgba(62,58,51,.16)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(40, 648);
    c.lineTo(W - 40, 648);
    c.stroke();

    c.fillStyle = 'rgba(62,58,51,.45)';
    c.font = '12px "PingFang SC",system-ui,sans-serif';
    c.fillText('扫码听我这首歌', 40, 680);

    state.posterUrl = cv.toDataURL('image/png');

    var path = 'index.html?s=' + CODEC.encode(state.song);
    Bridge.qr(path, 300).then(function (b64) {
      if (!b64) return;
      var img = new Image();
      img.onload = function () {
        c.fillStyle = '#FFFFFF';
        DRAW.rr(c, W - 40 - 118, H - 40 - 118, 118, 118, 14);
        c.fill();
        c.strokeStyle = 'rgba(62,58,51,.12)';
        c.lineWidth = 1;
        c.stroke();
        c.drawImage(img, W - 40 - 110, H - 40 - 110, 102, 102);
        state.posterUrl = cv.toDataURL('image/png');
      };
      img.src = b64;
    });
  }

  function downloadDataUrl(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name || 'lalabox.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function savePoster() {
    var cv = $('#posterCv');
    var url = state.posterUrl || cv.toDataURL('image/png');
    Bridge.saveImage(url).then(function (where) {
      if (where === 'album') { toast('已保存到相册'); return; }
      downloadDataUrl(url, 'lalabox-poster.png');
      toast('已下载到本地');
    });
  }

  /* ---------- 事件 ---------- */
  elMic.addEventListener('click', startRecording);
  $('#btnStopRec').addEventListener('click', stopRecordingNow);
  $('#btnSample').addEventListener('click', playSample);

  /* 不用麦克风的两条入口 */
  $('#btnDegrees').addEventListener('click', openDegrees);
  $('#btnRandom').addEventListener('click', openRandom);
  $('#btnDegreeGo').addEventListener('click', makeFromDegrees);
  $('#btnRandMore').addEventListener('click', rerollRandoms);
  $('#btnRandUse').addEventListener('click', function () { useCand(cand.idx); });
  $('#btnTypedMore').addEventListener('click', rollTyped);
  $('#btnTypedUse').addEventListener('click', function () { useCand(cand.idx); });
  var degreeInput = $('#degreeInput');
  if (degreeInput) {
    degreeInput.addEventListener('input', updateDegreeHint);
    degreeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') makeFromDegrees();
    });
  }

  $('#btnRedo').addEventListener('click', function () {
    ENG.stop();
    state.playing = false;
    syncPlayBtn();
    state.song = null;
    setScreen('idle');
  });

  btnPlay.addEventListener('click', togglePlay);
  $('#btnSave').addEventListener('click', openSave);
  $('#btnSaveConfirm').addEventListener('click', confirmSave);
  $('#btnShare').addEventListener('click', openShare);
  $('#btnShareSys').addEventListener('click', function () {
    if (!state.song) return;
    Bridge.share(sharePath()).then(function (ok) {
      if (!ok) toast('这里不支持系统分享，让朋友扫码吧');
    });
  });
  $('#btnPoster').addEventListener('click', openPoster);
  $('#btnPosterSave').addEventListener('click', savePoster);
  $('#btnDiag').addEventListener('click', function () {
    openSheet('#sheetDiag');
    runDiag();
  });
  $('#btnDiagRun').addEventListener('click', runDiag);
  $('#btnWorks').addEventListener('click', function () {
    renderWorks();
    openSheet('#sheetWorks');
  });

  /* 主音色面板：确认按钮、关闭按钮、点遮罩都要落到「开始播放」 */
  $('#btnVoiceOk').addEventListener('click', applyVoice);
  var voiceSheet = $('#sheetVoice');
  if (voiceSheet) {
    var voiceX = voiceSheet.querySelector('[data-close]');
    if (voiceX) voiceX.addEventListener('click', applyVoice);
    voiceSheet.addEventListener('click', function (e) {
      if (e.target === voiceSheet) setTimeout(applyVoice, 0);
    });
  }

  /* 乐队入口：页面上唯一的圆按钮，改动立即生效，关掉就是保留 */
  $('#btnBand').addEventListener('click', openBand);
  $('#btnBandOk').addEventListener('click', closeSheets);

  /* 乐器 / 氛围 页签：共用同一个面板，切换只换列表，不跳页 */
  if (elBandTabs) {
    elBandTabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-tab]') : null;
      if (!b || !elBandTabs.contains(b)) return;
      setBandTab(b.getAttribute('data-tab'));
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) return;
    if (rec && !rec.done) stopRecordingNow();
    if (state.playing) {
      ENG.stop();
      state.playing = false;
      syncPlayBtn();
    }
  });
  window.addEventListener('pagehide', function () {
    Bridge.releaseMic();
    ENG.stop();
  });

  /* ---------- 主循环 ---------- */
  var lastTick = 0, phase = 0;

  function tickRecord() {
    var t = ENG.now();
    var count = Math.ceil((rec.beat0 - t) / SPB);

    if (t < rec.beat0) {
      var slot = Math.floor((t - (rec.beat0 - 4 * SPB)) / SPB);
      var act = ((slot % 4) + 4) % 4;
      elBeatLights.forEach(function (b, i) { b.classList.toggle('on', i === act); });
      elRecCount.classList.remove('small');
      elRecCount.textContent = Math.max(1, Math.min(4, count));
      elRecHint.textContent = '听到「哒」就开口';
    } else {
      elRecCount.classList.add('small');
      elRecCount.textContent = '正在录';
      var left = Math.max(0, Math.ceil((rec.end - t) / SPB));
      elBeatLights.forEach(function (b, i) {
        b.classList.toggle('on', Math.floor((t - rec.beat0) / SPB) % 4 === i);
      });
      elRecHint.textContent = left > 0 ? '继续哼，还有 ' + left + ' 拍' : '收工';
    }

    var ml = U.clamp(ENG.micLevel() * 5.5, 0, 1);
    elLevelBar.style.width = (ml * 100).toFixed(0) + '%';
    elLevelWrap.classList.toggle('low', ml < 0.14);
    if (t > rec.beat0 + 0.6 && ENG.micPeak() < 0.004) {
      elRecHint.textContent = '没听到声音，检查麦克风权限';
    } else if (t > rec.beat0 && ml < 0.12) {
      elRecHint.textContent = '有点小声，靠近一点';
    }

    DRAW.record(elCvRec, ENG.micSpectrum(), ml, phase);
    if (t >= rec.end) stopRecordingNow();
  }

  function tick(ts) {
    requestAnimationFrame(tick);
    if (document.hidden) return;
    if (ts - lastTick < 30) return;
    lastTick = ts;
    phase += 0.026;

    if (state.screen === 'record' && rec) {
      tickRecord();
    } else if (state.screen === 'result' && state.song) {
      if (state.playing) {
        ENG.pump();
        if (!ENG.isPlaying()) { state.playing = false; syncPlayBtn(); }
      }
      if (timelineOpen()) {
        /* 时间线铺满屏幕，底下的画布不用再画 */
        L.TIMELINE.tick(nowBeat());
      } else if (!resultScreen.classList.contains('analyzing')) {
        /* 暂停后指针停在播放头，方便对着画布看位置 */
        var pos = nowBeat();
        DRAW.melody(elCvMelody, state.song, pos);
        DRAW.band(elCvBand, state.song, pos);
      }
    }
  }

  /* ---------- 初始化 ---------- */
  function init() {
    if ((navigator.hardwareConcurrency || 4) < 4) document.body.classList.add('lite');
    try { ENG.init(); } catch (e) {}
    Bridge.onViewport(function () {});
    Bridge.can('requestMicrophone');

    var code = null;
    try {
      var q = new URLSearchParams(location.search);
      state.forceRec = q.get('rec') === '1';
      code = q.get('s');
    } catch (e) {}
    var shared = code ? CODEC.decode(code) : null;
    if (shared) {
      setTimeout(function () {
        showResult(shared, { autoplay: false });
        toast('这是朋友分享给你的歌，点播放听听', 3000);
      }, 260);
    }

    Bridge.loadWorks().then(function (list) {
      state.works = list || [];
      renderWorks();
    });

    requestAnimationFrame(tick);
  }

  /* e2e / 排障用：只读引用当前歌曲，脚本好断言旋律有没有跟着片段走 */
  L.__song = function () { return state.song; };

  init();
})();
