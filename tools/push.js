/* 一条命令推到 Toy 预览：node tools/push.js [toy-id]
 * 打包 → 上传预览（不送审）→ 把预览地址写进 .latest-preview，
 * 于是 node tools/serve.js 的 /latest 永远指向最新一版。
 * 注意：预览地址每次 update 都会换 token，所以不要直接收藏它，收藏 /latest。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TOY_ID = process.argv[2] || '55182818016256';
const TOY = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'toy', 'toy.exe');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(TOY)) fail('找不到 toy CLI：' + TOY + '\n先装好 toy，或把 toy.exe 加到 PATH。');

const pack = spawnSync(process.execPath, [path.join(__dirname, 'pack.js')], {
  cwd: ROOT,
  encoding: 'utf8'
});
process.stdout.write(pack.stdout || '');
if (pack.status !== 0) fail(pack.stderr || '打包失败');

const up = spawnSync(TOY, ['update', TOY_ID, 'dist', '--json'], {
  cwd: ROOT,
  encoding: 'utf8'
});
if (up.status !== 0) fail((up.stderr || up.stdout || '上传失败').trim());

let preview;
try {
  preview = JSON.parse((up.stdout || '').trim()).preview_url;
} catch (e) {
  fail('解析 toy 输出失败，原始输出：\n' + up.stdout);
}
if (!preview) fail('toy 没有返回 preview_url：\n' + up.stdout);

fs.writeFileSync(path.join(ROOT, '.latest-preview'), preview + '\n');
console.log('预览地址已更新（未送审）：' + preview);
console.log('固定入口： node tools/serve.js 之后打开 http://localhost:8080/latest');
