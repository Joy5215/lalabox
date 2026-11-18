/* 真机调试入口：node tools/tunnel.js [port] [--check] [--no-server]
 *
 * 一条命令做三件事：起本地静态服务（复用 serve.js）、起 cloudflared quick tunnel、
 * 把 https://xxx.trycloudflare.com 打印出来。手机直接开这个地址即可：
 * https 属于安全上下文，navigator.mediaDevices 正常，麦克风权限能弹。
 * 不依赖 USB / adb reverse，电脑重启后也不用重设。
 *
 * 开关：
 *   --check      只探测环境（cloudflared 是否可用、端口是否可绑），不启动任何进程
 *   --no-server  本机已有 serve.js 在跑，只打隧道
 *
 * quick tunnel 的域名每次启动都变，所以只打印、不写文件，避免文档里出现假死的固定地址。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const serve = require('./serve');

const WAIT_MS = 20000;          /* 超过这么久没解析出地址就判定失败 */
const TAIL_LINES = 20;          /* 失败时回放 cloudflared 最近多少行 */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let server = null;
let child = null;
let cleaned = false;

function printUsage() {
  console.log([
    '',
    '  用法：node tools/tunnel.js [port] [--check] [--no-server]',
    '',
    '    port         本地端口，默认 8080',
    '    --check      只探测 cloudflared 与端口，不启动',
    '    --no-server  不自起服务（已有 serve.js 在跑时用）',
    ''
  ].join('\n'));
}

function parseArgs(argv) {
  const opts = { port: 8080, check: false, withServer: true };
  argv.forEach(function (a) {
    if (a === '--check') opts.check = true;
    else if (a === '--no-server') opts.withServer = false;
    else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else if (/^\d+$/.test(a)) {
      opts.port = Number(a);
    } else {
      console.error('  未知参数：' + a);
      printUsage();
      process.exit(1);
    }
  });
  return opts;
}

function printInstall() {
  console.error('  装 cloudflared（任选一种）：');
  if (process.platform === 'win32') {
    console.error('    winget install --id Cloudflare.cloudflared');
    console.error('    scoop install cloudflared');
  } else if (process.platform === 'darwin') {
    console.error('    brew install cloudflared');
  } else {
    console.error('    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  }
  console.error('  不想装：保证 npx 可用后重跑，脚本会自动走 npx --yes cloudflared。');
  console.error('  先自检：node tools/tunnel.js --check');
  console.error('');
}

/* 查找顺序：PATH → 项目 tools/bin → %LOCALAPPDATA% → npx；全部失败返回 { cmd: null } */
function findCloudflared() {
  const tried = [];
  const probe = spawnSync('cloudflared', ['--version'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  if (!probe.error && probe.status === 0) {
    return { cmd: 'cloudflared', shell: false, how: 'PATH 里的 cloudflared' };
  }
  tried.push('PATH 里的 cloudflared');

  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const cands = [path.join(__dirname, 'bin', exe)];
  if (process.env.LOCALAPPDATA) {
    cands.push(path.join(process.env.LOCALAPPDATA, 'cloudflared', exe));
  }
  for (let i = 0; i < cands.length; i++) {
    const p = cands[i];
    if (!fs.existsSync(p)) continue;
    const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (!r.error && r.status === 0) {
      return { cmd: p, shell: false, how: p };
    }
    tried.push(p);
  }

  /* npx 走 shell：Windows 上 npx 是 .cmd，shell:true 时整条命令作为字符串传，避免 DEP0190 */
  const npx = spawnSync('npx --yes cloudflared --version', {
    encoding: 'utf8', shell: true, timeout: 90000, windowsHide: true
  });
  if (!npx.error && npx.status === 0) {
    return {
      cmd: 'npx --yes cloudflared',
      shell: true,
      how: 'npx --yes cloudflared（首次会下载，稍慢）'
    };
  }
  tried.push('npx --yes cloudflared');

  return { cmd: null, tried: tried };
}

/* 试绑一次端口，判断能不能起服务（服务未启动时用） */
function portUsable(port) {
  return new Promise(function (resolve) {
    const probe = net.createServer();
    probe.once('error', function () {
      resolve(false);
    });
    probe.once('listening', function () {
      probe.close(function () {
        resolve(true);
      });
    });
    probe.listen(port, '0.0.0.0');
  });
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;

  if (child && child.pid) {
    if (process.platform === 'win32') {
      /* child.kill() 在 Windows 上常留下 cloudflared 子进程，直接结束进程树 */
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true
        });
      } catch (e) { /* 进程可能已经没了 */ }
    } else {
      try { child.kill('SIGTERM'); } catch (e) { /* 同上 */ }
    }
    child = null;
  }

  if (server) {
    try { server.close(); } catch (e) { /* 已经关了 */ }
    server = null;
  }
}

function fail(msg, tail) {
  console.error('');
  console.error('  ' + msg);
  console.error('');
  if (tail && tail.length) {
    console.error('  cloudflared 最近输出：');
    tail.forEach(function (line) {
      console.error('    ' + line);
    });
    console.error('');
  }
  console.error('  常见原因：');
  console.error('    - 代理 / VPN 拦住了出站连接或 DNS，先关掉再试');
  console.error('    - Cloudflare 对 quick tunnel 限流（429），等一两分钟再跑');
  console.error('    - 公司网禁 UDP/QUIC，可试 CLOUDFLARED_PROTOCOL=http2 再跑');
  console.error('    - 完全没网：换手机热点验证');
  console.error('  兜底：断网环境用 adb reverse，见 DEV-NOTES.md 第一节。');
  console.error('');
  cleanup();
  process.exit(1);
}

function printReady(url, port) {
  const base = url.replace(/\/+$/, '');
  console.log('');
  console.log('  ------------------------------------------------------------');
  console.log('  手机打开： ' + base + '/');
  console.log('  最新预览： ' + base + '/latest');
  console.log('  电脑自测： http://localhost:' + port + '/');
  console.log('');
  console.log('  这是 https，navigator.mediaDevices 可用；第一次点麦克风浏览器会弹权限，');
  console.log('  没弹就检查浏览器是否把这个站点设成了「拒绝麦克风」。');
  console.log('');
  console.log('  临时公网地址，域名每次启动都变，别写进文档或收藏；用完 Ctrl+C。');
  console.log('  cloudflared 原生日志已收起，出错时会自动回放最后几行。');
  console.log('  ------------------------------------------------------------');
  console.log('');
}

function startTunnel(port, cf) {
  const args = [
    'tunnel',
    '--url', 'http://localhost:' + port,
    '--no-autoupdate'
  ];

  /* shell 模式（npx）传整条命令字符串，参数里没有空格，交给 cmd/sh 拼即可 */
  child = cf.shell
    ? spawn([cf.cmd].concat(args).join(' '), {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    : spawn(cf.cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

  const tail = [];
  let done = false;
  let timer = null;

  function feed(chunk) {
    String(chunk).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    });
  }

  /* cloudflared 的 banner 走 stderr，两条流都要看 */
  function onData(chunk) {
    feed(chunk);
    if (done) return;
    const m = String(chunk).match(URL_RE);
    if (!m) return;
    done = true;
    if (timer) clearTimeout(timer);
    printReady(m[0], port);
  }

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', function (err) {
    if (done || cleaned) return;
    done = true;
    if (timer) clearTimeout(timer);
    fail('cloudflared 启动失败：' + (err && err.message ? err.message : String(err)), tail);
  });

  child.on('exit', function (code, signal) {
    if (cleaned) return;                 /* 自己收工导致的退出，不再报错 */
    const why = 'code=' + code + (signal ? '，signal=' + signal : '');
    if (!done) {
      done = true;
      if (timer) clearTimeout(timer);
      fail('cloudflared 提前退出（' + why + '）', tail);
      return;
    }
    /* 地址已经给过，之后隧道断了：地址失效，收工比留个假地址好 */
    console.error('');
    console.error('  cloudflared 已退出（' + why + '），刚才的 https 地址失效了。');
    console.error('  重跑 node tools/tunnel.js 拿新地址；本地服务也一并关掉。');
    console.error('');
    cleanup();
    process.exit(1);
  });

  timer = setTimeout(function () {
    if (done) return;
    done = true;
    fail('等了 ' + (WAIT_MS / 1000) + ' 秒还没拿到隧道地址', tail);
  }, WAIT_MS);
}

/* 环境自检：cloudflared 是否可用 + 端口是否可绑 */
async function runCheck(opts) {
  console.log('');
  console.log('  环境自检');
  console.log('');

  let ok = true;
  const cf = findCloudflared();
  if (cf.cmd) {
    console.log('  [ok] cloudflared：' + cf.how);
  } else {
    ok = false;
    console.log('  [!!] cloudflared：没找到（PATH / tools/bin / LOCALAPPDATA / npx 都试过）');
    console.log('');
    printInstall();
  }

  const free = await portUsable(opts.port);
  if (free) {
    console.log('  [ok] 端口 ' + opts.port + '：可绑定');
  } else {
    ok = false;
    console.log('  [!!] 端口 ' + opts.port + '：已被占用，先关掉旧的 serve.js / tunnel.js，或换端口');
  }

  console.log('');
  console.log(ok
    ? '  可以直接跑：node tools/tunnel.js ' + opts.port
    : '  先按上面的提示处理，再跑：node tools/tunnel.js ' + opts.port);
  console.log('');
  process.exit(ok ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.check) {
    await runCheck(opts);
    return;
  }

  const cf = findCloudflared();
  if (!cf.cmd) {
    console.error('');
    console.error('  找不到 cloudflared，也没有可用的 npx。');
    console.error('');
    printInstall();
    process.exit(1);
  }

  if (opts.withServer) {
    const free = await portUsable(opts.port);
    if (!free) {
      console.error('');
      console.error('  端口 ' + opts.port + ' 已被占用：先关掉旧的 serve.js / tunnel.js，或换端口。');
      console.error('    node tools/tunnel.js ' + (opts.port + 1));
      console.error('  已有服务在跑、只想打隧道：node tools/tunnel.js ' + opts.port + ' --no-server');
      console.error('');
      process.exit(1);
    }
    server = serve.start(opts.port, { quiet: true }).server;
    console.log('  本地服务已起：http://localhost:' + opts.port + '/');
  } else {
    console.log('  跳过本地服务（--no-server），假定 ' + opts.port + ' 上已有 serve.js 在跑。');
  }

  console.log('  cloudflared：' + cf.how);
  console.log('  正在申请 quick tunnel（首次可能要几秒）…');

  startTunnel(opts.port, cf);
}

['SIGINT', 'SIGTERM'].forEach(function (sig) {
  process.on(sig, function () {
    console.log('');
    console.log('  收工：本地服务与隧道都已关闭。');
    cleanup();
    process.exit(0);
  });
});

process.on('exit', cleanup);

main().catch(function (err) {
  console.error('');
  console.error('  启动失败：' + (err && err.stack ? err.stack : err));
  console.error('');
  cleanup();
  process.exit(1);
});
