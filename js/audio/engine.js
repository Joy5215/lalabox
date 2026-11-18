/* ============================================================
 * audio/engine.js — Web Audio 合成引擎
 * 鼓组 / 贝斯 / 和弦 / 主旋律全部现场合成，无采样素材。
 * 播放：一次排完整个循环（4 小节），rAF 中提前补下一循环。
 * 暴露：LALA.ENG
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var C = L.C;

  var ctx = null;
  var master = null, comp = null, analyser = null, revIn = null;
  var noiseBuf = null, shaper = null;
  var session = null, playStart = 0, cycles = 0, songDur = 0, curSong = null;
  /* 循环窗口（拍）：默认整圈 0~16。试听单个片段时把窗口收到那一段，
     songDur 跟着变成那一段的长度，于是「这一段」自己就能无缝循环 */
  var winFrom = 0, winTo = L.util.LOOP_BEATS;
  var ambHandle = null;   /* 氛围层的总句柄，play 起 / stop 收，不参与排程 */
  var voiceGate = null, voiceClips = null;   /* 人声层的片段开关 + 它当前有几段 */
  var curSpb = 0;   /* 当前这首歌的每拍秒数，play 时按 song.bpm 定 */
  var cap = null, freqData = null, micData = null;

  function init() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.82;

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 22;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.82;

    master.connect(comp);
    comp.connect(analyser);
    analyser.connect(ctx.destination);

    var conv = ctx.createConvolver();
    conv.buffer = makeIR(1.9, 2.4);
    revIn = ctx.createGain();
    revIn.gain.value = 0.5;
    revIn.connect(conv);
    conv.connect(master);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    var n = 1024, curve = new Float32Array(n);
    for (var k = 0; k < n; k++) {
      var x = k * 2 / n - 1;
      curve[k] = Math.tanh(x * 3.4);
    }
    shaper = ctx.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = '2x';

    freqData = new Uint8Array(analyser.frequencyBinCount);
    return ctx;
  }

  function makeIR(dur, decay) {
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var arr = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        arr[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function resume() {
    init();
    if (ctx.state === 'suspended') return ctx.resume().catch(function () {});
    return Promise.resolve();
  }

  /* iOS / 部分 WebView 必须在用户手势内播一段静音才能解锁音频 */
  function unlock() {
    init();
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    try {
      var b = ctx.createBuffer(1, 1, ctx.sampleRate);
      var s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch (e) {}
  }
  function now() { return ctx ? ctx.currentTime : 0; }

  /* ---------- 音色 ---------- */
  /* 鼓组三套：acoustic 原声鼓 / electro 电子鼓 / hand 手鼓，只调数值不改结构 */
  var DRUM_KIT = {
    acoustic: {
      kick:  { f0: 150, f1: 42, dec: 0.46, g: 0.86, nz: 0.06 },
      snare: { band: 1600, q: 0.7, dec: 0.26, g: 0.34, body: 0.24 },
      hat:   { hp: 6400, dec: 1.25, g: 0.26 },
      clap:  { band: 1150, q: 1.1, g: 0.26 }
    },
    electro: {
      kick:  { f0: 128, f1: 36, dec: 0.64, g: 1, nz: 0 },
      snare: { band: 2400, q: 1.6, dec: 0.12, g: 0.42, body: 0.12 },
      hat:   { hp: 9000, dec: 0.5, g: 0.3 },
      clap:  { band: 1500, q: 2, g: 0.34 }
    },
    hand: {
      kick:  { f0: 98, f1: 58, dec: 0.3, g: 0.9, nz: 0.5 },
      snare: { band: 950, q: 1.2, dec: 0.16, g: 0.34, body: 0.36 },
      hat:   { hp: 5200, dec: 0.55, g: 0.18 },
      clap:  { band: 800, q: 1.4, g: 0.3 }
    }
  };

  function kick(t, v, out, k) {
    k = k || DRUM_KIT.acoustic.kick;
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(k.f0, t);
    o.frequency.exponentialRampToValueAtTime(k.f1, t + 0.12);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.92 * v * k.g, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + k.dec);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + k.dec + 0.04);

    /* 原声鼓的鼓皮声、手鼓的掌击声，电子鼓没有这一层 */
    if (k.nz) {
      var nb = ctx.createBufferSource();
      nb.buffer = noiseBuf;
      var nf = ctx.createBiquadFilter();
      nf.type = 'lowpass'; nf.frequency.value = 700; nf.Q.value = 0.8;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(k.nz * v, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      nb.connect(nf); nf.connect(ng); ng.connect(out);
      nb.start(t, Math.random() * 1.2); nb.stop(t + 0.1);
    }

    o.onended = function () { try { g.disconnect(); } catch (e) {} };
  }

  function snare(t, v, out, k) {
    k = k || DRUM_KIT.acoustic.snare;
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = k.band; f.Q.value = k.q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * v * k.g, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + k.dec);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random() * 1.4); s.stop(t + k.dec + 0.02);

    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(118, t + 0.1);
    var g2 = ctx.createGain();
    g2.gain.setValueAtTime(k.body * v, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g2); g2.connect(out);
    o.start(t); o.stop(t + 0.14);
    o.onended = function () { try { g2.disconnect(); } catch (e) {} };
  }

  function hat(t, v, open, out, k) {
    k = k || DRUM_KIT.acoustic.hat;
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = k.hp;
    var g = ctx.createGain();
    var dur = (open ? 0.17 : 0.045) * k.dec;
    g.gain.setValueAtTime(k.g * v * (open ? 1.15 : 1), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.03);
  }

  function clap(t, v, out, k) {
    k = k || DRUM_KIT.acoustic.clap;
    for (var i = 0; i < 3; i++) {
      (function (tt) {
        var s = ctx.createBufferSource();
        s.buffer = noiseBuf;
        var f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = k.band; f.Q.value = k.q;
        var g = ctx.createGain();
        g.gain.setValueAtTime(k.g * v, tt);
        g.gain.exponentialRampToValueAtTime(0.001, tt + 0.09);
        s.connect(f); f.connect(g); g.connect(out);
        s.start(tt, Math.random() * 1.3); s.stop(tt + 0.11);
      })(t + i * 0.014);
    }
  }

  /* 贝斯四种：波形 + 低通包络 + 子振荡比例 + 拨弦噪声 */
  var BASS_SPEC = {
    finger:  { wave: 'triangle', sub: 0.5, cut: 4.2, cutEnd: 1.4, q: 1.2, atk: 0.018, life: 1,    peak: 0.46, nz: 0.05 },
    pick:    { wave: 'sawtooth', sub: 0.4, cut: 9,   cutEnd: 2.4, q: 6,   atk: 0.006, life: 0.9,  peak: 0.34, nz: 0.12 },
    synth:   { wave: 'square',   sub: 0.7, cut: 12,  cutEnd: 1.6, q: 8,   atk: 0.006, life: 1,    peak: 0.3,  nz: 0 },
    upright: { wave: 'sine',     sub: 0.9, cut: 3,   cutEnd: 1.2, q: 1.6, atk: 0.03,  life: 1.1,  peak: 0.52, nz: 0.07 }
  };

  function bass(t, m, d, v, out, id) {
    var s = BASS_SPEC[id] || BASS_SPEC.finger;
    var f = L.util.midiHz(m);
    var life = Math.max(0.1, d) * s.life;

    var o = ctx.createOscillator();
    o.type = s.wave; o.frequency.value = f;
    var sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = f / 2;
    var subG = ctx.createGain();
    subG.gain.value = s.sub;

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = s.q;
    lp.frequency.setValueAtTime(Math.min(1800, f * s.cut), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(120, f * s.cutEnd), t + Math.max(0.07, life * 0.7));

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.peak * v, t + s.atk);
    g.gain.exponentialRampToValueAtTime(0.001, t + life);

    o.connect(lp); sub.connect(subG); subG.connect(lp); lp.connect(g); g.connect(out);
    o.start(t); sub.start(t);
    var stopAt = t + life + 0.06;
    o.stop(stopAt); sub.stop(stopAt);

    /* 拨片/手指碰到琴弦的那一下 */
    if (s.nz) {
      var nb = ctx.createBufferSource();
      nb.buffer = noiseBuf;
      var nf = ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 1400; nf.Q.value = 0.8;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(s.nz * v, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
      nb.connect(nf); nf.connect(ng); ng.connect(out);
      nb.start(t, Math.random() * 1.5); nb.stop(t + 0.05);
    }

    o.onended = function () { try { g.disconnect(); } catch (e) {} };
  }

  /* 和音六种：波表 + 叠音数 + 滤波截止 + 起落速度
     strum 是扫弦/琶音的错开量，harmDec 是谐波衰减时间（0 表示像风琴一样一直持续），
     nz 是触弦噪声，drive 走失真 */
  var CHORD_SPEC = {
    piano:   { wave: 'triangle', voices: 1, detune: 0, atk: 0.004, rel: 0.3,  cut: 3800, peak: 0.5,  send: 0.22, hold: 0.14, oct: 0.3,  harm: true,  harmDec: 0.7,  drive: false, nz: 0.05, strum: 0 },
    guitar:  { wave: 'sawtooth', voices: 1, detune: 0, atk: 0.005, rel: 0.18, cut: 1800, peak: 0.36, send: 0.2,  hold: 0.16, oct: 0.1,  harm: false, harmDec: 0,    drive: false, nz: 0.1,  strum: 0.014 },
    eguitar: { wave: 'sawtooth', voices: 2, detune: 4, atk: 0.006, rel: 0.12, cut: 2400, peak: 0.34, send: 0.08, hold: 0.6,  oct: 0,    harm: false, harmDec: 0,    drive: true,  nz: 0.08, strum: 0.01 },
    guzheng: { wave: 'triangle', voices: 2, detune: 6, atk: 0.003, rel: 0.16, cut: 5200, peak: 0.42, send: 0.24, hold: 0.1,  oct: 0.34, harm: true,  harmDec: 0.5,  drive: false, nz: 0.08, strum: 0.022 },
    ep:      { wave: 'triangle', voices: 1, detune: 0, atk: 0.008, rel: 0.09, cut: 2400, peak: 0.44, send: 0.2,  hold: 0.45, oct: 0.22, harm: false, harmDec: 0,    drive: false, nz: 0,    strum: 0 },
    organ:   { wave: 'sine',     voices: 1, detune: 0, atk: 0.012, rel: 0.05, cut: 3200, peak: 0.5,  send: 0.12, hold: 0.85, oct: 0,    harm: true,  harmDec: 0,    drive: false, nz: 0,    strum: 0 }
  };

  function chord(t, midis, d, v, out, id) {
    var s = CHORD_SPEC[id] || CHORD_SPEC.piano;
    var dur = Math.max(0.18, d);
    var stride = s.strum || 0;
    var lastAt = t + Math.max(0, midis.length - 1) * stride;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.peak * v, t + s.atk);
    g.gain.setTargetAtTime(0.0006, t + Math.max(s.atk, dur * s.hold), s.rel);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.value = s.cut;
    lp.connect(g); g.connect(out);

    var send = ctx.createGain();
    send.gain.value = s.send;
    g.connect(send); send.connect(revIn);

    /* 每个和弦自己一份失真器，不能用全局那一个，否则叠音时会互相抢连接 */
    var entry = lp;
    if (s.drive) {
      var ws = ctx.createWaveShaper();
      ws.curve = shaper.curve;
      ws.oversample = '2x';
      ws.connect(lp);
      entry = ws;
    }

    /* 拨片、指甲、琴槌碰到弦的那一下 */
    if (s.nz > 0) {
      var nb = ctx.createBufferSource();
      nb.buffer = noiseBuf;
      var nf = ctx.createBiquadFilter();
      nf.type = 'bandpass'; nf.frequency.value = 2800; nf.Q.value = 1;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(s.nz * v, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      nb.connect(nf); nf.connect(ng); ng.connect(entry);
      nb.start(t, Math.random() * 1.5); nb.stop(t + 0.06);
    }

    /* 扫弦 / 刮奏：每个音错开一点起音，别做成风琴那样的齐奏 */
    midis.forEach(function (m, idx) {
      var at = t + idx * stride;
      var f = L.util.midiHz(m);

      for (var i = 0; i < s.voices; i++) {
        var o = ctx.createOscillator();
        o.type = s.wave;
        o.frequency.value = f;
        o.detune.value = s.voices === 1 ? 0 : (i - (s.voices - 1) / 2) * s.detune;
        o.connect(entry);
        o.start(at); o.stop(at + dur + 0.5);
      }

      if (s.oct > 0) {
        var o2 = ctx.createOscillator();
        o2.type = 'sine'; o2.frequency.value = f * 2;
        var g2 = ctx.createGain(); g2.gain.value = s.oct;
        o2.connect(g2); g2.connect(entry);
        o2.start(at); o2.stop(at + dur + 0.4);
      }

      if (s.harm) {
        [[2, 0.45], [3, 0.2], [4, 0.1]].forEach(function (h) {
          var o3 = ctx.createOscillator();
          o3.type = 'sine'; o3.frequency.value = f * h[0];
          var g3 = ctx.createGain();
          if (s.harmDec > 0) {
            /* 钢琴、拨弦：高次泛音比基频先消失，才像真乐器 */
            g3.gain.setValueAtTime(h[1], at);
            g3.gain.exponentialRampToValueAtTime(0.0005, at + s.harmDec);
          } else {
            g3.gain.value = h[1];
          }
          o3.connect(g3); g3.connect(entry);
          o3.start(at); o3.stop(at + dur + 0.4);
        });
      }
    });

    /* 清理要按音频时钟算：整个循环是提前排好的，靠后的和弦可能在 2 秒后才响，
       按「现在 + dur」直接断开会让那些音块还没出声就被掐掉 */
    var endAt = lastAt + dur + 0.6;
    setTimeout(function () {
      try { g.disconnect(); lp.disconnect(); } catch (e) {}
    }, Math.max(60, (endAt - ctx.currentTime) * 1000 + 200));
  }

  /* 主音音色：type 波形，harm 二次谐波比例，vib 颤音深度(音分)，
     attack 起音时长，tail 有值表示打击型音色、按固定时长衰减 */
  var VOICE_SPEC = {
    soft:    { type: 'triangle', harm: 0.16, vib: 3.5, attack: 0.022 },
    piano:   { type: 'sine',     harm: 0.34, vib: 0,   attack: 0.006, tail: 0.55 },
    guitar:  { type: 'sawtooth', harm: 0.3,  vib: 0,   attack: 0.005, tail: 0.45 },
    guzheng: { type: 'triangle', harm: 0.4,  vib: 5.6, attack: 0.004, tail: 0.7 },
    chip:    { type: 'square',   harm: 0,    vib: 0,   attack: 0.004, tail: 0.26 },
    flute:   { type: 'sine',     harm: 0.06, vib: 4.2, attack: 0.052 }
  };

  /* 当前播放配置：乐器清单直接读 song.band（每件自带曲调与音量），
     这里只剩主音色与「要不要放主旋律」两个开关 */
  var playCfg = { timbre: 'soft', lead: true, voiceFx: 'raw', voiceVol: 1 };

  function lead(t, m, d, v, out, timbre) {
    var s = VOICE_SPEC[timbre] || VOICE_SPEC.soft;
    var f = L.util.midiHz(m);
    var dur = Math.max(0.16, d);
    var fall = s.tail ? Math.min(dur, s.tail) : dur;

    var o = ctx.createOscillator();
    o.type = s.type; o.frequency.value = f;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.26 * v, t + s.attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + fall);

    o.connect(g); g.connect(out);
    var started = [o];

    if (s.harm > 0) {
      var o2 = ctx.createOscillator();
      o2.type = 'sine'; o2.frequency.value = f * 2;
      var g2 = ctx.createGain(); g2.gain.value = s.harm;
      o2.connect(g2); g2.connect(g);
      started.push(o2);
    }
    if (s.vib > 0) {
      var lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 5.2;
      var lfoGain = ctx.createGain(); lfoGain.gain.value = s.vib;
      lfo.connect(lfoGain); lfoGain.connect(o.frequency);
      started.push(lfo);
    }

    var send = ctx.createGain(); send.gain.value = 0.22;
    g.connect(send); send.connect(revIn);

    started.forEach(function (n) { n.start(t); n.stop(t + fall + 0.06); });
    o.onended = function () { try { g.disconnect(); } catch (e) {} };
  }

  function blip(t, freq, v) {
    var o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.26 * v, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.11);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.13);
  }

  function metronome(t0, spb, beats) {
    for (var i = 0; i < beats; i++) {
      blip(t0 + i * spb, i === 0 ? 1320 : 990, i === 0 ? 0.9 : 0.6);
    }
  }

  /* ---------- 排程 ---------- */
  /* 事件里的 bi 指回 song.band 的那件乐器：音色、音量、鼓组都取它自己的，
     一件乐器一份事件，不再按层聚合 */
  function renderSong(song, base, out) {
    var evs = L.ARRANGE.arrange(song);
    var band = song.band || [];
    var spb = L.util.spbOf(song);
    /* seek 起播时 base 可能落在过去：已经过去的拍不要再补排，否则会一起炸出来 */
    var earliest = ctx.currentTime - 0.006;

    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      /* 循环窗口外的音不要：不然起播的那一刻会把窗口前面的事件一起排进来 */
      if (e.b < winFrom - 1e-6 || e.b >= winTo - 1e-6) continue;
      var t = base + e.b * spb;
      /* 时值截到窗口终点：跨过循环点的音不该盖住下一圈的开头 */
      var d = Math.min((e.d || 0.25), winTo - e.b) * spb;
      if (t < earliest) continue;

      if (e.t === 'lead') {
        /* 主旋律已经是 band 里的 lead 轨：音色 / 音量 / 静音都跟着那一条走。
           id='voice' 时由下面的录音循环发声，这里只补八度 / 电音那层合成音 */
        var leadIt = band[e.bi];
        if (leadIt) {
          var lv = leadIt.vol === undefined ? 1 : leadIt.vol;
          if (leadIt.id === 'voice') {
            var vf = playCfg.voiceFx;
            if (vf === 'octave' || vf === 'tune') {
              lead(t, e.m + (vf === 'octave' ? 12 : 0), d, e.v * lv * 0.72,
                out, vf === 'octave' ? 'guzheng' : 'soft');
            }
          } else {
            lead(t, e.m, d, e.v * lv, out, leadIt.id);
          }
          continue;
        }
        /* 老数据 / 候选试听：没有 lead 轨，仍按主音色面板那一套走 */
        var vfx = playCfg.voiceFx;
        var vocal = playCfg.timbre === 'voice';
        var dub = vocal && (vfx === 'octave' || vfx === 'tune');
        if (playCfg.lead && (!vocal || dub)) {
          var shift = (vocal && vfx === 'octave') ? 12 : 0;
          var tim = vocal ? (vfx === 'octave' ? 'guzheng' : 'soft') : playCfg.timbre;
          lead(t, e.m + shift, d, e.v * (vocal ? 0.72 : 1), out, tim);
        }
        continue;
      }

      var it = band[e.bi];
      if (!it) continue;
      var vol = it.vol === undefined ? 1 : it.vol;

      if (e.t === 'bass') {
        bass(t, e.m, d, e.v * vol, out, it.id);
        continue;
      }

      if (e.t === 'chord') {
        chord(t, e.ms, d, e.v * vol, out, it.id);
        continue;
      }

      /* 剩下的都是鼓：用这件乐器自己的鼓组参数 */
      var kit = DRUM_KIT[it.id] || DRUM_KIT.acoustic;
      var v = e.v * vol;
      switch (e.t) {
        case 'kick': kick(t, v, out, kit.kick); break;
        case 'snare': snare(t, v, out, kit.snare); break;
        case 'hat': hat(t, v, false, out, kit.hat); break;
        case 'openhat': hat(t, v, true, out, kit.hat); break;
        case 'clap': clap(t, v, out, kit.clap); break;
      }
    }
  }

  function play(song, opts) {
    opts = opts || {};
    init();
    stop();
    curSong = song;
    playCfg.timbre = opts.timbre || 'soft';
    playCfg.lead = opts.lead !== false;
    playCfg.voiceFx = opts.voiceFx || 'raw';
    playCfg.voiceVol = opts.voiceVol === undefined ? 1 : opts.voiceVol;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});

    var g = ctx.createGain();
    g.gain.value = 0.92;
    g.connect(master);
    session = g;

    curSpb = L.util.spbOf(song);
    /* 循环窗口：opts.loop = {from,to} 只循环这一小段（试听单个片段用）。
       落在窗口外的 seekBeat 会被夹回窗口起点，免得一开声就是静音 */
    var loop = opts.loop;
    var lf = (loop && typeof loop.from === 'number') ? loop.from : 0;
    var lt = (loop && typeof loop.to === 'number') ? loop.to : L.util.LOOP_BEATS;
    lf = L.util.clamp(lf, 0, L.util.LOOP_BEATS);
    lt = L.util.clamp(lt, 0, L.util.LOOP_BEATS);
    if (lt - lf < L.util.MIN_CLIP) { lf = 0; lt = L.util.LOOP_BEATS; }
    winFrom = lf;
    winTo = lt;
    songDur = (lt - lf) * curSpb;
    /* 从第几拍起播：playStart 往前挪这么多，beatPos() 的公式天然就从该拍开始数。
       定位发生在播放中时，app 会重新调一次 play()，所以这里不用做热切换 */
    var seek = (typeof opts.seekBeat === 'number' && isFinite(opts.seekBeat)) ? opts.seekBeat : 0;
    if (!(seek >= lf && seek < lt - 1e-6)) seek = lf;
    playStart = ctx.currentTime + 0.16 - (seek - lf) * curSpb;
    cycles = 0;

    /* 主旋律是 lead 轨，选「我的原声」时它就是录音循环；乐队里另加的 voice 轨
       仍是平行声部。两者都按片段区间开门，静音时不排声音 */
    var leadVoice = null, bandVoice = null;
    for (var bv = 0; bv < (song.band || []).length; bv++) {
      var bit = song.band[bv];
      if (!bit || bit.mute) continue;
      if (bit.k === 'lead' && bit.id === 'voice') leadVoice = bit;
      else if (bit.k === 'voice') bandVoice = bit;
    }
    if (opts.voiceBuf) {
      var vs = opts.voiceStart || 0;
      var vd = opts.voiceDur || 8 * curSpb;
      var vrate = opts.voiceRate || 1;
      var gate = leadVoice || bandVoice;
      if (gate) {
        var vclips = L.util.bandClips(gate);
        var vfull = vclips.length === 1 && L.util.isFullWindow(vclips[0]) && !vclips[0].mute;
        voiceGate = ctx.createGain();
        voiceGate.gain.value = vfull ? 1 : 0.0001;
        voiceGate.connect(g);
        voiceClips = vclips;
        startVoiceLoop(opts.voiceBuf, vs, vd, voiceGate,
          gate.vol === undefined ? (leadVoice ? 1 : 0.8) : gate.vol, undefined, vrate);
      } else if (playCfg.lead && playCfg.timbre === 'voice') {
        /* 老数据 / 候选试听：还没有 lead 轨，原声当主音时没有 gate，
           seek 不做乐句对齐，从录音起点照放 */
        startVoiceLoop(opts.voiceBuf, vs, vd, g, undefined, undefined, vrate);
      }
    }
    /* 氛围层是贯穿整首的铺底，不进 4 小节排程：在这里起一次，stop 里收 */
    startAmbience(song.band, g);
    pump();
  }

  function pump() {
    if (!session || !curSong) return;
    var guard = 0;
    while (session && playStart + cycles * songDur < ctx.currentTime + 2.2 && guard++ < 6) {
      var base = playStart + cycles * songDur;
      /* renderSong 认的是「这一圈的 0 拍」，窗口起播时把基准挪到窗口起点 */
      renderSong(curSong, base - winFrom * curSpb, session);
      /* 人声与氛围不走进 renderSong：它们按片段区间逐循环开关 */
      renderClips(base, curSpb);
      cycles++;
    }
  }

  function stop() {
    stopAmbience();
    stopVoice();
    stopPreview();
    voiceGate = null;
    voiceClips = null;
    if (session) {
      var s = session;
      session = null;
      try {
        s.gain.cancelScheduledValues(ctx.currentTime);
        s.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      } catch (e) {}
      setTimeout(function () { try { s.disconnect(); } catch (e) {} }, 520);
    }
  }

  /* ---------- 原声 / 试听 ---------- */
  var voiceSrc = null, previewSrc = null, previewBus = null;

  /* 程序生成的噪声脉冲，够混响用，也不用外挂音频文件 */
  var reverbBuf = null;
  function impulseBuf(sec, decay) {
    if (reverbBuf) return reverbBuf;
    var n = Math.round(ctx.sampleRate * sec);
    var b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch);
      for (var i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    reverbBuf = b;
    return b;
  }

  /* 人声效果链。返回一个输入节点，录音源接上去就行。
     八度 / 电音不在这里做变调（Web Audio 没有便宜的移调），
     它们靠 renderSong 里的合成音叠加，见 lead 那段 */
  function voiceChain(out, fx, spb, vol) {
    var inp = ctx.createGain();
    inp.gain.value = vol === undefined ? playCfg.voiceVol : vol;

    if (fx === 'reverb') {
      var dry = ctx.createGain(); dry.gain.value = 0.72;
      var wet = ctx.createGain(); wet.gain.value = 0.55;
      var conv = ctx.createConvolver();
      conv.buffer = impulseBuf(1.6, 3);
      inp.connect(dry); dry.connect(out);
      inp.connect(conv); conv.connect(wet); wet.connect(out);
      return inp;
    }

    if (fx === 'delay') {
      var dly = ctx.createDelay(1.6);
      dly.delayTime.value = Math.max(0.12, (spb || C.SPB) * 0.5);
      var fb = ctx.createGain(); fb.gain.value = 0.3;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
      var wet2 = ctx.createGain(); wet2.gain.value = 0.4;
      inp.connect(out);
      inp.connect(dly); dly.connect(lp);
      lp.connect(fb); fb.connect(dly);
      lp.connect(wet2); wet2.connect(out);
      return inp;
    }

    inp.connect(out);
    return inp;
  }

  /* 氛围层：只认 song.band 里 k === 'amb' 的项，合成配方在 audio/ambience.js。
     整体接到播放 session 上，所以 stop() 淡出 session 时它也跟着走 */
  function startAmbience(band, out) {
    stopAmbience();
    if (!L.AMB || !band) return;
    var items = [];
    for (var i = 0; i < band.length; i++) {
      if (band[i] && band[i].k === 'amb') items.push(band[i]);
    }
    if (!items.length) return;
    ambHandle = L.AMB.start(ctx, out, items, noiseBuf);
  }

  function stopAmbience() {
    var h = ambHandle;
    ambHandle = null;
    if (!h) return;
    try { h.stop(); } catch (e) {}
  }

  /* 一段区间的开关包络：整段直接 1，局部区间两端淡入淡出。
     base 早于现在（seek 落在段内）时从「现在」短淡入开门，不补过去的时间点 */
  function scheduleGate(param, base, spb, from, to, winLen) {
    var now = ctx.currentTime;
    var t0 = base + from * spb;
    var t1 = base + to * spb;
    if (t1 <= now + 0.004) return;                 /* 这一段整个已经过去了 */
    var span = (winLen > 0) ? winLen : L.util.LOOP_BEATS;
    /* 「整窗口」= 这一段正好盖住这一圈：给 1 并跨圈不断开，别每圈淡出再淡入 */
    var full = from <= 0 && to >= span - 1e-6;
    var len = Math.max(0.05, t1 - t0);
    var fade = Math.max(0.02, Math.min(0.35, len * 0.3));
    var open;

    if (t0 < now) {
      /* 从中途进来：立刻开门，淡入压在剩下的时长里 */
      open = now;
      param.setValueAtTime(0.0001, now);
      param.linearRampToValueAtTime(1, now + Math.min(0.08, Math.max(0.015, (t1 - now) * 0.4)));
    } else if (full) {
      param.setValueAtTime(1, t0);
      return;                                      /* 整段跨循环不断开 */
    } else {
      open = t0;
      param.setValueAtTime(0.0001, t0);
      param.linearRampToValueAtTime(1, t0 + fade);
    }
    if (full) return;
    param.setValueAtTime(1, Math.max(open, t1 - fade));
    param.linearRampToValueAtTime(0.0001, t1);
  }

  /* 每个 16 拍循环调一次：氛围的 gate 与人声的 gate 都按自己的每一段排 */
  function renderClips(base, spb) {
    if (!(spb > 0)) return;
    var span = winTo - winFrom;
    if (ambHandle && ambHandle.render) ambHandle.render(base, spb, winFrom, winTo);
    if (voiceGate && voiceClips) {
      voiceClips.forEach(function (c) {
        if (c.mute) return;                      /* 这一段被单独静音：不排开门 */
        var f = Math.max(0, c.from - winFrom);
        var t = Math.min(winTo, c.to) - winFrom;
        if (t <= f + 1e-6) return;               /* 这一段不在这圈的窗口里 */
        try { scheduleGate(voiceGate.gain, base, spb, f, t, span); } catch (e) {}
      });
    }
  }

  function startVoiceLoop(buf, startSec, spanSec, out, vol, fx, rate) {
    stopVoice();
    if (!buf || !buf.duration) return;
    var a = Math.max(0, Math.min(startSec, Math.max(0, buf.duration - 0.15)));
    var b = Math.min(buf.duration, a + spanSec);
    if (b - a < 0.25) { a = 0; b = Math.min(buf.duration, spanSec); }

    var src = ctx.createBufferSource();
    src.buffer = buf;
    /* 变调：整首升降半音时，录音跟着改播放速率（音高随之上移/下移） */
    if (rate && rate !== 1) {
      try { src.playbackRate.value = rate; } catch (e) {}
    }
    if (b - a > 0.25) {
      src.loop = true;
      src.loopStart = a;
      src.loopEnd = b;
    }
    src.connect(voiceChain(out, fx || playCfg.voiceFx, curSpb, vol));
    src.start(ctx.currentTime + 0.16, a);
    voiceSrc = src;
  }

  function stopVoice() {
    var s = voiceSrc;
    voiceSrc = null;
    if (!s) return;
    try { s.stop(); } catch (e) {}
    try { s.disconnect(); } catch (e) {}
  }

  function stopPreview() {
    if (previewBus) {
      var b = previewBus;
      previewBus = null;
      try {
        b.gain.cancelScheduledValues(ctx.currentTime);
        b.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      } catch (e) {}
      setTimeout(function () { try { b.disconnect(); } catch (e) {} }, 400);
    }
    var s = previewSrc;
    previewSrc = null;
    if (!s) return;
    try { s.stop(); } catch (e) {}
    try { s.disconnect(); } catch (e) {}
  }

  /* 试听某个音色：合成音色按旋律前几个音的真实时值播，原声播录音的一小段 */
  function previewVoice(timbre, notes, voiceBuf, voiceStart, voiceFx) {
    init();
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    stopPreview();
    var t0 = ctx.currentTime + 0.08;

    var bus = ctx.createGain();
    bus.gain.value = 0.9;
    bus.connect(master);
    previewBus = bus;

    if (timbre === 'voice') {
      if (!voiceBuf || !voiceBuf.duration) return false;
      var a = Math.max(0, Math.min(voiceStart || 0, Math.max(0, voiceBuf.duration - 0.3)));
      /* 试听要把整段哼唱放完：以前卡在 2.6 秒，长一点的乐句尾巴直接被砍 */
      var d = Math.min(C.BEATS * C.SPB, Math.max(0.6, voiceBuf.duration - a));
      var src = ctx.createBufferSource();
      src.buffer = voiceBuf;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(1, t0 + 0.06);
      g.gain.setValueAtTime(1, t0 + Math.max(0.1, d - 0.28));
      g.gain.linearRampToValueAtTime(0, t0 + d);
      src.connect(g);
      g.connect(voiceChain(bus, voiceFx || 'raw', C.SPB, 1));
      src.start(t0, a, d);
      previewSrc = src;

      /* 八度 / 电音和真播放一样靠合成音叠加，试听才和成品一致 */
      if (voiceFx === 'octave' || voiceFx === 'tune') {
        playLeadPreview(t0, bus, notes, voiceFx === 'octave' ? 12 : 0, 0.6,
          voiceFx === 'octave' ? 'guzheng' : 'soft');
      }
      return true;
    }

    var use = (notes || []).slice(0, 32);
    if (!use.length) use = [{ m: 60, d: 1 }, { m: 64, d: 1 }, { m: 67, d: 1 }];
    playLeadPreview(t0, bus, use, 0, 0.95, timbre);
    return true;
  }

  /* 试听主旋律：整段都放，按音符自己的拍位排，休止与长短都照原样。
     以前只取前 4 个音、还按顺序硬接，句尾听起来就是「被掐断」 */
  function playLeadPreview(t0, out, notes, shift, vol, timbre) {
    (notes || []).forEach(function (n) {
      var b = Math.max(0, (n.b || 0)) * C.SPB;
      /* 时值照原样给，别再压上限：哼了一个长音，试听里就该拖满那么长 */
      var dur = Math.max(0.22, (n.d || 0.5) * C.SPB);
      lead(t0 + b, n.m + shift, dur, vol, out, timbre);
    });
  }

  function beatPos() {
    if (!session || !songDur || !curSpb) return 0;
    var t = ctx.currentTime - playStart;
    if (t < 0) return winFrom;
    /* 循环窗口里的绝对拍：时间线把播放头画在窗口内跟着转 */
    return winFrom + (t % songDur) / curSpb;
  }

  function level() {
    if (!analyser) return 0;
    analyser.getByteFrequencyData(freqData);
    var s = 0;
    for (var i = 0; i < 24; i++) s += freqData[i];
    return s / (24 * 255);
  }

  /* ---------- 录音采集 ---------- */
  /* AudioWorklet 优先：iOS/部分 WebView 上 ScriptProcessor 经常不回调 */
  var WORKLET_CODE = [
    'class LalaTap extends AudioWorkletProcessor {',
    '  constructor(){ super(); this.b = new Float32Array(2048); this.n = 0; }',
    '  process(inputs){',
    '    var c = inputs[0] && inputs[0][0];',
    '    if (c) { for (var i = 0; i < c.length; i++) {',
    '      this.b[this.n++] = c[i];',
    '      if (this.n === 2048) { this.port.postMessage(this.b.slice(0)); this.n = 0; }',
    '    } }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('lala-tap', LalaTap);"
  ].join('\n');

  /* ---------- MediaRecorder 兜底 ---------- */
  /* Android WebView 上 MediaStreamSource 可能拿到全静音，MediaRecorder 往往正常 */
  var recorder = null;
  var recChunks = [];

  function startRecorder(stream) {
    stopRecorderNow();
    if (!window.MediaRecorder) return;
    try {
      var opts = {};
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        opts.mimeType = 'audio/webm;codecs=opus';
      }
      var mr = new MediaRecorder(stream, opts);
      recChunks = [];
      mr.ondataavailable = function (e) {
        if (e.data && e.data.size) recChunks.push(e.data);
      };
      mr.start(200);
      recorder = mr;
    } catch (e) {
      recorder = null;
    }
  }

  function stopRecorderNow() {
    if (!recorder) return;
    try { if (recorder.state !== 'inactive') recorder.stop(); } catch (e) {}
    recorder = null;
    recChunks = [];
  }

  function takeRecorderBlob() {
    if (!recorder) return Promise.resolve(null);
    var mr = recorder;
    recorder = null;
    return new Promise(function (resolve) {
      var done = function () {
        try {
          var blob = new Blob(recChunks, { type: mr.mimeType || 'audio/webm' });
          recChunks = [];
          resolve(blob.size > 0 ? blob : null);
        } catch (e) { resolve(null); }
      };
      try {
        if (mr.state === 'inactive') done();
        else { mr.onstop = done; mr.stop(); }
      } catch (e) { resolve(null); }
    });
  }

  function decodeBlob(blob) {
    if (!blob) return Promise.reject(new Error('no-blob'));
    return blob.arrayBuffer().then(function (ab) {
      return new Promise(function (resolve, reject) {
        try {
          ctx.decodeAudioData(ab, resolve, reject);
        } catch (e) { reject(e); }
      });
    });
  }

  function beginCapture(stream) {
    init();
    var src = ctx.createMediaStreamSource(stream);
    var mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    var an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.7;
    src.connect(an);
    an.connect(mute);
    micData = new Uint8Array(an.frequencyBinCount);

    cap = {
      chunks: [], peak: 0, rms: 0, rate: ctx.sampleRate,
      src: src, mute: mute, an: an, node: null, proc: null,
      mode: 'none', frames: 0, samples: 0
    };

    startRecorder(stream);

    function push(inp) {
      if (!cap || !inp) return;
      var sum = 0;
      for (var i = 0; i < inp.length; i++) {
        var v = inp[i];
        sum += v * v;
        cap.chunks.push(v);
      }
      cap.frames++;
      cap.samples += inp.length;
      var r = Math.sqrt(sum / inp.length);
      cap.rms = cap.rms * 0.68 + r * 0.32;
      if (r > cap.peak) cap.peak = r;
    }

    function viaWorklet() {
      return new Promise(function (resolve, reject) {
        if (!ctx.audioWorklet || typeof window.AudioWorkletNode === 'undefined') {
          reject(new Error('no-worklet'));
          return;
        }
        var url;
        try {
          url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
        } catch (e) {
          reject(e);
          return;
        }
        ctx.audioWorklet.addModule(url).then(function () {
          var node = new AudioWorkletNode(ctx, 'lala-tap');
          node.port.onmessage = function (ev) { push(ev.data); };
          src.connect(node);
          node.connect(mute);
          if (cap) { cap.node = node; cap.mode = 'worklet'; }
          resolve(true);
        }).catch(reject);
      });
    }

    function viaProcessor() {
      return new Promise(function (resolve) {
        var proc = ctx.createScriptProcessor(2048, 1, 1);
        proc.onaudioprocess = function (e) { push(e.inputBuffer.getChannelData(0)); };
        src.connect(proc);
        proc.connect(mute);
        if (cap) { cap.proc = proc; cap.mode = 'scriptprocessor'; }
        resolve(true);
      });
    }

    return viaWorklet().catch(function () { return viaProcessor(); });
  }

  function endCapture() {
    if (!cap) {
      return { pcm: new Float32Array(0), sampleRate: 48000, peak: 0, mode: 'none', frames: 0 };
    }
    var c = cap;
    cap = null;
    try { if (c.proc) { c.proc.onaudioprocess = null; c.proc.disconnect(); } } catch (e) {}
    try { if (c.node) { c.node.port.onmessage = null; c.node.disconnect(); } } catch (e) {}
    try { c.src.disconnect(); } catch (e) {}
    try { c.mute.disconnect(); } catch (e) {}

    var pcm = new Float32Array(c.chunks.length);
    for (var i = 0; i < c.chunks.length; i++) pcm[i] = c.chunks[i];
    c.chunks = [];
    return { pcm: pcm, sampleRate: c.rate, peak: c.peak, mode: c.mode, frames: c.frames };
  }

  function micLevel() { return cap ? cap.rms : 0; }
  function micPeak() { return cap ? cap.peak : 0; }

  function micStats() {
    return {
      mode: cap ? cap.mode : 'none',
      frames: cap ? cap.frames : 0,
      samples: cap ? cap.samples : 0,
      rate: cap ? cap.rate : 0,
      peak: cap ? cap.peak : 0,
      rms: cap ? cap.rms : 0,
      ctxState: ctx ? ctx.state : 'no-ctx'
    };
  }

  function micSpectrum() {
    if (!cap || !micData) return null;
    cap.an.getByteFrequencyData(micData);
    return micData;
  }

  L.ENG = {
    init: init, resume: resume, unlock: unlock, now: now,
    play: play, stop: stop, pump: pump,
    previewVoice: previewVoice, stopPreview: stopPreview,
    VOICES: ['voice', 'piano', 'guitar', 'guzheng', 'soft', 'chip', 'flute'],
    beatPos: beatPos, level: level,
    blip: blip, metronome: metronome,
    beginCapture: beginCapture, endCapture: endCapture,
    takeRecorderBlob: takeRecorderBlob, decodeBlob: decodeBlob,
    stopRecorderNow: stopRecorderNow,
    micLevel: micLevel, micPeak: micPeak, micSpectrum: micSpectrum,
    micStats: micStats,
    isPlaying: function () { return !!session; }
  };
})();
