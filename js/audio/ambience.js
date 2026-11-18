/* ============================================================
 * audio/ambience.js — 氛围层：噪声合成的环境铺底
 * 蝉鸣 / 篝火 / 溪流 / 雨声 / 竹林 / 夜晚虫鸣 / 海浪 / 风声全部现场合成，
 * 不用任何音频素材。每条氛围是一张独立子图，接到播放 session 上，
 * 由 engine.js 的 play / stop 统一起停（不参与 4 小节排程）。
 * 暴露：LALA.AMB
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;

  var BUS = 0.5;         /* 氛围整体压在音乐下面：不抢主旋律，拉满也不炸 */
  var FADE_IN = 0.45;
  var FADE_OUT = 0.25;

  function rm(n) { return Math.random() * n; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* 一层氛围的节点与定时器收集器。所有一次性的短音都自己 disconnect，
     常驻节点与定时器统一由 stop() 收口，避免连点试听攒一堆残留 */
  function makeLayer(ctx, noiseBuf, dest) {
    var nodes = [], srcs = [], timers = [], dead = false;

    function keep(n) { nodes.push(n); return n; }
    function play(s) { srcs.push(s); nodes.push(s); return s; }

    function rawFilter(type, freq, q) {
      var f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q !== undefined) f.Q.value = q;
      return f;
    }

    function rawPan(v) {
      if (!ctx.createStereoPanner) return null;
      var p = ctx.createStereoPanner();
      p.pan.value = v;
      return p;
    }

    function track(src, onend) {
      srcs.push(src);
      src.onended = function () {
        var i = srcs.indexOf(src);
        if (i >= 0) srcs.splice(i, 1);
        if (onend) onend();
      };
    }

    var api = {
      noise: function () {
        var s = ctx.createBufferSource();
        s.buffer = noiseBuf;
        s.loop = true;
        s.start(ctx.currentTime);
        return play(s);
      },
      osc: function (type, freq) {
        var o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.start(ctx.currentTime);
        return play(o);
      },
      gain: function (v) {
        var g = ctx.createGain();
        g.gain.value = v;
        return keep(g);
      },
      filter: function (type, freq, q) {
        return keep(rawFilter(type, freq, q));
      },
      pan: function (v) {
        var p = rawPan(v);
        return p ? keep(p) : null;
      },
      /* 慢速调制：sine → gain(depth) → 目标参数 */
      lfo: function (freq, depth, target) {
        var o = api.osc('sine', freq);
        var g = api.gain(depth);
        o.connect(g);
        g.connect(target);
      },
      chain: function () {
        for (var i = 0; i + 1 < arguments.length; i++) {
          if (arguments[i] && arguments[i + 1]) arguments[i].connect(arguments[i + 1]);
        }
        return arguments[arguments.length - 1];
      },
      /* 循环触发的随机事件（水滴 / 爆裂 / 虫叫）。interval 可以是函数 */
      every: function (interval, fn) {
        var stop = false, id = null;
        function tick() {
          if (stop || dead) return;
          id = setTimeout(function () {
            if (stop || dead) return;
            fn();
            tick();
          }, typeof interval === 'function' ? interval() : interval);
        }
        tick();
        timers.push(function () { stop = true; if (id) clearTimeout(id); });
      },
      /* 延迟一次，同样进 timers，停播时一起清 */
      after: function (ms, fn) {
        var id = setTimeout(function () {
          if (!dead) fn();
        }, ms);
        timers.push(function () { clearTimeout(id); });
      },
      now: function () { return ctx.currentTime; },
      /* 一次性噪声短音：雨滴 / 火苗爆裂 / 竹叶摩擦 */
      hit: function (o) {
        if (dead) return;
        var t = ctx.currentTime + (o.delay || 0);
        var dec = o.dec || 0.1;
        var s = ctx.createBufferSource();
        s.buffer = noiseBuf;
        var f = rawFilter(o.type || 'bandpass', o.freq || 1200, o.q === undefined ? 1 : o.q);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(o.gain || 0.12, t + (o.attack || 0.004));
        g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
        var p = o.pan === undefined ? null : rawPan(o.pan);
        s.connect(f);
        f.connect(g);
        if (p) { g.connect(p); p.connect(dest); } else { g.connect(dest); }
        s.start(t, rm(Math.max(0.05, noiseBuf.duration - 0.4)));
        s.stop(t + dec + 0.05);
        track(s, function () {
          try { s.disconnect(); f.disconnect(); g.disconnect(); if (p) p.disconnect(); } catch (e) {}
        });
      },
      /* 一次性正弦短音：竹节 / 鸟鸣 / 水泡 */
      tone: function (o) {
        if (dead) return;
        var t = ctx.currentTime + (o.delay || 0);
        var dec = o.dec || 0.12;
        var osc = ctx.createOscillator();
        osc.type = o.type || 'sine';
        osc.frequency.setValueAtTime(o.freq || 440, t);
        if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || dec));
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(o.gain || 0.08, t + (o.attack || 0.008));
        g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
        var p = o.pan === undefined ? null : rawPan(o.pan);
        osc.connect(g);
        if (p) { g.connect(p); p.connect(dest); } else { g.connect(dest); }
        osc.start(t);
        osc.stop(t + dec + 0.05);
        track(osc, function () {
          try { osc.disconnect(); g.disconnect(); if (p) p.disconnect(); } catch (e) {}
        });
      },
      stop: function () {
        dead = true;
        timers.forEach(function (f) { try { f(); } catch (e) {} });
        timers.length = 0;
        srcs.forEach(function (s) { try { s.stop(); } catch (e) {} });
        srcs.length = 0;
        nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
        nodes.length = 0;
      }
    };
    return api;
  }

  /* ---------- 八条配方：噪声 + 滤波 + 调制，各自很轻 ---------- */
  var RECIPES = {
    /* 雨声：宽噪声双层，雨势慢慢起伏，偶尔几滴水 */
    rain: function (b, dest, vol) {
      var n = b.noise();
      var lp = b.filter('lowpass', 4200, 0.6);
      var bp = b.filter('bandpass', 1150, 0.5);
      var g1 = b.gain(0.42 * vol);
      var g2 = b.gain(0.30 * vol);
      b.chain(n, lp, g1, dest);
      b.chain(n, bp, g2, dest);
      b.lfo(0.06, 0.10 * vol, g1.gain);
      b.lfo(0.043, 0.07 * vol, g2.gain);
      b.every(function () { return 260 + rm(900); }, function () {
        b.hit({
          freq: 2400 + rm(2400), q: 6,
          gain: (0.04 + rm(0.05)) * vol, dec: 0.05 + rm(0.07),
          pan: rm(1.6) - 0.8
        });
      });
      return b;
    },

    /* 溪流：中频带通 + 缓慢漂移，水泡点缀 */
    stream: function (b, dest, vol) {
      var n = b.noise();
      var bp = b.filter('bandpass', 900, 0.45);
      var lp = b.filter('lowpass', 2600, 0.7);
      var g = b.gain(0.50 * vol);
      b.chain(n, bp, lp, g, dest);
      b.lfo(0.11, 220, bp.frequency);
      b.lfo(0.07, 0.08 * vol, g.gain);
      b.every(function () { return 420 + rm(1100); }, function () {
        b.tone({
          freq: 420 + rm(520), to: 760 + rm(520),
          gain: (0.03 + rm(0.035)) * vol, dec: 0.08 + rm(0.08),
          pan: rm(1.4) - 0.7
        });
      });
      return b;
    },

    /* 海浪：低通噪声 + 8~14 秒涨落，两道错开 */
    waves: function (b, dest, vol) {
      var n = b.noise();
      var lp = b.filter('lowpass', 780, 0.6);
      var g = b.gain(0.30 * vol);
      b.chain(n, lp, g, dest);
      b.lfo(0.075, 0.26 * vol, g.gain);

      var n2 = b.noise();
      var bp = b.filter('bandpass', 2200, 0.5);
      var g2 = b.gain(0.12 * vol);
      b.chain(n2, bp, g2, dest);
      b.lfo(0.058, 0.10 * vol, g2.gain);
      return b;
    },

    /* 风声：带通中心慢扫，叠加阵风 */
    wind: function (b, dest, vol) {
      var n = b.noise();
      var bp = b.filter('bandpass', 420, 1.1);
      var g = b.gain(0.45 * vol);
      b.chain(n, bp, g, dest);
      b.lfo(0.05, 240, bp.frequency);
      b.lfo(0.037, 0.16 * vol, g.gain);

      var n2 = b.noise();
      var lp = b.filter('lowpass', 1400, 0.8);
      var g2 = b.gain(0.10 * vol);
      b.chain(n2, lp, g2, dest);
      b.lfo(0.083, 0.07 * vol, g2.gain);
      return b;
    },

    /* 蝉鸣：5.2k 窄带 + 46Hz 调幅，一阵一阵地叫 */
    cicada: function (b, dest, vol) {
      var n = b.noise();
      var bp = b.filter('bandpass', 5200, 7);
      var am = b.gain(0.38 * vol);
      var phrase = b.gain(0.12);
      b.chain(n, bp, am, phrase, dest);
      b.lfo(46, 0.32 * vol, am.gain);

      b.every(function () { return 2400 + rm(2600); }, function () {
        var t = b.now();
        phrase.gain.cancelScheduledValues(t);
        phrase.gain.setTargetAtTime(1, t, 0.25);
        b.after(1400 + rm(1800), function () {
          phrase.gain.setTargetAtTime(0.12, b.now(), 0.45);
        });
      });
      return b;
    },

    /* 夜晚虫鸣：高频窄带 + 26Hz 调幅，短促的脉冲串 */
    crickets: function (b, dest, vol) {
      var n = b.noise();
      var bp = b.filter('bandpass', 4300, 9);
      var am = b.gain(0.34 * vol);
      var pulse = b.gain(0.08);
      b.chain(n, bp, am, pulse, dest);
      b.lfo(26, 0.28 * vol, am.gain);

      b.every(function () { return 700 + rm(900); }, function () {
        var t = b.now();
        var count = 3 + Math.floor(rm(3));
        pulse.gain.cancelScheduledValues(t);
        for (var i = 0; i < count; i++) {
          var at = t + i * 0.07;
          pulse.gain.setValueAtTime(0.08, at);
          pulse.gain.setTargetAtTime(1, at, 0.006);
          pulse.gain.setTargetAtTime(0.08, at + 0.035, 0.01);
        }
      });
      return b;
    },

    /* 篝火：低频底噪 + 随机噼啪 */
    fire: function (b, dest, vol) {
      var n = b.noise();
      var lp = b.filter('lowpass', 300, 0.7);
      var g = b.gain(0.55 * vol);
      b.chain(n, lp, g, dest);
      b.lfo(0.13, 0.08 * vol, g.gain);

      b.every(function () { return 90 + rm(520); }, function () {
        b.hit({
          type: 'highpass', freq: 1400 + rm(2600), q: 0.7,
          gain: (0.04 + rm(0.10)) * vol, dec: 0.02 + rm(0.09),
          pan: rm(1.6) - 0.8
        });
      });
      return b;
    },

    /* 竹林：穿林风 + 竹叶摩擦 + 偶尔竹节与鸟鸣 */
    bamboo: function (b, dest, vol) {
      var n = b.noise();
      var bp = b.filter('bandpass', 820, 0.8);
      var g = b.gain(0.34 * vol);
      b.chain(n, bp, g, dest);
      b.lfo(0.05, 260, bp.frequency);
      b.lfo(0.031, 0.10 * vol, g.gain);

      /* 竹叶沙沙 */
      b.every(function () { return 1400 + rm(2600); }, function () {
        b.hit({
          freq: 3200 + rm(1600), q: 0.9,
          gain: (0.025 + rm(0.03)) * vol, dec: 0.18 + rm(0.22),
          pan: rm(1.4) - 0.7
        });
      });

      /* 竹节轻响 */
      b.every(function () { return 3200 + rm(4800); }, function () {
        b.tone({
          freq: 240 + rm(120), type: 'triangle',
          gain: (0.04 + rm(0.04)) * vol, dec: 0.22 + rm(0.2),
          pan: rm(1.2) - 0.6
        });
      });

      /* 远处的鸟 */
      b.every(function () { return 6000 + rm(9000); }, function () {
        var notes = 2 + Math.floor(rm(3));
        for (var i = 0; i < notes; i++) {
          var f = 2200 + rm(900);
          b.tone({
            freq: f, to: f * (1.12 + rm(0.25)),
            gain: (0.02 + rm(0.02)) * vol, dec: 0.09 + rm(0.06),
            delay: i * (0.11 + rm(0.05)), pan: rm(1.2) - 0.6
          });
        }
      });
      return b;
    }
  };

  /* 一段区间的开关包络：只在 [from, to) 之间响，两端带淡入淡出。
     盖住整圈（默认 0~16，试听片段时 = 那个窗口）直接给 1，跨循环不断开；
     base 早于现在时从「现在」短淡入 */
  function scheduleGate(param, now, base, spb, from, to, span) {
    var t0 = base + from * spb;
    var t1 = base + to * spb;
    if (t1 <= now + 0.004) return;
    var win = (span > 0) ? span : L.util.LOOP_BEATS;
    var full = from <= 0 && to >= win - 1e-6;
    var len = Math.max(0.05, t1 - t0);
    var fade = Math.max(0.02, Math.min(0.35, len * 0.3));
    var open;

    if (t0 < now) {
      open = now;
      param.setValueAtTime(0.0001, now);
      param.linearRampToValueAtTime(1, now + Math.min(0.08, Math.max(0.015, (t1 - now) * 0.4)));
    } else if (full) {
      param.setValueAtTime(1, t0);
      return;
    } else {
      open = t0;
      param.setValueAtTime(0.0001, t0);
      param.linearRampToValueAtTime(1, t0 + fade);
    }
    if (full) return;
    param.setValueAtTime(1, Math.max(open, t1 - fade));
    param.linearRampToValueAtTime(0.0001, t1);
  }

  /* 起一层氛围总线：items 是 song.band 里的氛围项，只认有配方的音色。
     每条氛围自己带一个 gate，按片段区间逐循环开关；render 由 engine 的 pump 调用 */
  function start(ctx, out, items, noiseBuf) {
    if (!ctx || !out || !noiseBuf) return null;
    var list = (items || []).filter(function (it) {
      return it && it.k === 'amb' && RECIPES[it.id] && !it.mute;
    });
    if (!list.length) return null;

    var bus = ctx.createGain();
    var t0 = ctx.currentTime;
    bus.gain.setValueAtTime(0.0001, t0);
    bus.gain.linearRampToValueAtTime(BUS, t0 + FADE_IN);
    bus.connect(out);

    var entries = list.map(function (it) {
      var vol = clamp01(it.vol === undefined ? 0.6 : it.vol);
      var gate = ctx.createGain();
      gate.gain.value = 0.0001;
      gate.connect(bus);
      var layer = RECIPES[it.id](makeLayer(ctx, noiseBuf, gate), gate, vol);
      return { layer: layer, gate: gate, clips: L.util.bandClips(it) };
    });

    var stopped = false;
    return {
      /* 每个循环调一次，给每条氛围的每一段排上这一圈的开关。
         winFrom / winTo 是可选的循环窗口（试听单个片段时窗口 = 那一段） */
      render: function (base, spb, winFrom, winTo) {
        if (stopped || !(spb > 0)) return;
        var now = ctx.currentTime;
        var lf = (typeof winFrom === 'number') ? winFrom : 0;
        var lt = (typeof winTo === 'number') ? winTo : L.util.LOOP_BEATS;
        var span = Math.max(0.5, lt - lf);
        entries.forEach(function (e) {
          e.clips.forEach(function (c) {
            if (c.mute) return;                  /* 这一段单独静音：这一圈不排开门 */
            var f = Math.max(0, c.from - lf);
            var t = Math.min(lt, c.to) - lf;
            if (t <= f + 1e-6) return;           /* 这一段不在这圈的窗口里 */
            try { scheduleGate(e.gate.gain, now, base, spb, f, t, span); } catch (err) {}
          });
        });
      },
      stop: function (fadeSec) {
        if (stopped) return;
        stopped = true;
        var f = fadeSec === undefined ? FADE_OUT : Math.max(0, fadeSec);
        var now = ctx.currentTime;
        try {
          bus.gain.cancelScheduledValues(now);
          bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now);
          bus.gain.linearRampToValueAtTime(0.0001, now + f);
        } catch (e) {}
        setTimeout(function () {
          entries.forEach(function (e) { try { e.layer.stop(); } catch (err) {} });
          try { bus.disconnect(); } catch (e) {}
        }, Math.ceil(f * 1000) + 80);
      }
    };
  }

  L.AMB = { recipes: RECIPES, start: start };
})();
