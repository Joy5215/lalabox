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
  function now() { return ctx ? ctx.currentTime : 0; }

  /* ---------- 音色 ---------- */
  function kick(t, v, out) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(172, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.92 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.42);
    o.onended = function () { try { g.disconnect(); } catch (e) {} };
  }

  function snare(t, v, out) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.9;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random() * 1.4); s.stop(t + 0.22);

    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(118, t + 0.1);
    var g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.24 * v, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g2); g2.connect(out);
    o.start(t); o.stop(t + 0.14);
    o.onended = function () { try { g2.disconnect(); } catch (e) {} };
  }

  function hat(t, v, open, out) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7400;
    var g = ctx.createGain();
    var dur = open ? 0.17 : 0.045;
    g.gain.setValueAtTime(0.3 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.03);
  }

  function clap(t, v, out) {
    for (var i = 0; i < 3; i++) {
      (function (tt) {
        var s = ctx.createBufferSource();
        s.buffer = noiseBuf;
        var f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 1250; f.Q.value = 1.5;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.3 * v, tt);
        g.gain.exponentialRampToValueAtTime(0.001, tt + 0.09);
        s.connect(f); f.connect(g); g.connect(out);
        s.start(tt, Math.random() * 1.3); s.stop(tt + 0.11);
      })(t + i * 0.014);
    }
  }

  function bass(t, m, d, v, out) {
    var f = L.util.midiHz(m);
    var o = ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = f;
    var sub = ctx.createOscillator();
    sub.type = 'sine'; sub.frequency.value = f / 2;

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(Math.min(1500, f * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(170, f * 2.4), t + Math.max(0.07, d));

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4 * v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + Math.max(0.1, d));

    o.connect(lp); sub.connect(lp); lp.connect(g); g.connect(out);
    o.start(t); sub.start(t);
    var stopAt = t + Math.max(0.12, d) + 0.06;
    o.stop(stopAt); sub.stop(stopAt);
    o.onended = function () { try { g.disconnect(); } catch (e) {} };
  }

  function chord(t, midis, d, v, out, style) {
    var timbre = style === 'lofi' ? 'ep' : style === 'edm' ? 'super' : style === 'rock' ? 'dist' : 'pad';
    var dur = Math.max(0.18, d);

    var g = ctx.createGain();
    var peak = timbre === 'super' ? 0.5 : 0.42;
    var atk = timbre === 'pad' ? 0.05 : 0.012;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak * v, t + atk);
    g.gain.setTargetAtTime(0.0006, t + Math.max(atk, dur * 0.7), timbre === 'pad' ? 0.16 : 0.07);

    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.value = timbre === 'super' ? 3200
      : timbre === 'ep' ? 2400
      : timbre === 'dist' ? 2100 : 1500;

    lp.connect(g); g.connect(out);
    var send = ctx.createGain();
    send.gain.value = timbre === 'dist' ? 0.05 : 0.2;
    g.connect(send); send.connect(revIn);

    var entry = lp;
    if (timbre === 'dist') {
      shaper.disconnect();
      shaper.connect(lp);
      entry = shaper;
    }

    midis.forEach(function (m) {
      var f = L.util.midiHz(m);
      var voices = timbre === 'super' ? 3 : (timbre === 'pad' ? 2 : 1);
      for (var i = 0; i < voices; i++) {
        var o = ctx.createOscillator();
        o.type = timbre === 'ep' ? 'triangle' : 'sawtooth';
        var det = voices === 1 ? 0 : (i - (voices - 1) / 2) * (timbre === 'super' ? 14 : 7);
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(entry);
        o.start(t); o.stop(t + dur + 0.5);
      }
      if (timbre === 'ep') {
        var o2 = ctx.createOscillator();
        o2.type = 'sine'; o2.frequency.value = f * 2;
        var g2 = ctx.createGain(); g2.gain.value = 0.22;
        o2.connect(g2); g2.connect(entry);
        o2.start(t); o2.stop(t + dur + 0.4);
      }
    });

    setTimeout(function () {
      try { g.disconnect(); lp.disconnect(); } catch (e) {}
    }, (dur + 0.8) * 1000);
  }

  function lead(t, m, d, v, out) {
    var f = L.util.midiHz(m);
    var dur = Math.max(0.16, d);

    var o = ctx.createOscillator();
    o.type = 'triangle'; o.frequency.value = f;
    var o2 = ctx.createOscillator();
    o2.type = 'sine'; o2.frequency.value = f * 2;
    var g2 = ctx.createGain(); g2.gain.value = 0.16;

    var lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 5.2;
    var lfoGain = ctx.createGain(); lfoGain.gain.value = 3.5;
    lfo.connect(lfoGain); lfoGain.connect(o.frequency);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.26 * v, t + 0.022);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(out);
    var send = ctx.createGain(); send.gain.value = 0.22;
    g.connect(send); send.connect(revIn);

    o.start(t); o2.start(t); lfo.start(t);
    o.stop(t + dur + 0.06); o2.stop(t + dur + 0.06); lfo.stop(t + dur + 0.06);
    o.onended = function () { try { g.disconnect(); g2.disconnect(); } catch (e) {} };
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
  function renderSong(song, base, out) {
    var evs = L.ARRANGE.arrange(song);
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      var t = base + e.b * C.SPB;
      var d = (e.d || 0.25) * C.SPB;
      if (t < 0) continue;
      switch (e.t) {
        case 'kick': kick(t, e.v, out); break;
        case 'snare': snare(t, e.v, out); break;
        case 'hat': hat(t, e.v, false, out); break;
        case 'openhat': hat(t, e.v, true, out); break;
        case 'clap': clap(t, e.v, out); break;
        case 'bass': bass(t, e.m, d, e.v, out); break;
        case 'chord': chord(t, e.ms, d, e.v, out, song.style); break;
        case 'lead': lead(t, e.m, d, e.v, out); break;
      }
    }
  }

  function play(song) {
    init();
    stop();
    curSong = song;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});

    var g = ctx.createGain();
    g.gain.value = 0.92;
    g.connect(master);
    session = g;

    songDur = 16 * C.SPB;
    playStart = ctx.currentTime + 0.16;
    cycles = 0;
    pump();
  }

  function pump() {
    if (!session || !curSong) return;
    var guard = 0;
    while (session && playStart + cycles * songDur < ctx.currentTime + 2.2 && guard++ < 6) {
      renderSong(curSong, playStart + cycles * songDur, session);
      cycles++;
    }
  }

  function stop() {
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

  function beatPos() {
    if (!session || !songDur) return 0;
    var t = ctx.currentTime - playStart;
    if (t < 0) return 0;
    return (t % songDur) / C.SPB;
  }

  function level() {
    if (!analyser) return 0;
    analyser.getByteFrequencyData(freqData);
    var s = 0;
    for (var i = 0; i < 24; i++) s += freqData[i];
    return s / (24 * 255);
  }

  /* ---------- 录音采集 ---------- */
  function beginCapture(stream) {
    init();
    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(2048, 1, 1);
    var mute = ctx.createGain(); mute.gain.value = 0;
    var an = ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.7;

    cap = {
      chunks: [], peak: 0, rms: 0, rate: ctx.sampleRate,
      src: src, proc: proc, mute: mute, an: an
    };
    micData = new Uint8Array(an.frequencyBinCount);

    proc.onaudioprocess = function (e) {
      var inp = e.inputBuffer.getChannelData(0);
      var sum = 0;
      for (var i = 0; i < inp.length; i++) {
        var s = inp[i];
        sum += s * s;
        cap.chunks.push(s);
      }
      var r = Math.sqrt(sum / inp.length);
      cap.rms = cap.rms * 0.68 + r * 0.32;
      if (r > cap.peak) cap.peak = r;
    };

    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    src.connect(an); an.connect(mute);
    return cap;
  }

  function endCapture() {
    if (!cap) return { pcm: new Float32Array(0), sampleRate: 48000, peak: 0 };
    try { cap.proc.disconnect(); } catch (e) {}
    try { cap.src.disconnect(); } catch (e) {}
    try { cap.mute.disconnect(); } catch (e) {}
    var c = cap;
    cap = null;
    var pcm = new Float32Array(c.chunks.length);
    for (var i = 0; i < c.chunks.length; i++) pcm[i] = c.chunks[i];
    c.chunks = [];
    return { pcm: pcm, sampleRate: c.rate, peak: c.peak };
  }

  function micLevel() { return cap ? cap.rms : 0; }

  function micSpectrum() {
    if (!cap || !micData) return null;
    cap.an.getByteFrequencyData(micData);
    return micData;
  }

  L.ENG = {
    init: init, resume: resume, now: now,
    play: play, stop: stop, pump: pump,
    beatPos: beatPos, level: level,
    blip: blip, metronome: metronome,
    beginCapture: beginCapture, endCapture: endCapture,
    micLevel: micLevel, micSpectrum: micSpectrum,
    isPlaying: function () { return !!session; }
  };
})();
