/* ============================================================
 * core/diag.js — 麦克风自检
 * 把「哪一步失败」直接摊在页面上，便于手机端截图定位。
 * 暴露：LALA.DIAG
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;

  function envLines() {
    var lines = [];
    var toyOk = !!(window.toy && typeof window.toy === 'object');
    lines.push('平台        ' + (toyOk ? 'toy 已注入' : '无 window.toy（本地模式）'));
    lines.push('安全上下文  ' + (window.isSecureContext ? 'yes' : 'NO（麦克风通常被禁）'));
    lines.push('audioWorklet ' + (L.ENG && window.AudioWorkletNode ? '可用' : '不可用'));
    var ctx = null;
    try { ctx = L.ENG.init(); } catch (e) {}
    lines.push('AudioContext ' + (ctx ? (ctx.state + ' / ' + ctx.sampleRate + 'Hz') : '创建失败'));
    lines.push('UA          ' + navigator.userAgent);
    return lines;
  }

  function capsLines() {
    var names = ['requestMicrophone', 'stopMedia', 'getCloudStorage', 'share', 'getQrCode'];
    return Promise.all(names.map(function (n) {
      return L.Bridge.can(n).then(function (ok) { return ['  isSupport(' + n + ')', ok]; });
    })).then(function (pairs) {
      return pairs.map(function (p) { return p[0] + '  ' + p[1]; });
    });
  }

  function probe() {
    var lines = [];
    var started = Date.now();
    lines.push('--- 申请 ---');

    return L.Bridge.requestMic().then(function (stream) {
      lines.push('申请结果    OK（' + (Date.now() - started) + 'ms）');
      var track = stream.getAudioTracks()[0];
      if (track) {
        var st = {};
        try { st = track.getSettings ? track.getSettings() : (track.getConstraints ? track.getConstraints() : {}) || {}; } catch (e) {}
        lines.push('track       ' + track.readyState
          + ' / enabled=' + track.enabled + ' / muted=' + track.muted);
        lines.push('track.label ' + (track.label || '(空)'));
        lines.push('settings    ' + JSON.stringify(st));
      } else {
        lines.push('track       没有音轨！');
      }

      return L.ENG.beginCapture(stream).then(function () {
        return new Promise(function (resolve) { setTimeout(resolve, 1600); });
      }).then(function () {
        var s = L.ENG.micStats();
        var blobP = L.ENG.takeRecorderBlob();

        lines.push('--- 采集 1.6s ---');
        lines.push('采集方式    ' + s.mode);
        lines.push('回调次数    ' + s.frames);
        lines.push('采样数      ' + s.samples);
        lines.push('峰值        ' + s.peak.toFixed(4) + '  RMS ' + s.rms.toFixed(4));
        lines.push('context     ' + s.ctxState);

        L.ENG.endCapture();
        L.Bridge.releaseMic();

        return blobP.then(function (blob) {
          lines.push('录音链路    ' + (blob ? (blob.size + ' bytes') : '不可用'));
          if (!blob) {
            lines.push(s.peak < 0.004
              ? '结论        WebAudio 静音且无录音兜底：麦克风本身没声音'
              : '结论        WebAudio 正常');
            return lines;
          }
          return L.ENG.decodeBlob(blob).then(function (buf) {
            var d = buf.getChannelData(0), pk = 0;
            for (var i = 0; i < d.length; i++) {
              var v = Math.abs(d[i]);
              if (v > pk) pk = v;
            }
            lines.push('录音解码    ' + pk.toFixed(4) + ' / ' + buf.duration.toFixed(2) + 's');
            if (pk >= 0.004 && s.peak < 0.004) {
              lines.push('结论        WebAudio 静音但录音有声音 → 已切到录音链路');
            } else if (pk < 0.004) {
              lines.push('结论        两条链路都静音：系统/App 没给到真实麦克风数据');
            } else {
              lines.push('结论        两条链路都正常');
            }
            return lines;
          }).catch(function (e) {
            lines.push('录音解码失败 ' + (e && e.message || e));
            return lines;
          });
        });
      });
    }).catch(function (e) {
      lines.push('申请结果    失败');
      lines.push('name        ' + (e && e.name || '-'));
      lines.push('message     ' + (e && e.message || e));
      lines.push('结论        麦克风没拿到：授权被拒 / 平台未开放 / 非安全上下文');
      L.Bridge.releaseMic();
      return lines;
    });
  }

  /* 必须在点击手势内同步发起 probe，否则会被平台判定为无手势而拒绝 */
  function run() {
    var env = envLines().join('\n');
    var capsP = capsLines();
    var probeP = probe();
    return Promise.all([capsP, probeP]).then(function (r) {
      return env + '\n\n--- 能力 ---\n' + r[0].join('\n') + '\n\n' + r[1].join('\n');
    });
  }

  L.DIAG = {
    envText: function () { return envLines().join('\n'); },
    run: run
  };
})();
