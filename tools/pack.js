/* 生成 Toy 上传包：node tools/pack.js
 * 只拷贝运行时需要的文件，排除 .git / tools / README，避免包里混入无关内容。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

['index.html', 'css', 'js'].forEach(function (name) {
  fs.cpSync(path.join(root, name), path.join(dist, name), { recursive: true });
});

function walk(dir) {
  let total = 0;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const p = path.join(dir, d.name);
    total += d.isDirectory() ? walk(p) : fs.statSync(p).size;
  });
  return total;
}

const entry = fs.statSync(path.join(dist, 'index.html')).size;
const all = walk(dist);
console.log('dist/index.html  ' + (entry / 1024).toFixed(1) + ' KB  (上限 1024 KB)');
console.log('dist 总计        ' + (all / 1024).toFixed(1) + ' KB');

if (entry > 1024 * 1024) {
  console.error('入口 index.html 超过 1MB，Toy 会拒绝发布');
  process.exit(1);
}
