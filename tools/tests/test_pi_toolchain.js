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
}
const pageIn = () => path.join(TMP, 'tools-dev', 'pi-toolchain.html');
const readPage = () => fs.readFileSync(pageIn(), 'utf8');
const writePage = (s) => fs.writeFileSync(pageIn(), s);

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

/* 改坏 5：改掉版本表里的一行（版本表一致 A9） */
scaffold();
writePage(readPage().replace(/data-ver="6\.0\.0"/, 'data-ver="9.9.9"'));
const drift = check(TMP);
ok(drift.status === 1, `版本表被改后 check 必须 exit 1（实际 ${drift.status}）`);
ok(/A9|不一致/.test(drift.stdout || ''), `失败信息应点名版本不一致（实际：${drift.stdout}）`);

/* ---------------------------------------------------------------- 汇总 */
if (fails.length) {
  console.error(`\n✗ ${fails.length} 项失败（通过 ${pass} 项）：`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`共 ${pass} 项断言，全部通过`);
