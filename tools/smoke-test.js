/* 纯逻辑模块冒烟测试：node tools/smoke-test.js
 * 只加载不依赖 DOM 的模块，验证编解码 / 成曲 / 编曲的契约。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = {
  window: {},
  console: console,
  performance: { now: () => Date.now() },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

['js/core/utils.js', 'js/music/arrange.js', 'js/music/codec.js', 'js/music/compose.js']
  .forEach(function (file) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  });

const L = sandbox.window.LALA;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

const raw = [
  { b: 0, d: 1, m: 69 }, { b: 1, d: 0.5, m: 72 }, { b: 1.5, d: 0.5, m: 74 },
  { b: 2, d: 1, m: 72 }, { b: 3, d: 1, m: 69 }, { b: 4, d: 1, m: 67 }
];

console.log('[compose]');
const song = L.COMPOSE.buildSong(raw);
check('notes 数量保持', song.notes.length === raw.length, song.notes.length);
check('4 小节和弦', song.bars.length === 4);
check('调性在范围内', song.tonic >= 0 && song.tonic <= 11, song.tonic);
check('音高落在 48~96', song.notes.every(function (n) { return n.m >= 48 && n.m <= 96; }));

console.log('[codec]');
const code = L.CODEC.encode(song);
check('编码长度 < 128', code.length < 128, code.length);
check('字符集合合法', /^[0-9a-z]+$/.test(code));
const back = L.CODEC.decode(code);
check('可解码', !!back);
check('往返一致', back && back.notes.length === song.notes.length
  && back.bars.join() === song.bars.join()
  && back.tonic === song.tonic
  && back.mode === song.mode
  && back.notes.every(function (n, i) {
    return n.m === song.notes[i].m && Math.abs(n.b - song.notes[i].b) < 1e-6;
  }));

check('拒绝空串', L.CODEC.decode('') === null);
check('拒绝大写/非法字符', L.CODEC.decode('AAAAAAAAAAAAAAAA') === null);
check('拒绝超长', L.CODEC.decode('1'.repeat(600)) === null);
check('拒绝乱码', L.CODEC.decode('zzzzzzzzzzzz') === null);

console.log('[arrange]');
const evs = L.ARRANGE.arrange(song);
check('有事件产出', evs.length > 20, evs.length);
check('含主旋律', evs.some(function (e) { return e.t === 'lead'; }));
check('含鼓组', evs.some(function (e) { return e.t === 'kick'; }));
check('事件按拍排序', evs.every(function (e, i) { return i === 0 || evs[i - 1].b <= e.b; }));

console.log('[style]');
['edm', 'lofi', 'rock'].forEach(function (s) {
  song.style = s;
  song._arr = null;
  const e2 = L.ARRANGE.arrange(song);
  check(s + ' 可编曲', e2.length > 20, e2.length);
});

console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
process.exit(failed ? 1 : 0);
