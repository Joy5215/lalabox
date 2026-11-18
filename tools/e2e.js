/* ============================================================
 * tools/e2e.js — 可见窗口的端到端自测
 *
 * 干什么：拉起一个 420×900 的 Edge 窗口（手机比例），脚本自己点
 *   开始唱 → 等识别 → 开乐队 → 加「我的哼唱」→ 加一条「雨声」氛围，
 *   窗口就在桌面上，操作过程肉眼可跟。
 *   麦克风用假设备喂一段合成哼唱，所以不需要真的对着麦克风唱。
 *
 * 用法：
 *   node tools/e2e.js                  # 有窗口，默认节奏
 *   node tools/e2e.js --slow           # 放慢，方便一边看一边讲
 *   node tools/e2e.js --headless       # 无窗口，跑批用
 *   node tools/e2e.js --keep           # 跑完不关窗口，可以自己继续点
 *   node tools/e2e.js --hum            # 多走一步：在乐队面板里现录一段人声
 *   node tools/e2e.js --url http://localhost:8080/   # 默认带 ?debug=1
 *
 * 前提：静态服务已经在跑（node tools/serve.js 或 tools/tunnel.js）。
 * 截落到 tools/.shots/，失败时退出码非 0。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const FLAGS = {
  headless: args.indexOf('--headless') >= 0,
  slow: args.indexOf('--slow') >= 0,
  keep: args.indexOf('--keep') >= 0,
  hum: args.indexOf('--hum') >= 0
};
const URL_ARG = (function () {
  const i = args.indexOf('--url');
  return i >= 0 ? args[i + 1] : 'http://localhost:8080/?debug=1';
})();

const TMP = os.tmpdir();
const WAV = path.join(TMP, 'lalabox-e2e-hum.wav');
const PROFILE = path.join(TMP, 'lalabox-e2e-profile-' + process.pid);
const SHOTS = path.join(__dirname, '.shots');
const STEP = FLAGS.slow ? 1500 : 700;
const HOLD = FLAGS.slow ? 3500 : 2500;

const BROWSERS = [
  process.env.LALABOX_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean);

function log(s) { console.log(s); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- 1. 假麦克风音频 ---------- */
function makeWav() {
  const rate = 48000, spb = 0.625, leadIn = 2.9;
  /* 带一个 3 拍长音的乐句：既验音高，也验长音有没有被截短 */
  const mel = [{ m: 60, d: 1 }, { m: 62, d: 1 }, { m: 64, d: 3 }, { m: 65, d: 1 }, { m: 67, d: 2 }];
  const total = mel.reduce(function (s, n) { return s + n.d; }, 0);
  const dur = leadIn + total * spb + 1.2;
  const n = Math.floor(dur * rate);
  const pcm = new Float32Array(n);

  let cursor = Math.floor(leadIn * rate);
  mel.forEach(function (note) {
    const len = Math.floor(spb * note.d * rate);
    const f0 = 440 * Math.pow(2, (note.m - 69) / 12);
    let phase = 0;
    for (let i = 0; i < len && cursor + i < n; i++) {
      const t = i / rate;
      const f = f0 * Math.pow(2, 0.2 * Math.sin(2 * Math.PI * 5 * t) / 1200);
      phase += 2 * Math.PI * f / rate;
      const env = Math.min(1, t / 0.02) * Math.exp(-t * 0.8);
      pcm[cursor + i] += 0.3 * env * (Math.sin(phase) + 0.3 * Math.sin(2 * phase));
    }
    cursor += len;
  });

  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(WAV, buf);
  return dur;
}

/* ---------- 2. 进程与端口 ---------- */
function freePort(from) {
  return new Promise(function (resolve) {
    (function probe(p) {
      const srv = net.createServer();
      srv.once('error', function () { probe(p + 1); });
      srv.once('listening', function () { srv.close(function () { resolve(p); }); });
      srv.listen(p, '127.0.0.1');
    })(from);
  });
}

function pickBrowser() {
  for (let i = 0; i < BROWSERS.length; i++) if (fs.existsSync(BROWSERS[i])) return BROWSERS[i];
  return null;
}

function getJson(port, p) {
  return new Promise(function (res, rej) {
    const req = http.get({ host: '127.0.0.1', port: port, path: p, timeout: 2000 }, function (r) {
      let d = '';
      r.on('data', function (c) { d += c; });
      r.on('end', function () {
        try { res(JSON.parse(d)); } catch (e) { rej(e); }
      });
    });
    req.on('error', rej);
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
  });
}

/* ---------- 3. CDP 小客户端 ---------- */
async function connect(port) {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await getJson(port, '/json/list');
      target = list.filter(function (t) { return t.type === 'page'; })[0] || null;
    } catch (e) { /* 浏览器还没起来 */ }
  }
  if (!target) throw new Error('浏览器起来了但拿不到页面 target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(function (res, rej) {
    ws.addEventListener('open', res);
    ws.addEventListener('error', function () { rej(new Error('CDP WebSocket 连接失败')); });
  });

  let seq = 0;
  const waiting = new Map();
  const errors = [];

  ws.addEventListener('message', function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('异常: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map(function (a) {
        return a.value === undefined ? a.description : a.value;
      }).join(' '));
    }
  });

  function send(method, params) {
    const id = ++seq;
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    return new Promise(function (res) { waiting.set(id, res); });
  }

  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error('页面执行出错: ' + detail + '\n  表达式: ' + expr);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async function shot(name) {
    try {
      fs.mkdirSync(SHOTS, { recursive: true });
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, name + '-' + Date.now() + '.png');
      fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
      log('      截图 ' + file);
      return file;
    } catch (e) {
      log('      截图失败：' + e.message);
      return null;
    }
  }

  return { send: send, ev: ev, shot: shot, errors: errors, close: function () { ws.close(); } };
}

/* ---------- 4. 主流程 ---------- */
(async function main() {
  const browser = pickBrowser();
  if (!browser) {
    log('找不到 Edge / Chrome，可用 LALABOX_BROWSER 环境变量指定路径');
    process.exit(2);
  }

  const wavDur = makeWav();
  log('假麦克风音频：' + WAV + '（' + wavDur.toFixed(1) + 's）');
  log('模式：' + (FLAGS.headless ? '无窗口' : '有窗口') + (FLAGS.slow ? ' · 慢速' : ''));
  log('地址：' + URL_ARG);

  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

  const port = await freePort(9333);
  const launch = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--disable-extensions',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + WAV,
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=440,920',
    '--window-position=880,80',
    'about:blank'
  ];
  if (FLAGS.headless) launch.unshift('--headless=new');

  log('\n启动浏览器：' + path.basename(browser) + (FLAGS.headless ? '' : '（窗口会弹在屏幕右侧）'));
  const proc = spawn(browser, launch, { stdio: 'ignore' });
  let failed = null;
  let cdp = null;

  try {
    cdp = await connect(port);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    log('\n[1/6] 打开页面');
    await cdp.send('Page.navigate', { url: URL_ARG });
    await sleep(STEP * 2);
    log('      标题：' + await cdp.ev('document.title'));
    await cdp.shot('01-idle');

    log('\n[2/6] 点「开始唱」（4 拍倒计时 + 8 拍录音）');
    await cdp.ev("document.querySelector('#btnMic').click(); 'ok'");
    await sleep(STEP);
    await cdp.shot('02-recording');

    log('\n[3/6] 等识别完成');
    let screen = '';
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      screen = await cdp.ev("(document.querySelector('.screen.active')||{dataset:{}}).dataset.screen");
      if (screen === 'result') break;
    }
    if (screen !== 'result') throw new Error('没走到结果页，当前界面=' + screen);
    await sleep(HOLD);

    const key = await cdp.ev("document.querySelector('#badgeKey').textContent");
    const bpm = await cdp.ev("document.querySelector('#badgeBpm').textContent");
    log('      识别结果：' + key + ' / ' + bpm);
    await cdp.shot('03-result');

    log('\n[4/6] 打开乐队面板');
    await cdp.ev("document.querySelector('#btnBand').click(); 'ok'");
    await sleep(STEP);
    log('      页签：' + await cdp.ev("[...document.querySelectorAll('#bandTabs button')].map(b=>b.textContent).join(' / ')"));
    log('      家族：' + await cdp.ev("[...document.querySelectorAll('.band-cat')].map(b=>b.textContent.replace(/[＋▲]/g,'')).join(' / ')"));
    await cdp.shot('04-band');

    log('\n[5/7] 点「人声 → 我的哼唱」');
    await cdp.ev("[...document.querySelectorAll('.band-cat')].find(b=>b.textContent.indexOf('人声')===0).click(); 'ok'");
    await sleep(STEP);
    log('      音色：' + await cdp.ev("[...document.querySelectorAll('.band-add-chips .chip')].map(b=>b.textContent).join(' / ')"));

    log('\n[6/7] 加入乐队');
    await cdp.ev("[...document.querySelectorAll('#bandAdd .btn')].find(b=>b.textContent==='加入乐队').click(); 'ok'");
    await sleep(STEP);
    log('      乐队：' + await cdp.ev("document.querySelector('#bandSummary').textContent"));
    await cdp.shot('05-voice-added');

    /* 氛围层：切到「氛围」页签，加一条雨声，确认它进乐队、进画布、且整队重播没有报错 */
    log('\n[7/7] 切到「氛围」页签，加一条雨声');
    await cdp.ev("[...document.querySelectorAll('#bandTabs button')].find(b=>b.textContent==='氛围').click(); 'ok'");
    await sleep(STEP);
    log('      氛围音色：' + await cdp.ev("[...document.querySelectorAll('.band-add-chips .chip')].map(b=>b.textContent).join(' / ')"));

    /* 八条配方逐个试听：每条都要能建图，任何一条抛错都会被控制台断言抓到 */
    const ambNames = await cdp.ev("[...document.querySelectorAll('.band-add-chips .chip')].map(b=>b.textContent)");
    for (let i = 0; i < ambNames.length; i++) {
      await cdp.ev("[...document.querySelectorAll('.band-add-chips .chip')].find(b=>b.textContent==="
        + JSON.stringify(ambNames[i]) + ").click(); 'ok'");
      await sleep(260);
    }
    await cdp.ev("[...document.querySelectorAll('.band-add-chips .chip')].find(b=>b.textContent==='雨声').click(); 'ok'");
    await sleep(STEP);
    await cdp.ev("[...document.querySelectorAll('#bandAdd .btn')].find(b=>b.textContent==='加入氛围').click(); 'ok'");
    await sleep(STEP);
    const ambSum = await cdp.ev("document.querySelector('#bandSummary').textContent");
    log('      乐队：' + ambSum);
    if (ambSum.indexOf('雨声') < 0) throw new Error('氛围没有加入乐队：' + ambSum);

    /* 最上面的清单是「所有已经在响的」：在氛围页加完之后，人声与雨声仍然同时列着 */
    const rowsTop = await cdp.ev("[...document.querySelectorAll('#bandList .band-item-name b')].map(b=>b.textContent).join(' / ')");
    log('      已加入清单：' + rowsTop);
    if (rowsTop.indexOf('我的哼唱') < 0 || rowsTop.indexOf('雨声') < 0) {
      throw new Error('顶层清单没有混排乐器与氛围：' + rowsTop);
    }

    /* 编曲时间线：轨道清单 → 拖右端裁剪 → 时间尺定位 + 分割 → 从定位处起播 */
    log('\n[编曲] 打开全屏时间线');
    await cdp.ev("[...document.querySelectorAll('#bandList .band-row')].find(r=>r.textContent.indexOf('雨声')>=0).querySelector('.band-tune').click(); 'ok'");
    await sleep(STEP);
    const tlOpen = await cdp.ev("document.querySelector('#sheetEdit').classList.contains('open')");
    if (!tlOpen) throw new Error('时间线没有打开');
    const tlNames = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-name')].map(b=>b.textContent).join(' / ')");
    log('      轨道：' + tlNames);
    /* 主旋律已变成普通轨，名字就是选的主音（默认柔和合成），不再显示「主旋律」 */
    if (tlNames.indexOf('雨声') < 0 || tlNames.indexOf('柔和合成') < 0
      || tlNames.indexOf('主旋律') >= 0) {
      throw new Error('轨道清单不对：' + tlNames);
    }
    await cdp.shot('06-timeline');

    /* 主旋律已是普通轨：能像别的轨一样静音 / 取消静音 */
    const leadSel = "[].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))"
      + ".filter(function(r){return r.textContent.indexOf('柔和合成')>=0;})[0]";
    await cdp.ev("(" + leadSel + ").querySelector('.tl-mute').click(); 'ok'");
    await sleep(STEP);
    const leadMuted = await cdp.ev("(" + leadSel + ").classList.contains('muted')");
    log('      主旋律轨可静音：' + leadMuted);
    if (!leadMuted) throw new Error('主旋律轨不能静音');
    await cdp.ev("(" + leadSel + ").querySelector('.tl-mute').click(); 'ok'");
    await sleep(STEP);
    if (await cdp.ev("(" + leadSel + ").classList.contains('muted')")) {
      throw new Error('主旋律轨取消静音失败');
    }

    /* 拖右端：从满 16 拍往里收 */
    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('雨声') >= 0; })[0];",
      "  var clip = row.querySelector('.tl-clip');",
      "  var r = clip.getBoundingClientRect();",
      "  var x = r.right - 6, y = r.top + r.height / 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: x, clientY: y,",
      "    pointerId: 1, isPrimary: true, button: 0, buttons: 1 };",
      "  clip.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  var move = Object.assign({}, opt, { clientX: x - r.width * 0.25 });",
      "  window.dispatchEvent(new PointerEvent('pointermove', move));",
      "  window.dispatchEvent(new PointerEvent('pointerup', move));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    const rainLab = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelector('.tl-clip').textContent");
    log('      裁剪后：' + rainLab);
    if (rainLab.indexOf('16.0') >= 0) throw new Error('拖右端没有裁短：' + rainLab);

    /* 时间尺点一下定位（约第 5 拍），再在播放头处分割 */
    await cdp.ev([
      "(function(){",
      "  var ticks = document.querySelector('#sheetEdit .tl-ticks');",
      "  var r = ticks.getBoundingClientRect();",
      "  var x = r.left + r.width * 0.3, y = r.top + r.height / 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: x, clientY: y,",
      "    pointerId: 2, isPrimary: true, button: 0, buttons: 1 };",
      "  ticks.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  window.dispatchEvent(new PointerEvent('pointerup', opt));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    const splitDisabled = await cdp.ev("(function(){var b=[].slice.call(document.querySelectorAll('#tlBar .tl-btn')).filter(function(x){return x.textContent==='分割';})[0];return b?b.disabled:null;})()");
    if (splitDisabled !== false) throw new Error('定位后分割按钮不可用：' + splitDisabled);
    await cdp.ev("[...document.querySelectorAll('#tlBar .tl-btn')].find(b=>b.textContent==='分割').click(); 'ok'");
    await sleep(STEP);
    const rainClips = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelectorAll('.tl-clip').length");
    log('      分割后片段数：' + rainClips);
    if (rainClips < 2) throw new Error('分割没有生效：' + rainClips);

    /* 播放中定位：立刻从新拍位重播（beatPos 应该落在 5 拍附近） */
    const wasPlaying = await cdp.ev("document.querySelector('#tlPlay').textContent === '暂停'");
    if (!wasPlaying) {
      await cdp.ev("document.querySelector('#tlPlay').click(); 'ok'");
      await sleep(300);
    }
    await sleep(400);
    const beatNow = await cdp.ev("Math.round(window.LALA.ENG.beatPos()*10)/10");
    log('      定位后播放头：' + beatNow + ' 拍');
    if (!(beatNow >= 4.8 && beatNow <= 8)) throw new Error('没有从定位处重播：' + beatNow);

    /* 暂停保留位置：暂停再播，仍然从那附近开始 */
    await cdp.ev("document.querySelector('#tlPlay').click(); 'ok'");
    await sleep(300);
    const beatPause = await cdp.ev("Math.round(window.LALA.ENG.beatPos()*10)/10");
    if (beatPause !== 0) throw new Error('暂停后 beatPos 没有归零：' + beatPause);
    await cdp.ev("document.querySelector('#tlPlay').click(); 'ok'");
    await sleep(250);
    const beatBack = await cdp.ev("Math.round(window.LALA.ENG.beatPos()*10)/10");
    log('      暂停后再播：' + beatBack + ' 拍');
    if (!(beatBack >= 4.5)) throw new Error('暂停后没有从原位继续：' + beatBack);
    await cdp.ev("document.querySelector('#tlPlay').click(); 'ok'");
    await sleep(300);

    /* 空白处横向拖一下新建一段（12 拍之后是空的），再拖片段中部整体平移 */
    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('雨声') >= 0; })[0];",
      "  var lane = row.querySelector('.tl-lane');",
      "  var r = lane.getBoundingClientRect();",
      "  var y = r.top + r.height / 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.90, clientY: y,",
      "    pointerId: 3, isPrimary: true, button: 0, buttons: 1 };",
      "  lane.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  var move = Object.assign({}, opt, { clientX: r.left + r.width * 0.97 });",
      "  window.dispatchEvent(new PointerEvent('pointermove', move));",
      "  window.dispatchEvent(new PointerEvent('pointerup', move));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    const rainAfterNew = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelectorAll('.tl-clip').length");
    log('      拖空白新建后片段数：' + rainAfterNew);
    if (rainAfterNew < 3) throw new Error('空白处拖一下没有新建片段：' + rainAfterNew);

    /* 删掉刚建的那段，再点同一块空白：不许又长出来（删除后误点不该「复活」） */
    await cdp.ev("[...document.querySelectorAll('#tlBar .tl-btn')].find(b=>b.textContent==='删除').click(); 'ok'");
    await sleep(STEP);
    const rainAfterDel = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelectorAll('.tl-clip').length");
    if (rainAfterDel !== rainAfterNew - 1) throw new Error('删除没有生效：' + rainAfterNew + '→' + rainAfterDel);
    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('雨声') >= 0; })[0];",
      "  var lane = row.querySelector('.tl-lane');",
      "  var r = lane.getBoundingClientRect();",
      "  var opt = { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.93,",
      "    clientY: r.top + r.height / 2, pointerId: 33, isPrimary: true, button: 0, buttons: 1 };",
      "  lane.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  window.dispatchEvent(new PointerEvent('pointerup', opt));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    const rainAfterTap = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelectorAll('.tl-clip').length");
    log('      删除后点空白：' + rainAfterDel + ' → ' + rainAfterTap);
    if (rainAfterTap !== rainAfterDel) throw new Error('点空白处又新建了一段：' + rainAfterDel + '→' + rainAfterTap);
    /* 再把这一段拖回来：后面的「点最后一段 → 复制 → 粘贴」还要用到它 */
    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('雨声') >= 0; })[0];",
      "  var lane = row.querySelector('.tl-lane');",
      "  var r = lane.getBoundingClientRect();",
      "  var y = r.top + r.height / 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.90, clientY: y,",
      "    pointerId: 34, isPrimary: true, button: 0, buttons: 1 };",
      "  lane.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  var move = Object.assign({}, opt, { clientX: r.left + r.width * 0.97 });",
      "  window.dispatchEvent(new PointerEvent('pointermove', move));",
      "  window.dispatchEvent(new PointerEvent('pointerup', move));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);

    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('雨声') >= 0; })[0];",
      "  var clip = row.querySelector('.tl-clip');",
      "  var r = clip.getBoundingClientRect();",
      "  var x = r.left + r.width / 2, y = r.top + r.height / 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: x, clientY: y,",
      "    pointerId: 4, isPrimary: true, button: 0, buttons: 1 };",
      "  clip.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  var move = Object.assign({}, opt, { clientX: x + 40 });",
      "  window.dispatchEvent(new PointerEvent('pointermove', move));",
      "  window.dispatchEvent(new PointerEvent('pointerup', move));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    const movedLab = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelector('.tl-clip').textContent");
    log('      平移后首个片段：' + movedLab);
    if (movedLab.indexOf('0.0') === 0) throw new Error('平移没有生效：' + movedLab);

    /* 点在片段上下的空白里也要算「点中这一段」：不该新建、也不该没反应 */
    const hitInfo = await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('雨声') >= 0; })[0];",
      "  var lane = row.querySelector('.tl-lane');",
      "  var clip = row.querySelector('.tl-clip');",
      "  var cr = clip.getBoundingClientRect(), lr = lane.getBoundingClientRect();",
      "  var x = cr.left + cr.width / 2, y = lr.top + 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: x, clientY: y,",
      "    pointerId: 5, isPrimary: true, button: 0, buttons: 1 };",
      "  var n0 = row.querySelectorAll('.tl-clip').length;",
      "  lane.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  window.dispatchEvent(new PointerEvent('pointerup', opt));",
      "  return n0 + '/' + row.querySelectorAll('.tl-clip').length + '/' + row.querySelectorAll('.tl-clip.on').length;",
      "})()"
    ].join('\n'));
    log('      空白处点片段：' + hitInfo);
    if (hitInfo.split('/')[0] !== hitInfo.split('/')[1]) throw new Error('点片段上下空白凭空多了一段：' + hitInfo);
    if (hitInfo.split('/')[2] !== '1') throw new Error('点片段上下空白没有选中它：' + hitInfo);

    /* 片段单独静音 */
    await cdp.ev("document.querySelector('#tlBar [data-act=\"mute-clip\"]').click(); 'ok'");
    await sleep(STEP);
    const mutedN = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelectorAll('.tl-clip.mute').length");
    log('      静音片段数：' + mutedN);
    if (mutedN !== 1) throw new Error('片段静音没有生效：' + mutedN);
    await cdp.shot('06e-clip-mute');
    await cdp.ev("document.querySelector('#tlBar [data-act=\"mute-clip\"]').click(); 'ok'");
    await sleep(STEP);

    /* 整轨静音：底部按钮 + 轨道头小喇叭同时亮，行整体压暗 */
    await cdp.ev("document.querySelector('#tlBar [data-act=\"mute-track\"]').click(); 'ok'");
    await sleep(STEP);
    const mutRow = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].classList.contains('muted')");
    const mutIcon = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelector('.tl-mute').classList.contains('on')");
    log('      整轨静音：' + mutRow + ' / 喇叭点亮：' + mutIcon);
    if (!mutRow || !mutIcon) throw new Error('整轨静音没有生效：' + mutRow + '/' + mutIcon);
    await cdp.ev("document.querySelector('#tlBar [data-act=\"mute-track\"]').click(); 'ok'");
    await sleep(STEP);
    const mutBack = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].classList.contains('muted')");
    if (mutBack) throw new Error('取消整轨静音没有生效');

    /* 暂停后定位到 12.5 拍，复制末段再粘贴，最后单独播放这一段 */
    if ((await cdp.ev("document.querySelector('#tlPlay').textContent")) === '暂停') {
      await cdp.ev("document.querySelector('#tlPlay').click(); 'ok'");
      await sleep(300);
    }
    await cdp.ev([
      "(function(){",
      "  var ticks = document.querySelector('#sheetEdit .tl-ticks');",
      "  var r = ticks.getBoundingClientRect();",
      "  var x = r.left + r.width * 0.78, y = r.top + r.height / 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: x, clientY: y,",
      "    pointerId: 6, isPrimary: true, button: 0, buttons: 1 };",
      "  ticks.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  window.dispatchEvent(new PointerEvent('pointerup', opt));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);

    const beforeCopy = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelectorAll('.tl-clip').length");
    /* 点最后那一段（14.5–16），然后复制 → 粘贴 */
    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('雨声') >= 0; })[0];",
      "  var lane = row.querySelector('.tl-lane');",
      "  var lr = lane.getBoundingClientRect();",
      "  var opt = { bubbles: true, cancelable: true,",
      "    clientX: lr.left + lr.width * 0.92, clientY: lr.top + lr.height / 2,",
      "    pointerId: 7, isPrimary: true, button: 0, buttons: 1 };",
      "  lane.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  window.dispatchEvent(new PointerEvent('pointerup', opt));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    await cdp.ev("[...document.querySelectorAll('#tlBar .tl-btn')].find(b=>b.textContent==='复制').click(); 'ok'");
    await sleep(STEP);
    await cdp.ev("[...document.querySelectorAll('#tlBar .tl-btn')].find(b=>b.textContent==='粘贴').click(); 'ok'");
    await sleep(STEP);
    const afterCopy = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('雨声')>=0)[0].querySelectorAll('.tl-clip').length");
    log('      复制粘贴：' + beforeCopy + ' → ' + afterCopy);
    if (afterCopy !== beforeCopy + 1) throw new Error('复制粘贴没有多出一段：' + beforeCopy + '→' + afterCopy);

    /* 循环这一段：2 秒里播放头始终不离开 12.5~14，而且不会自己停 */
    await cdp.ev("document.querySelector('#tlBar [data-act=\"loop-clip\"]').click(); 'ok'");
    const soloSamples = [];
    for (let i = 0; i < 5; i++) {
      await sleep(400);
      soloSamples.push(await cdp.ev("Math.round(window.LALA.ENG.beatPos()*10)/10"));
    }
    log('      循环这段的播放头：' + soloSamples.join(' → '));
    if (!soloSamples.every(function (b) { return b >= 12.4 && b <= 14.1; })) {
      throw new Error('片段循环跑出这一段了：' + soloSamples.join(','));
    }
    const stillLooping = await cdp.ev("document.querySelector('#tlBar [data-act=\"loop-clip\"]').textContent === '停止'");
    if (!stillLooping) throw new Error('片段循环自己停了');
    await cdp.shot('06f-clip-loop');

    /* 整轨循环：窗口回到整圈，播放头会离开这一段 */
    await cdp.ev("document.querySelector('#tlBar [data-act=\"loop-track\"]').click(); 'ok'");
    await sleep(150);
    const trackSamples = [];
    for (let i = 0; i < 3; i++) {
      await sleep(350);
      trackSamples.push(await cdp.ev("Math.round(window.LALA.ENG.beatPos()*10)/10"));
    }
    log('      整轨循环的播放头：' + trackSamples.join(' → '));
    const outOfClip = trackSamples.some(function (b) { return b < 12.4 || b > 14.1; });
    if (!outOfClip) throw new Error('整轨循环没有回到整圈：' + trackSamples.join(','));

    /* 再点一次同一个按钮 = 停 */
    await cdp.ev("document.querySelector('#tlBar [data-act=\"loop-track\"]').click(); 'ok'");
    await sleep(300);
    const stoppedBeat = await cdp.ev("window.LALA.ENG.beatPos()");
    if (stoppedBeat !== 0) throw new Error('停止试听后还在响：' + stoppedBeat);

    /* 这段全部：窗口还是这一段（12.5~14），但整支乐队一起响 */
    await cdp.ev("document.querySelector('#tlBar [data-act=\"loop-section\"]').click(); 'ok'");
    await sleep(150);
    const secSamples = [];
    for (let i = 0; i < 5; i++) {
      await sleep(350);
      secSamples.push(await cdp.ev("Math.round(window.LALA.ENG.beatPos()*10)/10"));
    }
    log('      这段全部的播放头：' + secSamples.join(' → '));
    if (!secSamples.every(function (b) { return b >= 12.4 && b <= 14.1; })) {
      throw new Error('这段全部没有在段内循环：' + secSamples.join(','));
    }
    const secOn = await cdp.ev("document.querySelector('#tlBar [data-act=\"loop-section\"]').textContent === '停止'");
    if (!secOn) throw new Error('这段全部没有进入试听态');
    /* 试听时静音的轨不该亮 / 响：把雨声静音，它的小喇叭应该灭掉 */
    const secAir0 = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-clip.air')].length");
    log('      这段全部时发声的片段数：' + secAir0);
    if (secAir0 < 1) throw new Error('这段全部没有点亮任何发声片段');
    await cdp.ev("document.querySelector('#tlBar [data-act=\"loop-section\"]').click(); 'ok'");
    await sleep(300);

    /* 主旋律片段：切割→删后段→前段挪到后段位置，旋律内容要跟着片段走（不是露出后段旋律） */
    log('\n[编曲] 主旋律片段移动，旋律跟着走');
    const melFirst = await cdp.ev([
      "(function(){",
      "  var s = window.LALA.__song();",
      "  return JSON.stringify(window.LALA.util.leadNotes(s).filter(function(n){ return n.b < 8; }));",
      "})()"
    ].join('\n'));
    const melHalf = JSON.parse(melFirst);
    log('      前半段音符数：' + melHalf.length);

    /* 定位到 8 拍，分割 */
    await cdp.ev([
      "(function(){",
      "  var ticks = document.querySelector('#sheetEdit .tl-ticks');",
      "  var r = ticks.getBoundingClientRect();",
      "  var opt = { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.5,",
      "    clientY: r.top + r.height / 2, pointerId: 60, isPrimary: true, button: 0, buttons: 1 };",
      "  ticks.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  window.dispatchEvent(new PointerEvent('pointerup', opt));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    await cdp.ev("[...document.querySelectorAll('#tlBar .tl-btn')].find(b=>b.textContent==='分割').click(); 'ok'");
    await sleep(STEP);

    /* 选后段（8~16 拍，约 75% 宽），删除 */
    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('柔和合成') >= 0; })[0];",
      "  var lane = row.querySelector('.tl-lane');",
      "  var r = lane.getBoundingClientRect();",
      "  var opt = { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.75,",
      "    clientY: r.top + r.height / 2, pointerId: 61, isPrimary: true, button: 0, buttons: 1 };",
      "  lane.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  window.dispatchEvent(new PointerEvent('pointerup', opt));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);
    await cdp.ev("[...document.querySelectorAll('#tlBar .tl-btn')].find(b=>b.textContent==='删除').click(); 'ok'");
    await sleep(STEP);

    /* 前段（0~8 拍，中心约 25% 宽）整体拖到后段位置（75% 宽） */
    await cdp.ev([
      "(function(){",
      "  var row = [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "    .filter(function(r){ return r.textContent.indexOf('柔和合成') >= 0; })[0];",
      "  var lane = row.querySelector('.tl-lane');",
      "  var clip = row.querySelector('.tl-clip');",
      "  var cr = clip.getBoundingClientRect(), lr = lane.getBoundingClientRect();",
      "  var opt = { bubbles: true, cancelable: true, clientX: cr.left + cr.width / 2,",
      "    clientY: cr.top + cr.height / 2, pointerId: 62, isPrimary: true, button: 0, buttons: 1 };",
      "  clip.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  var move = Object.assign({}, opt, { clientX: lr.left + lr.width * 0.75 });",
      "  window.dispatchEvent(new PointerEvent('pointermove', move));",
      "  window.dispatchEvent(new PointerEvent('pointerup', move));",
      "  return 'ok';",
      "})()"
    ].join('\n'));
    await sleep(STEP);

    /* 校验：只剩一段 [8,16]，且音符就是前半段整体 +8（音高、相对位置、时值一一对应） */
    const melAfter = await cdp.ev([
      "(function(){",
      "  var s = window.LALA.__song();",
      "  var lead = window.LALA.util.leadItems(s)[0];",
      "  var clips = window.LALA.util.bandClips(lead);",
      "  var notes = window.LALA.util.leadNotes(s);",
      "  return JSON.stringify({ clips: clips, notes: notes });",
      "})()"
    ].join('\n'));
    const melRes = JSON.parse(melAfter);
    const melLab = melRes.clips.map(function (c) { return c.from + '–' + c.to; }).join(',');
    log('      移动后片段：' + melLab + '，音符数：' + melRes.notes.length);
    if (melRes.clips.length !== 1 || Math.abs(melRes.clips[0].from - 8) > 1e-6
      || Math.abs(melRes.clips[0].to - 16) > 1e-6) {
      throw new Error('前段没有挪到后段位置：' + JSON.stringify(melRes.clips));
    }
    if (melRes.notes.length !== melHalf.length) {
      throw new Error('旋律没跟着走（音数变了）：' + melHalf.length + ' → ' + melRes.notes.length);
    }
    if (!melRes.notes.every(function (n) { return n.b >= 8 - 1e-6; })) {
      throw new Error('旋律没跟着走（还有音留在前半段）：' + JSON.stringify(melRes.notes));
    }
    for (let i = 0; i < melHalf.length; i++) {
      const a = melHalf[i], b = melRes.notes[i];
      if (a.m !== b.m || Math.abs((a.b + 8) - b.b) > 1e-6 || Math.abs(a.d - b.d) > 1e-6) {
        throw new Error('旋律内容对不上：' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
      }
    }
    log('      主旋律跟着片段走，验证通过');
    await cdp.shot('06g-lead-moved');

    await cdp.ev("document.querySelector('#tlDone').click(); 'ok'");
    await sleep(STEP);
    const tlClosed = await cdp.ev("document.querySelector('#sheetEdit').classList.contains('open')");
    if (tlClosed) throw new Error('时间线没有关掉');
    const rainSub = await cdp.ev("[...document.querySelectorAll('#bandList .band-item-name')].find(n=>n.textContent.indexOf('雨声')>=0).querySelector('span').textContent");
    log('      雨声摘要：' + rainSub);
    if (rainSub.indexOf('段') < 0) throw new Error('行摘要没有跟着更新：' + rainSub);
    await cdp.shot('06-amb-edited');

    /* 切回乐器页：添加区换成家族，但顶层清单不变 */
    await cdp.ev("[...document.querySelectorAll('#bandTabs button')].find(b=>b.textContent==='乐器').click(); 'ok'");
    await sleep(STEP);
    const rowsBack = await cdp.ev("[...document.querySelectorAll('#bandList .band-item-name b')].map(b=>b.textContent).join(' / ')");
    log('      切回乐器后清单：' + rowsBack);
    if (rowsBack !== rowsTop) throw new Error('切页签后顶层清单变了：' + rowsBack);

    /* 试听阶段就能编曲：候选当临时轨，调好区间 / 律动 / 调性再「加入乐队」 */
    log('\n[额外] 试听时就编曲，再加入');
    await cdp.ev("[...document.querySelectorAll('.band-cat')].find(b=>b.textContent.indexOf('键盘')===0).click(); 'ok'");
    await sleep(STEP);
    await cdp.ev("document.querySelector('#bandAdd [data-preview-tune]').click(); 'ok'");
    await sleep(STEP);

    const pvNames = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].map(r=>r.textContent).join(' / ')");
    log('      试听轨：' + pvNames);
    if (pvNames.indexOf('试听中') < 0) throw new Error('候选没有作为临时轨出现：' + pvNames);

    /* 剪贴板跨会话保留：刚才复制过，换一个面板进来仍然能粘 */
    const pasteReady = await cdp.ev("(function(){var b=document.querySelector('#tlBar [data-act=\"paste\"]');return b?(b.disabled?'off':'on'):'none';})()");
    log('      粘贴可用：' + pasteReady);
    if (pasteReady !== 'on') throw new Error('剪贴板丢了：' + pasteReady);

    const keyBefore = await cdp.ev("document.querySelector('#badgeKey').textContent");
    await cdp.ev("document.querySelector('#sheetEdit .tl-bar [data-key-dir=\"1\"]').click(); 'ok'");
    await sleep(STEP);
    const keyAfter = await cdp.ev("document.querySelector('#badgeKey').textContent");
    log('      变调：' + keyBefore + ' → ' + keyAfter);
    if (keyBefore === keyAfter) throw new Error('整首变调没有生效');

    await cdp.ev("document.querySelector('#sheetEdit .tl-stepgrp[data-end=\"from\"] [data-dir=\"1\"]').click(); 'ok'");
    await sleep(STEP);
    await cdp.ev("document.querySelector('#sheetEdit .tl-bar [data-rate=\"2\"]').click(); 'ok'");
    await sleep(STEP);

    /* 试听轨也能直接拖（以前 data-bi=-1 被当成只读轨，整条点不动） */
    const pvDrag = await cdp.ev([
      "(function(){",
      "  var pick = function(){",
      "    return [].slice.call(document.querySelectorAll('#sheetEdit .tl-row'))",
      "      .filter(function(r){ return r.textContent.indexOf('试听中') >= 0; })[0];",
      "  };",
      "  var clip = pick().querySelector('.tl-clip');",
      "  var before = clip.textContent;",
      "  var r = clip.getBoundingClientRect();",
      "  var x = r.right - 6, y = r.top + r.height / 2;",
      "  var opt = { bubbles: true, cancelable: true, clientX: x, clientY: y,",
      "    pointerId: 8, isPrimary: true, button: 0, buttons: 1 };",
      "  clip.dispatchEvent(new PointerEvent('pointerdown', opt));",
      "  var move = Object.assign({}, opt, { clientX: x - r.width * 0.25 });",
      "  window.dispatchEvent(new PointerEvent('pointermove', move));",
      "  window.dispatchEvent(new PointerEvent('pointerup', move));",
      "  return before + ' | ' + pick().querySelector('.tl-clip').textContent;",
      "})()"
    ].join('\n'));
    log('      试听轨拖右端：' + pvDrag);
    const pvPair = pvDrag.split(' | ');
    if (pvPair[0] === pvPair[1]) throw new Error('试听轨的片段拖不动：' + pvDrag);

    const pvLab = await cdp.ev("[...document.querySelectorAll('#sheetEdit .tl-row')].filter(r=>r.textContent.indexOf('试听中')>=0)[0].querySelector('.tl-clip').textContent");
    log('      试听片段：' + pvLab);
    if (pvLab.indexOf('0.5') !== 0) throw new Error('试听轨的起点被拖走了：' + pvLab);
    await cdp.shot('06d-add-tune');

    await cdp.ev("[...document.querySelectorAll('#tlBar .tl-btn')].find(b=>b.textContent==='加入乐队').click(); 'ok'");
    await sleep(STEP);
    if (await cdp.ev("document.querySelector('#sheetEdit').classList.contains('open')")) {
      throw new Error('加入乐队后时间线没有关掉');
    }

    const pianoSub = await cdp.ev("[...document.querySelectorAll('#bandList .band-item-name')].find(n=>n.textContent.indexOf('钢琴')>=0).querySelector('span').textContent");
    log('      加入后的钢琴：' + pianoSub);
    if (pianoSub.indexOf('0.5–') < 0 || pianoSub.indexOf('整段') >= 0) {
      throw new Error('试听时调好的片段没有带进乐队：' + pianoSub);
    }
    await cdp.shot('06c-inst-clip');

    /* 示范区：常用的和弦走向 + 氛围底色，各点一下 */
    log('\n[示范] 换一条和弦走向，再叠一组底色');
    await cdp.ev("[...document.querySelectorAll('#bandTabs button')].find(b=>b.textContent==='示范').click(); 'ok'");
    await sleep(STEP);
    const progCards = await cdp.ev("[...document.querySelectorAll('#bandAdd [data-prog]')].map(b=>b.getAttribute('data-prog')).join(',')");
    log('      走向卡片：' + progCards);
    if (progCards.split(',').length < 4) throw new Error('示范走向卡片太少：' + progCards);
    const gridN = await cdp.ev("document.querySelectorAll('#bandAdd .demo-grid').length");
    if (gridN < 2) throw new Error('示范区没有分成和弦 / 底色两块：' + gridN);

    await cdp.ev("document.querySelector('#bandAdd [data-prog=\"p6415\"]').click(); 'ok'");
    await sleep(STEP);
    const progOn = await cdp.ev("[...document.querySelectorAll('#bandAdd .demo-card.on[data-prog]')].map(b=>b.getAttribute('data-prog')).join(',')");
    log('      当前走向：' + progOn);
    if (progOn !== 'p6415') throw new Error('换和弦走向没有生效：' + progOn);
    await cdp.shot('06g-demo');

    await cdp.ev("document.querySelector('#bandAdd [data-amb=\"rainynight\"]').click(); 'ok'");
    await sleep(STEP);
    const names = await cdp.ev("[...document.querySelectorAll('#bandList .band-item-name b')].map(b=>b.textContent).join(' / ')");
    log('      加底色后：' + names);
    if (names.indexOf('夜晚虫鸣') < 0) throw new Error('底色没有叠上去：' + names);
    if (!(await cdp.ev("!!document.querySelector('#bandAdd [data-amb=\"rainynight\"].on')"))) {
      throw new Error('底色卡片没有标成「已在铺底」');
    }

    /* 可选：在乐队面板里现录一段人声（和首页一样的四拍倒计时 + 八拍） */
    if (FLAGS.hum) {
      log('\n[额外] 乐队里现录一段人声');
      /* 人声在「乐器」页签下；先切回乐器，再把音色 chip 点出来 */
      await cdp.ev([
        "(function(){",
        "  var tab = [].slice.call(document.querySelectorAll('#bandTabs button'))",
        "    .filter(function(b){ return b.textContent === '乐器'; })[0];",
        "  if (tab && !tab.classList.contains('on')) tab.click();",
        "  var has = [].slice.call(document.querySelectorAll('.band-add-chips .chip'))",
        "    .some(function(b){ return b.textContent === '我的哼唱'; });",
        "  if (!has) {",
        "    var c = [].slice.call(document.querySelectorAll('.band-cat'))",
        "      .filter(function(b){ return b.textContent.indexOf('人声') === 0; })[0];",
        "    if (c) c.click();",
        "  }",
        "  return 'ok';",
        "})()"
      ].join('\n'));
      await sleep(STEP);
      await cdp.ev("[...document.querySelectorAll('.band-add-chips .chip')].find(b=>b.textContent==='我的哼唱').click(); 'ok'");
      await sleep(STEP);
      await cdp.ev("[...document.querySelectorAll('#bandAdd .btn')].find(b=>/重录一条|哼一段/.test(b.textContent)).click(); 'ok'");
      await sleep(STEP);

      let st = '';
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        st = await cdp.ev("(document.querySelector('.screen.active')||{dataset:{}}).dataset.screen");
        if (st === 'record') break;
      }
      log('      进入录音界面：' + st);
      await cdp.shot('06-band-recording');

      for (let i = 0; i < 40; i++) {
        await sleep(500);
        st = await cdp.ev("(document.querySelector('.screen.active')||{dataset:{}}).dataset.screen");
        if (st === 'result') break;
      }
      await sleep(STEP * 2);
      log('      录完回到：' + st);
      log('      乐队：' + await cdp.ev("document.querySelector('#bandSummary').textContent"));
      log('      人声行数：' + await cdp.ev("[...document.querySelectorAll('.band-item-name b')].filter(b=>b.textContent==='我的哼唱').length"));
      await cdp.shot('07-band-hum-done');
    }

    if (FLAGS.keep) {
      log('\n窗口保留中，自己点几下试试；关掉窗口即结束。');
      await new Promise(function () {});
    }

    log('\n控制台报错：' + cdp.errors.length);
    cdp.errors.forEach(function (e) { log('  ' + e); });
    if (cdp.errors.length) throw new Error('页面有 ' + cdp.errors.length + ' 条报错');
    log('\n通过：识别、调性、人声层、氛围层、加入前微调都正常。');
  } catch (e) {
    failed = e;
    log('\n失败：' + e.message);
    if (cdp) {
      try {
        log('  当前界面：' + await cdp.ev("(document.querySelector('.screen.active')||{dataset:{}}).dataset.screen"));
      } catch (e2) { /* 页面可能已经挂了 */ }
      cdp.errors.forEach(function (x) { log('  ' + x); });
      await cdp.shot('99-fail');
    }
  } finally {
    if (cdp) cdp.close();
    if (!FLAGS.keep) {
      try { proc.kill(); } catch (e) {}
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    }
  }

  process.exit(failed ? 1 : 0);
})();
