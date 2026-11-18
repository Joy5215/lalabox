/* 本地开发服务器：node tools/serve.js [port]
 * 也可以被别的脚本复用：require('./serve').start(8080, { quiet: true })
 * 手机与电脑同一 Wi-Fi 时，用打印出来的局域网地址打开，刷新即可看到最新代码。
 * 注意：外部访问时没有 toy SDK，麦克风走浏览器原生权限；真机首选 tools/tunnel.js（https 隧道）。
 *
 * opts.quiet 为真时不打印局域网清单，交给调用方统一输出。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    });
  });
  return out;
}

/* 路由与静态文件处理：/latest 302、路径穿越 403、缺失 404、no-store */
function createServer() {
  return http.createServer(function (req, res) {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    /* 固定入口：跳到最近一次 toy update 的预览地址，书签用这条即可 */
    if (urlPath === '/latest') {
      fs.readFile(path.join(ROOT, '.latest-preview'), 'utf8', function (err, txt) {
        if (err || !txt.trim()) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<meta charset="utf-8"><body style="font:14px system-ui;padding:24px">'
            + '还没有预览链接，先让我推一版到 Toy。</body>');
          return;
        }
        res.writeHead(302, { Location: txt.trim(), 'Cache-Control': 'no-store' });
        res.end();
      });
      return;
    }

    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    fs.readFile(file, function (err, data) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + urlPath);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  });
}

function printHint(port) {
  const lines = ['', '  电脑： http://localhost:' + port + '/'];
  lanAddresses().forEach(function (ip) {
    lines.push('  手机： http://' + ip + ':' + port + '/   （同一 Wi-Fi，不要用 localhost）');
  });
  lines.push(
    '',
    '  /latest 会跳到 Toy 预览页：手机上需要浏览器里已登录 B 站作者账号，',
    '  没登录会被挡在门外，真机看最新代码请直接用上面的根地址。',
    '',
    '  手机要麦克风请用 node tools/tunnel.js 的 https 地址（局域网 IP 不是安全上下文）。',
    '',
    '  停止：Ctrl+C 或 taskkill /PID ' + process.pid,
    ''
  );
  console.log(lines.join('\n'));
}

/* 起服务并立即返回 { server, port }，listen 完成后再打印提示 */
function start(port, opts) {
  opts = opts || {};
  port = Number(port) || 8080;

  const server = createServer();

  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('');
      console.error('  端口 ' + port + ' 已被占用：先关掉旧的 serve.js / tunnel.js，或换一个端口重试。');
      console.error('  换端口：node tools/serve.js ' + (port + 1));
      console.error('');
      process.exit(1);
    }
    if (typeof opts.onError === 'function') {
      opts.onError(err);
      return;
    }
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', function () {
    if (!opts.quiet) printHint(port);
    if (typeof opts.onListen === 'function') opts.onListen(port);
  });

  return { server: server, port: port };
}

if (require.main === module) {
  start(Number(process.argv[2] || 8080));
}

module.exports = {
  start: start,
  createServer: createServer,
  lanAddresses: lanAddresses,
  ROOT: ROOT,
  MIME: MIME
};
