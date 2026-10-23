/* pi 更新履历报告：源探测必须挑「版本最高的那份 pi」。
   跑法：node tools/tests/test_pi_changelog.js

   为什么要单测这一条：本机同时装了两份 pi —— npm 全局的是新版，nvm 各版本
   node_modules 里躺着旧的。生成器以前是「先找到的先用」，于是 check 一直在拿旧
   CHANGELOG 重算（报告 1.3.0 vs 重算 1.1.0），红得莫名其妙。这里造两份假安装：
   目录序靠前的是旧版、靠后的只有 CHANGELOG 没有 package.json，断言 probe 选靠后
   的那份（顺带钉住「版本从 CHANGELOG 头回退读取」）。第二段钉住 npm 全局装法：
   shim 落在 PATH 前缀根上，包在前缀根的 node_modules 里 —— 不扫 PATH 就永远找不到它。
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GEN = path.join(ROOT, 'tools', 'pi-changelog-gen.mjs');
const REL = path.join('node_modules', '@earendil-works', 'pi-coding-agent');

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-changelog-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

/** 造一份假安装：version 非空才写 package.json；CHANGELOG 头单独给，用来测版本回退 */
function mkInstall(rel, version, changelogVersion) {
  const pkgDir = path.join(TMP, rel, REL);
  fs.mkdirSync(pkgDir, { recursive: true });
  if (version) {
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
  }
  fs.writeFileSync(
    path.join(pkgDir, 'CHANGELOG.md'),
    `# Changelog\n\n## [${changelogVersion}] - 2026-10-21\n\n### Added\n\n- fake entry\n`
  );
  return path.join(pkgDir, 'CHANGELOG.md');
}

function probe(env) {
  const r = spawnSync(process.execPath, [GEN, 'probe'], { cwd: ROOT, encoding: 'utf8', timeout: 60000, env });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '') };
}

/* 1. nvm 里两份并存：目录序在前的是旧版，靠后的只有 CHANGELOG（9.9.0） */
const oldNvm = mkInstall(path.join('nvmroot', 'nvm', 'a-old'), '1.1.0', '1.1.0');
const newNvm = mkInstall(path.join('nvmroot', 'nvm', 'z-new'), null, '9.9.0');
const r1 = probe({ ...process.env, LOCALAPPDATA: path.join(TMP, 'nvmroot'), APPDATA: path.join(TMP, 'no-appdata') });
eq(r1.code, 0, 'nvm 下有两份安装时 probe 仍退出 0');
eq(r1.out, newNvm, 'probe 选版本更高的那份（不是「先找到的」）');
ok(r1.out !== oldNvm, `没退回旧安装：${oldNvm}`);

/* 2. 版本比较走数字段：1.10.0 比 1.9.0 新（字符串比较会反过来） */
mkInstall(path.join('cmp', 'nvm', 'a'), null, '1.9.0');
const cmpNew = mkInstall(path.join('cmp', 'nvm', 'z'), null, '1.10.0');
const r2 = probe({ ...process.env, LOCALAPPDATA: path.join(TMP, 'cmp'), APPDATA: path.join(TMP, 'no-appdata') });
eq(r2.out, cmpNew, '1.10.0 比 1.9.0 新（按数字段比较，不是字符串比较）');

/* 3. npm 全局装法：shim 在前缀根上，包在 <前缀根>/node_modules —— 必须经 PATH 找到 */
const globalPrefix = mkInstall(path.join('pfx'), '7.7.7', '7.7.7');
fs.mkdirSync(path.join(TMP, 'empty-nvm'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'empty-appdata'), { recursive: true });
const r3 = probe({
  ...process.env,
  PATH: path.join(TMP, 'pfx'),
  LOCALAPPDATA: path.join(TMP, 'empty-nvm'),
  APPDATA: path.join(TMP, 'empty-appdata'),
});
eq(r3.code, 0, '只有 npm 全局前缀（PATH 上）时 probe 仍退出 0');
eq(r3.out, globalPrefix, 'probe 扫到 PATH 前缀的 node_modules');

/* 4. 报告里的「1.x 大版本速览」：五张卡、每条都有中文，1.x 每个版本都挂在对应卡里 */
const report = fs.readFileSync(path.join(ROOT, 'research', 'pi-changelog.html'), 'utf8');
const cards = [...report.matchAll(/<article class="major" id="major-(1\.\d+)">([\s\S]*?)<\/article>/g)].map((m) => ({
  minor: m[1],
  body: m[2],
}));
for (const m of ['1.0', '1.1', '1.2', '1.3', '1.4']) ok(cards.some((c) => c.minor === m), `速览卡存在：${m}`);

const items = cards.flatMap((c) => [...c.body.matchAll(/<li class="mj-item">([\s\S]*?)<\/li>/g)].map((x) => x[1]));
ok(items.length >= 42, `速览条目至少 42 条（1.x 新功能 37 + 破坏性 5），实际 ${items.length}`);
eq(items.filter((x) => !/<span class="mj-zh">/.test(x)).length, 0, '每条速览条目都有中文一格');
eq(
  items.filter((x) => {
    const zh = x.slice(x.indexOf('<span class="mj-zh">'), x.indexOf('<span class="mj-en">'));
    return !/[\u4e00-\u9fa5]/.test(zh);
  }).length,
  0,
  '中文一格真的写了中文（不是占位）'
);
ok(!/还没写中文概览/.test(report), '报告里没有「还没写中文概览」的占位');

/* 源升了大版本却忘了补卡 / 补中文，这两条会先红 */
const xVersions = [...new Set([...report.matchAll(/id="v-(1\.\d+\.\d+)"/g)].map((m) => m[1]))];
ok(xVersions.length >= 9, `归档里的 1.x 版本至少 9 个，实际 ${xVersions.length}`);
for (const v of xVersions) {
  const minor = v.split('.').slice(0, 2).join('.');
  const card = cards.find((c) => c.minor === minor);
  ok(!!card && card.body.includes(`href="#v-${v}"`), `${v} 挂在 ${minor} 速览卡里`);
}

console.log(`\n${fails.length ? '✗ FAIL' : '✓ 全部通过'} (${pass} 项)`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
