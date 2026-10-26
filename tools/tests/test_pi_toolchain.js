/* 《Pi 工具链手册》（tools-dev/pi-toolchain.html）的生成 / 校验测试。
   跑法：node tools/tests/test_pi_toolchain.js

   三段：
     1. 真仓库：check 通过、gen 幂等（连跑两次内容不变）；
     2. 清单接线：tools-dev/data.json 里确实有这条纯文档页记录，page 指向真实文件；
     3. 沙箱：把生成器 + 真源 + 成品复制到临时目录，逐种改坏，断言 check **真的会失败**
        —— 没有这一段，check 可能是个永远返回 0 的空壳。

   沙箱不依赖本机是否装了 pi：check 只比「真源 → 成品」与页面自身断言，缺源是 probe 的事。
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GEN = path.join(ROOT, 'tools', 'pi-toolchain-gen.mjs');
const DATA = path.join(ROOT, 'tools-dev', 'pi-toolchain.data.json');
const PAGE = path.join(ROOT, 'tools-dev', 'pi-toolchain.html');

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const run = (args, cwd) =>
  spawnSync(process.execPath, args, { cwd: cwd || ROOT, encoding: 'utf8', timeout: 120000 });
const check = (cwd) => run([path.join(cwd, 'tools', 'pi-toolchain-gen.mjs'), 'check'], cwd);

/* ---------------------------------------------------------------- 1. 真仓库 */
const first = check(ROOT);
ok(first.status === 0, `真仓库 check 应通过（实际退出码 ${first.status}）：${first.stdout}${first.stderr}`);
ok(/共 \d+ 项断言，全部通过/.test(first.stdout || ''), 'check 应报出断言总数（tools/test.mjs 靠它计数）');

const before = sha256(fs.readFileSync(PAGE));
const write1 = run(['tools/pi-toolchain-gen.mjs'], ROOT);
ok(write1.status === 0, `gen 应成功（退出码 ${write1.status}）：${write1.stderr}`);
const after = sha256(fs.readFileSync(PAGE));
ok(before === after, 'gen 幂等：重跑后成品 sha256 必须不变');

/* ------------------------------------------------------------ 2. 清单接线 */
const toolsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-dev', 'data.json'), 'utf8'));
const rec = (toolsData.tools || []).find((t) => t.id === 'pi-toolchain');
ok(!!rec, 'tools-dev/data.json 里应有 id 为 pi-toolchain 的记录');
if (rec) {
  ok(rec.page === 'pi-toolchain.html', `记录的 page 应指向 pi-toolchain.html（实际 ${rec.page}）`);
  ok(fs.existsSync(path.join(ROOT, 'tools-dev', rec.page)), '记录的 page 必须真实存在');
  ok(Array.isArray(rec.tags) && rec.tags.includes('插件手册'), '记录应带「插件手册」标签');
  ok(toolsData.tags.includes('插件手册'), '受控词表 tags 里应有「插件手册」');
}

/* ------------------------------------------------------------------ 3. 沙箱 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-toolchain-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

function scaffold() {
  fs.rmSync(path.join(TMP, 'tools'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'tools-dev'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'tools', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'tools-dev'), { recursive: true });
  fs.copyFileSync(GEN, path.join(TMP, 'tools', 'pi-toolchain-gen.mjs'));
  fs.copyFileSync(
    path.join(ROOT, 'tools', 'lib', 'eol.mjs'),
    path.join(TMP, 'tools', 'lib', 'eol.mjs')
  );
  fs.copyFileSync(DATA, path.join(TMP, 'tools-dev', 'pi-toolchain.data.json'));
  fs.writeFileSync(path.join(TMP, 'tools-dev', 'pi-toolchain.html'), fs.readFileSync(PAGE));
  /* 真源里有指向同目录其他详情页的 <REPO> 出处（例如 pi-tui.html）：
     沙箱要能把它们也还原成真实文件，否则 A6 会把沙箱误判成出处不可达。 */
  const pageRefs = (/<REPO>\/tools-dev\/([-a-z0-9.]+\.html)/g);
  const dataText = fs.readFileSync(DATA, 'utf8');
  for (const m of dataText.matchAll(pageRefs)) {
    const src = path.join(ROOT, 'tools-dev', m[1]);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, 'tools-dev', m[1]));
  }
}
const pageIn = () => path.join(TMP, 'tools-dev', 'pi-toolchain.html');
const dataIn = () => path.join(TMP, 'tools-dev', 'pi-toolchain.data.json');
const readPage = () => fs.readFileSync(pageIn(), 'utf8');
const writePage = (s) => fs.writeFileSync(pageIn(), s);

/** 重建沙箱后只改真源、不重生成成品：用来验证「真源自身不一致」也能被抓住 */
function mutateData(fn) {
  scaffold();
  const d = JSON.parse(fs.readFileSync(dataIn(), 'utf8'));
  fn(d);
  fs.writeFileSync(dataIn(), JSON.stringify(d, null, 2) + '\n');
}

scaffold();
const clean = check(TMP);
ok(clean.status === 0, `沙箱未改坏时 check 应通过（退出码 ${clean.status}）：${clean.stdout}${clean.stderr}`);

/* 改坏 1：埋一个真实盘符路径（脱敏断言 A3） */
writePage(readPage().replace('</footer>', '<p>C:\\Users\\someone\\notes.txt</p>\n</footer>'));
const buried = check(TMP);
ok(buried.status === 1, `埋真实路径后 check 必须 exit 1（实际 ${buried.status}）`);
ok(/A3/.test(buried.stdout || ''), `失败信息应点名 A3（实际：${buried.stdout}）`);

/* 改坏 2：删掉一个条目（条目不丢 A1） */
scaffold();
writePage(
  readPage().replace(/<article class="entry" id="item-context-mode"[\s\S]*?<\/article>\n?/, '')
);
const lost = check(TMP);
ok(lost.status === 1, `删条目后 check 必须 exit 1（实际 ${lost.status}）`);
ok(/A1/.test(lost.stdout || ''), `失败信息应点名 A1（实际：${lost.stdout}）`);

/* 改坏 3：换成 CRLF 行尾（A4） */
scaffold();
writePage(readPage().replace(/\n/g, '\r\n'));
const crlf = check(TMP);
ok(crlf.status === 1, `CRLF 后 check 必须 exit 1（实际 ${crlf.status}）`);
ok(/A4|CR/.test(crlf.stdout || ''), `失败信息应提到行尾（实际：${crlf.stdout}）`);

/* 改坏 4：插一段外链脚本（file:// 硬约束 A5） */
scaffold();
writePage(readPage().replace('</body>', '<script src="https://example.com/x.js"></script>\n</body>'));
const external = check(TMP);
ok(external.status === 1, `外链脚本后 check 必须 exit 1（实际 ${external.status}）`);
ok(/A5/.test(external.stdout || ''), `失败信息应点名 A5（实际：${external.stdout}）`);

/* 改坏 5：改掉版本表里的一行（版本表一致 A9）。版本值从真源现取，不写死 ——
   写死 6.0.0 的话升级当天这断言就会失真。 */
scaffold();
const firstVer = JSON.parse(fs.readFileSync(DATA, 'utf8')).packages[0].version;
writePage(readPage().replace(`data-ver="${firstVer}"`, 'data-ver="0.0.0-drift"'));
const drift = check(TMP);
ok(drift.status === 1, `版本表被改后 check 必须 exit 1（实际 ${drift.status}）`);
ok(/A9|不一致/.test(drift.stdout || ''), `失败信息应点名版本不一致（实际：${drift.stdout}）`);

/* 改坛 6：真源里声明了更多命令却没列（折叠守恒 A7） */
mutateData((d) => { d.items[0].inDocTotal = 5; });
const short = check(TMP);
ok(short.status === 1, `inDocTotal 与已列条数不符时 check 必须 exit 1（实际 ${short.status}）`);
ok(/A7/.test(short.stdout || ''), `失败信息应点名 A7（实际：${short.stdout}）`);

/* 改坛 7：真源登记了缺口但页里没有（缺口不静默 A8） */
mutateData((d) => {
  d.items[0].undocumented = [
    { topic: '示例缺口甲', srcA: 'a.md:1', srcB: 'b.md:2', choice: '待定' },
  ];
});
const silent = check(TMP);
ok(silent.status === 1, `登记了缺口但页里找不到时 check 必须 exit 1（实际 ${silent.status}）`);
ok(/A8/.test(silent.stdout || ''), `失败信息应点名 A8（实际：${silent.stdout}）`);

/* 改坛 8：出处指向不存在的文件（出处存在 A6）。A6 需要本机有 pi 安装，没有就跳过这一段 */
const hasPiHome = fs.existsSync(path.join(os.homedir(), '.pi', 'agent'));
if (hasPiHome) {
  mutateData((d) => { d.items[0].versionFrom = '<REPO>/definitely-missing.json'; });
  const deadSrc = check(TMP);
  ok(deadSrc.status === 1, `出处不可达时 check 必须 exit 1（实际 ${deadSrc.status}）`);
  ok(/A6/.test(deadSrc.stdout || ''), `失败信息应点名 A6（实际：${deadSrc.stdout}）`);
} else {
  /* 本机没有 pi：这时候要验的是「A6 走跳过而不是假装通过」 */
  const r2 = spawnSync(process.execPath, [path.join(TMP, 'tools', 'pi-toolchain-gen.mjs'), 'check'], {
    cwd: TMP,
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: path.join(TMP, 'no-such-home') },
  });
  ok(r2.status === 0, `无 pi 安装时 check 应通过而不是失败（退出码 ${r2.status}）：${r2.stdout}${r2.stderr}`);
  ok(/–\s*A6/.test(r2.stdout || ''), `无 pi 安装时应明说 A6 跳过（实际：${r2.stdout}）`);
}

/* 折叠阀值：过 30 才折，且折叠不算丢行（A7 守恒） */
scaffold();
{
  const d = JSON.parse(fs.readFileSync(dataIn(), 'utf8'));
  const page = readPage();
  const blockOf = (id) => {
    const i = page.indexOf(`id="item-${id}"`);
    return i < 0 ? '' : page.slice(i, page.indexOf('</article>', i));
  };
  const expectsFold = (it) =>
    (((it.commands || []).length || (it.config || []).length) && (it.inDocTotal || 0) > 30) ||
    (it.rows || []).length > 30;

  const big = d.items.filter(expectsFold);
  ok(big.length > 0, '真源里应有超过折叠阀值的条目（否则这条断言是空转）');
  for (const it of big) {
    ok(/<details class="fold"/.test(blockOf(it.id)), `${it.id} 行数过阀值应被折叠`);
  }
  for (const it of d.items.filter((i) => !expectsFold(i))) {
    ok(!/<details class="fold"/.test(blockOf(it.id)), `${it.id} 未过阀值不应折叠`);
  }
}

/* 真源自身不一致（声明数 ≠ 已列数）时，write 也必须报错退出 1 并点名 A7 */
mutateData((d) => {
  const item = d.items.find((i) => (i.commands || []).length > 0);
  item.inDocTotal = item.commands.length + 1;
});
const grown = run([path.join(TMP, 'tools', 'pi-toolchain-gen.mjs')], TMP);
ok(grown.status === 1, `真源声明数与已列数不符时 write 也应报错退出 1（实际 ${grown.status}）`);
ok(/A7/.test(grown.stdout || ''), `write 的报错应点名 A7（实际：${grown.stdout}）`);

/* 改坏 6：把目录里的一个锚点改成不存在的 id（A2） */
scaffold();
writePage(readPage().replace('href="#sec-terms"', 'href="#sec-no-such-section"'));
const deadLink = check(TMP);
ok(deadLink.status === 1, `锚点指向不存在的 id 时 check 必须 exit 1（实际 ${deadLink.status}）`);
ok(/A2/.test(deadLink.stdout || ''), `失败信息应点名 A2（实际：${deadLink.stdout}）`);

/* 改坏 7：给一个内容块默加 hidden（无 JS 不白屏 A10） */
scaffold();
writePage(readPage().replace('<section id="sec-terms">', '<section id="sec-terms" hidden>'));
const hiddenBlock = check(TMP);
ok(hiddenBlock.status === 1, `默认隐藏内容块时 check 必须 exit 1（实际 ${hiddenBlock.status}）`);
ok(/A10/.test(hiddenBlock.stdout || ''), `失败信息应点名 A10（实际：${hiddenBlock.stdout}）`);

/* ---------------------------------------------------------------- 汇总 */
if (fails.length) {
  console.error(`\n✗ ${fails.length} 项失败（通过 ${pass} 项）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`共 ${pass} 项断言，全部通过`);
