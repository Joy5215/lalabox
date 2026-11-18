/* ============================================================
 * core/bridge.js — Toy 平台适配层
 * 全应用唯一触碰 window.toy 的地方，所有能力均带降级路径。
 * 暴露：LALA.Bridge
 * ============================================================ */
(function () {
  'use strict';
  var L = window.LALA;
  var sleep = L.util.sleep;

  var caps = {};
  var stream = null;
  var fromToy = false;

  function has() { return !!(window.toy && typeof window.toy === 'object'); }

  function can(name) {
    if (!has()) return Promise.resolve(false);
    if (name in caps) return Promise.resolve(caps[name]);
    return Promise.resolve()
      .then(function () { return window.toy.isSupport(name); })
      .then(function (v) { caps[name] = !!v; return !!v; })
      .catch(function () { caps[name] = false; return false; });
  }

  function withRetry(fn, tries) {
    tries = tries || 3;
    var delay = 400;
    function attempt(i) {
      return Promise.resolve().then(fn).catch(function (e) {
        var limited = e && e.type === 'http_error' && e.code === 307044;
        if (limited && i < tries - 1) {
          return sleep(delay).then(function () { delay *= 2; return attempt(i + 1); });
        }
        throw e;
      });
    }
    return attempt(0);
  }

  /* ---------- 麦克风 ---------- */
  /* 注意：必须在用户手势中同步调用，任何 await/Promise.resolve 前置都会让平台拒绝授权 */
  function requestMic() {
    if (has() && caps.requestMicrophone !== false) {
      var pending;
      try {
        pending = window.toy.requestMicrophone();
      } catch (e) {
        caps.requestMicrophone = false;
        return fallbackMic();
      }
      return Promise.resolve(pending)
        .then(function (s) {
          caps.requestMicrophone = true;
          stream = s; fromToy = true;
          return s;
        })
        .catch(function () {
          caps.requestMicrophone = false;
          return fallbackMic();
        });
    }
    return fallbackMic();
  }
  function fallbackMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('no-media'));
    }
    /* 某些浏览器（如华为浏览器）权限被永久拒绝时 getUserMedia 既不 resolve 也不 reject，
       Promise 会永远挂着，界面就卡在「等一下…」。这里兜一层超时，让失败可见。 */
    var pending = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('mic-timeout'));
      }, 8000);
      pending.then(function (s) {
        if (settled) {
          try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
          return;
        }
        settled = true;
        clearTimeout(timer);
        stream = s; fromToy = false;
        resolve(s);
      }, function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }
  function releaseMic() {
    var s = stream;
    stream = null;
    if (!s) return Promise.resolve();
    var stopTracks = function () {
      try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    };
    if (fromToy && has()) {
      return Promise.resolve()
        .then(function () { return window.toy.stopMedia(s); })
        .catch(stopTracks)
        .then(function () { stopTracks(); });
    }
    stopTracks();
    return Promise.resolve();
  }

  /* ---------- 云存储 + 本地双写 ---------- */
  function readLocal() {
    var local = [];
    try { local = JSON.parse(localStorage.getItem('lalabox.works') || '[]'); } catch (e) {}
    return Array.isArray(local) ? local : [];
  }
  function writeLocal(list) {
    try { localStorage.setItem('lalabox.works', JSON.stringify(list)); } catch (e) {}
  }

  function loadWorks() {
    var local = readLocal();
    if (!has()) return Promise.resolve(local.slice(0, 3));
    return can('getCloudStorage').then(function (ok) {
      if (!ok) return local.slice(0, 3);
      return withRetry(function () { return window.toy.getCloudStorage(['w1', 'w2', 'w3']); })
        .then(function (map) {
          var cloud = [];
          for (var i = 1; i <= 3; i++) {
            var raw = map && map['w' + i];
            if (!raw) continue;
            try {
              var obj = JSON.parse(raw);
              if (obj && obj.s) cloud.push({ n: obj.n || '', s: obj.s });
            } catch (e) {}
          }
          return cloud.length ? cloud.slice(0, 3) : local.slice(0, 3);
        })
        .catch(function () { return local.slice(0, 3); });
    });
  }

  function saveWorks(list) {
    writeLocal(list);
    if (!has()) return Promise.resolve('local');
    return can('setCloudStorage').then(function (ok) {
      if (!ok) return 'local';
      var items = {};
      for (var i = 0; i < 3; i++) {
        items['w' + (i + 1)] = list[i]
          ? JSON.stringify({ n: list[i].n, s: list[i].s })
          : '{"n":"","s":""}';
      }
      return withRetry(function () { return window.toy.setCloudStorage(items); })
        .then(function () { return 'cloud'; })
        .catch(function () { return 'local'; });
    });
  }

  /* ---------- 分享 / 二维码 ---------- */
  function share(path) {
    if (!has()) return Promise.resolve(false);
    return can('share').then(function (ok) {
      if (!ok) return false;
      return window.toy.share({ path: path }).then(function () { return true; });
    }).catch(function () { return false; });
  }

  function qr(path, size) {
    if (!has()) return Promise.resolve(null);
    return can('getQrCode').then(function (ok) {
      if (!ok) return null;
      return window.toy.getQrCode({ path: path, size: size || 320 })
        .then(function (r) { return r && r.base64 ? r.base64 : null; });
    }).catch(function () { return null; });
  }

  /* ---------- 存图 ---------- */
  function saveImage(dataUrl) {
    if (!has() || dataUrl.length > 2 * 1024 * 1024) return Promise.resolve('download');
    return can('saveImageToAlbum').then(function (ok) {
      if (!ok) return 'download';
      return window.toy.saveImageToAlbum({
        base64Data: dataUrl, hintMsg: '保存你的作品海报'
      }).then(function () { return 'album'; })
        .catch(function () { return 'download'; });
    });
  }

  /* ---------- 输入安全 ---------- */
  function safety(text) {
    if (!has()) return Promise.resolve('pass');
    return can('checkInputSafety').then(function (ok) {
      if (!ok) return 'pass';
      return window.toy.checkInputSafety({ text: text, scene: 'song-title' })
        .then(function (r) {
          if (r && r.passed) return 'pass';
          return (r && r.status === 'rejected') ? 'reject' : 'unknown';
        });
    }).catch(function () { return 'pass'; });
  }

  /* ---------- 容器尺寸 ---------- */
  function onViewport(cb) {
    if (!has()) return;
    can('onContainerChange').then(function (ok) {
      if (!ok) return;
      try {
        window.toy.onContainerChange(function (st) {
          if (!st) return;
          if (st.safeArea) {
            var root = document.documentElement.style;
            root.setProperty('--sat', (st.safeArea.top || 0) + 'px');
            root.setProperty('--sab', (st.safeArea.bottom || 0) + 'px');
          }
          if (cb) cb(st);
        });
      } catch (e) {}
    });
  }

  L.Bridge = {
    has: has, can: can, withRetry: withRetry,
    requestMic: requestMic, releaseMic: releaseMic,
    loadWorks: loadWorks, saveWorks: saveWorks,
    share: share, qr: qr, saveImage: saveImage,
    safety: safety, onViewport: onViewport
  };
})();
