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

  var $ = U.$;
  var $$ = U.$$;
  var SPB = C.SPB;

  var state = {
    screen: 'idle', song: null, playing: false,
    works: [], micBusy: false, posterUrl: '', lastCode: ''
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
  var elChips = $('#styleChips');
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
  function buildChips() {
    elChips.innerHTML = '';
    C.STYLE_ORDER.forEach(function (k) {
      var b = document.createElement('button');
      b.className = 'chip' + (k === state.song.style ? ' on' : '');
      b.textContent = C.STYLE_LABEL[k];
      b.addEventListener('click', function () {
        if (!state.song || state.song.style === k) return;
        state.song.style = k;
        state.song._arr = null;
        $$('.chip', elChips).forEach(function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        if (state.playing) ENG.play(state.song);
        syncPlayBtn();
      });
      elChips.appendChild(b);
    });
  }

  function syncPlayBtn() {
    btnPlay.innerHTML = state.playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.6-6.8c.6-.4.6-1.4 0-1.8L9.6 4.3c-.7-.4-1.6.1-1.6.9z"/></svg>';
  }

  function showResult(song, opts) {
    state.song = song;
    song._arr = null;
    $('#badgeKey').textContent = keyName(song);
    $('#badgeBpm').textContent = song.bpm + ' BPM';
    buildChips();
    resultScreen.classList.remove('analyzing');
    setScreen('result');

    var autoplay = !opts || opts.autoplay !== false;
    if (autoplay) {
      ENG.play(song);
      state.playing = true;
    } else {
      ENG.stop();
      state.playing = false;
    }
    syncPlayBtn();
    requestAnimationFrame(function () {
      DRAW.melody(elCvMelody, song, 0);
      DRAW.band(elCvBand, song, 0);
    });
  }

  function togglePlay() {
    if (!state.song) return;
    if (state.playing) {
      ENG.stop();
      state.playing = false;
    } else {
      ENG.play(state.song);
      state.playing = true;
    }
    syncPlayBtn();
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
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      toast(denied ? '麦克风没被允许，看「麦克风自检」' : '没拿到麦克风，看「麦克风自检」', 3000);
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

    if (cap.pcm.length && cap.peak >= 0.005) {
      blobP.catch(function () {});
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
      if (!notes || notes.length < 3) {
        resultScreen.classList.remove('analyzing');
        setScreen('idle');
        toast('没太听清…靠近麦克风再哼一次？', 3000);
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
      v: 1, bpm: C.BPM, tonic: 9, mode: 'minor', style: 'pop',
      bars: [9, 5, 0, 7], notes: notes
    };
    ENG.resume().then(function () { showResult(song); });
  }

  /* ---------- 作品库 ---------- */
  function drawMini(cv, song) {
    var c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    if (!song || !song.notes.length) return;
    var minM = 99, maxM = 0;
    song.notes.forEach(function (n) {
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
    song.notes.forEach(function (n, i) {
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
    $$('.sheet').forEach(function (s) { s.classList.remove('open'); });
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
      + song.notes.length;
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
    c.fillText(keyName(state.song) + ' · ' + state.song.bpm + ' BPM · '
      + C.STYLE_LABEL[state.song.style], 40, 182);

    var minM = 99, maxM = 0;
    state.song.notes.forEach(function (n) {
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
    state.song.notes.forEach(function (n, k) {
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
      if (!resultScreen.classList.contains('analyzing')) {
        var pos = state.playing ? ENG.beatPos() : 0;
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
    try { code = new URLSearchParams(location.search).get('s'); } catch (e) {}
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

  init();
})();
