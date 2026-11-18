/* 真机排查用：接收页面 POST 上来的 PCM 与音符，落盘到 tools/.dump/
 *
 * 为什么需要它：手机浏览器没有 devtools，识别结果对不对只能靠猜。
 * 页面加 ?debug=1 时会把录音 PCM 与识别出的音符一起 POST 过来，
 * 电脑侧就能拿着真实录音离线复跑 ANALYZE，找出到底是采集还是算法的问题。
 *
 * 用法：
 *   node tools/dump-server.js            # 监听 8099
 *   adb reverse tcp:8099 tcp:8099        # 手机上 localhost:8099 指到这台电脑
 *
 * 只给开发期用，不属于玩具包，不会被 tools/pack.js 打进 dist。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8099);
const OUT = path.join(__dirname, '.dump');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('lalabox dump server');
    return;
  }

  const chunks = [];
  let size = 0;
  req.on('data', function (c) { chunks.push(c); size += c.length; });
  req.on('end', function () {
    const url = new URL(req.url || '/dump', 'http://localhost');
    const name = (url.pathname.replace(/^\/+/, '') || 'dump').replace(/[^\w.-]/g, '_');
    const meta = {};
    url.searchParams.forEach(function (v, k) { meta[k] = v; });

    fs.mkdirSync(OUT, { recursive: true });
    const base = path.join(OUT, stamp() + '-' + name);
    const body = Buffer.concat(chunks);
    fs.writeFileSync(base + '.bin', body);
    fs.writeFileSync(base + '.json', JSON.stringify({ query: meta, bytes: size }, null, 2));

    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok ' + size);
    console.log('  dump ' + name + '  ' + size + ' bytes  ' + JSON.stringify(meta));
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('  dump server: http://localhost:' + PORT + '/  →  ' + OUT);
});
