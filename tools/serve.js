/* 本地开发服务器：node tools/serve.js [port]
 * 手机与电脑同一 Wi-Fi 时，用打印出来的局域网地址打开，刷新即可看到最新代码。
 * 注意：外部访问时没有 toy SDK，麦克风走浏览器原生权限。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 8080);

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

const server = http.createServer(function (req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

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

server.listen(PORT, '0.0.0.0', function () {
  const lines = ['', '  电脑： http://localhost:' + PORT + '/'];
  lanAddresses().forEach(function (ip) {
    lines.push('  手机： http://' + ip + ':' + PORT + '/   （同一 Wi-Fi）');
  });
  lines.push('', '  停止：Ctrl+C 或 taskkill /PID ' + process.pid, '');
  console.log(lines.join('\n'));
});

module.exports = server;
