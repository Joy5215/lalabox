/* 一键同步：拉取(rebase) → 提交本地改动 → 推送
 * 用法：node tools/git-sync.js ["提交信息"]
 *       或 npm run sync -- "提交信息"
 * 走仓库已配置的 origin（SSH / HTTPS 都行）；冲突时停下让你手动处理，绝不 force push。
 */
'use strict';
const { spawnSync } = require('child_process');

const BRANCH = 'main';
/* 部分网络封了 22 端口，GitHub 官方给出的 SSH-over-443 地址 */
const DEFAULT_ORIGIN = 'ssh://git@ssh.github.com:443/Joy5215/lalabox.git';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function die(msg) {
  console.error('\n✗ ' + msg);
  process.exit(1);
}

/* 跑 git，输出直接透传给终端 */
function run(args) {
  const r = spawnSync('git', args, { stdio: 'inherit' });
  if (r.error) die('找不到 git：' + r.error.message);
  return r.status;
}

/* 跑 git，只取 stdout / stderr（去掉首尾空白） */
function out(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) die('找不到 git：' + r.error.message);
  return { status: r.status, text: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

(function main() {
  /* 1. 必须在仓库里跑 */
  if (out(['rev-parse', '--show-toplevel']).status !== 0) {
    die('当前目录不是 git 仓库，请在项目根目录运行');
  }

  /* 2. origin 缺失就按默认地址补上（已存在则沿用，不擅自改） */
  if (!out(['remote', 'get-url', 'origin']).text) {
    console.log('· 未配置 origin，补上默认地址：' + DEFAULT_ORIGIN);
    if (run(['remote', 'add', 'origin', DEFAULT_ORIGIN]) !== 0) die('配置 origin 失败');
  }

  /* 3. 远端已有 main 才拉取；首次推送（远端为空）跳过 */
  const ls = out(['ls-remote', '--heads', 'origin', BRANCH]);
  if (ls.status !== 0) {
    if (ls.err) console.error(ls.err);
    die('无法访问 origin（检查 SSH key / 网络 / 仓库权限）');
  }
  if (ls.text) {
    console.log('· 拉取远端 ' + BRANCH + '（rebase，自动暂存本地改动）');
    if (run(['pull', '--rebase', '--autostash', 'origin', BRANCH]) !== 0) {
      console.error('\n✗ 拉取 / rebase 失败：可能有冲突。请手动处理：');
      console.error('    git rebase --continue   # 解决冲突后继续');
      console.error('    git rebase --abort      # 放弃本次拉取');
      process.exit(1);
    }
  } else {
    console.log('· 远端还没有 ' + BRANCH + '，跳过拉取（首次推送）');
  }

  /* 4. 有改动才提交，避免空提交 */
  const msg = process.argv.slice(2).join(' ').trim() || ('chore: sync ' + stamp());
  if (run(['add', '-A']) !== 0) die('git add 失败');
  const dirty = spawnSync('git', ['diff', '--cached', '--quiet']).status !== 0;
  if (dirty) {
    console.log('· 提交本地改动：' + msg);
    if (run(['commit', '-m', msg]) !== 0) die('提交失败');
  } else {
    console.log('· 没有需要提交的改动');
  }

  /* 5. 推送；没有 upstream 就顺手建立跟踪 */
  const hasUpstream = spawnSync('git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { encoding: 'utf8' }).status === 0;
  console.log('· 推送到 origin/' + BRANCH);
  const pushArgs = hasUpstream ? ['push', 'origin', BRANCH] : ['push', '-u', 'origin', BRANCH];
  if (run(pushArgs) !== 0) die('推送失败（检查 SSH key / 网络 / 仓库权限）');

  console.log('\n✓ 已同步');
})();
