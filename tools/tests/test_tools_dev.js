/* 「工具开发」区的生成 / 校验 / 打包测试。
   跑法：node tools/tests/test_tools_dev.js
   三段：
     1. 真仓库：check 通过、gen 幂等（跑两次内容不变）、下载包能解开且与 manifest 的 sha256 一一对上；
     2. 沙箱：把 tools/tools.mjs + 一个假工具树复制到临时目录，验证 check 会**真的失败**
        （改了源码没重新 pack / 版本不一致 / 缺详情页）。没有这一段，check 可能是个永远返回 0 的空壳；
     3. data.json 与 index.html 的对应关系（清单里的每个 download 链接都指向真实文件）。
   'use strict';
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const run = (args, cwd) =>
  spawnSync(process.execPath, args, { cwd: cwd || ROOT, encoding: 'utf8', timeout: 120000 });

/* ---------------- zip 读回（store-only，不带压缩，逐条比内容） ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function unzip(buf) {
  const out = [];
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extraLen;
    out.push({ name, crc, data: buf.slice(start, start + size) });
    p = start + size;
  }
  return out;
}

/* ---------------- 1. 真仓库 ---------------- */
{
  const r = run(['tools/tools.mjs', 'check']);
  ok(r.status === 0, `真仓库 node tools/tools.mjs check 应当通过：${(r.stdout || r.stderr).trim()}`);
}

{
  const idx = path.join(ROOT, 'index.html');
  const before = sha256(fs.readFileSync(idx));
  const r = run(['tools/tools.mjs', 'gen']);
  ok(r.status === 0, 'gen 应当成功');
  const after = sha256(fs.readFileSync(idx));
  eq(after, before, 'gen 幂等：已是最新时不该改动 index.html');
  ok(/已是最新/.test(r.stdout), 'gen 第二次跑应当提示「已是最新」');
}

{
  /* 下载包：每个文件的内容哈希都要与 manifest 对得上，否则用户下到的是旧代码 */
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-dev', 'data.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-dev', 'downloads', 'manifest.json'), 'utf8'));
  const withZip = data.tools.filter((t) => t.download);
  ok(withZip.length > 0, '至少有一个工具带下载包');
  for (const t of withZip) {
    const rec = manifest.tools[t.id];
    ok(!!rec, `${t.id} 在 manifest 里有记录`);
    if (!rec) continue;
    eq(t.download, `downloads/${t.id}-${t.version}.zip`, `${t.id} 下载文件名带版本`);
    const abs = path.join(ROOT, 'tools-dev', t.download);
    ok(fs.existsSync(abs), `${t.id} 的 zip 文件存在`);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    eq(sha256(buf), rec.sha256, `${t.id} zip 的 sha256 与 manifest 一致`);
    const entries = unzip(buf);
    eq(entries.length, rec.files.length, `${t.id} zip 里文件数与 manifest 一致`);
    for (const e of entries) {
      eq(e.crc, crc32(e.data), `${e.name} 的 CRC32 自洽`);
      const rel = e.name.slice(t.id.length + 1);
      const hit = rec.files.find((f) => f.path === rel);
      ok(!!hit, `${e.name} 在 manifest 里登记`);
      if (hit) eq(sha256(e.data), hit.sha256, `${e.name} 内容与 manifest 的 sha256 一致`);
    }
    // 包里的源码必须能被解出来：抽一份 index.ts 之类的核心文件，长度不为 0
    const nonEmpty = entries.filter((e) => !e.name.endsWith('/') && e.data.length > 0);
    ok(nonEmpty.length > 0, `${t.id} 的 zip 不是空壳`);
  }
}

/* ---------------- 2. 沙箱：check 必须会失败 ---------------- */
function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-dev-'));
  fs.mkdirSync(path.join(tmp, 'tools', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tools-dev'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'demo'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'tools.mjs'), path.join(tmp, 'tools', 'tools.mjs'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'lib', 'eol.mjs'), path.join(tmp, 'tools', 'lib', 'eol.mjs'));
  fs.writeFileSync(
    path.join(tmp, 'index.html'),
    '<!DOCTYPE html>\n<html>\n<head>\n<style>\n</style>\n</head>\n<body>\n<main id="tool-pane">\n<!-- wb:tool-list:start -->\n<!-- wb:tool-list:end -->\n</main>\n</body>\n</html>\n',
    'utf8'
  );
  fs.writeFileSync(path.join(tmp, 'tools-dev', 'demo.html'), '<!DOCTYPE html><title>demo</title>\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'tools-dev', 'data.json'), JSON.stringify({
    tags: ['脚本'],
    tools: [{
      id: 'demo', title: '示例工具', tags: ['脚本'], status: '可用', version: '0.1.0',
      updated: '2026-10-18', summary: '用来测 gen / check / pack 的假工具。',
      page: 'demo.html', dir: '../demo', download: '',
    }],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'demo', 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'demo', 'a.txt'), 'hello\n', 'utf8');
  return tmp;
}

{
  const tmp = makeSandbox();
  const chk = (label) => {
    const r = run(['tools/tools.mjs', 'check'], tmp);
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), label };
  };

  let r = run(['tools/tools.mjs', 'pack', 'demo'], tmp);
  eq(r.status, 0, '沙箱 pack 应当成功');
  r = run(['tools/tools.mjs', 'gen'], tmp);
  eq(r.status, 0, '沙箱 gen 应当成功');

  let c = chk('');
  eq(c.code, 0, `沙箱 pack+gen 后 check 应当通过：${c.out.trim()}`);
  ok(/检查通过/.test(c.out), '沙箱 check 打印通过');

  /* 改了源码没重新打包 → 必须失败（这是 check 存在的理由） */
  fs.writeFileSync(path.join(tmp, 'demo', 'a.txt'), 'changed\n', 'utf8');
  c = chk('');
  eq(c.code, 1, '改源码不重 pack，check 必须失败');
  ok(/重新 pack/.test(c.out), `失败原因应当是「重新 pack」：${c.out.trim()}`);

  /* 重新 pack 后又应当通过 */
  r = run(['tools/tools.mjs', 'pack', 'demo'], tmp);
  eq(r.status, 0, '沙箱重新 pack 成功');
  c = chk('');
  eq(c.code, 0, '重新 pack 后 check 恢复通过');

  /* 详情页里的下载链接是手写的：指向不存在的包（升版后忘改）→ 失败 */
  const pagePath = path.join(tmp, 'tools-dev', 'demo.html');
  fs.writeFileSync(pagePath, '<!DOCTYPE html><title>demo</title>\n<a href="downloads/demo-9.9.9.zip">x</a>\n', 'utf8');
  c = chk('');
  eq(c.code, 1, '详情页下载链接指向不存在的包，check 必须失败');
  ok(/下载链接/.test(c.out), `失败原因应当提到下载链接：${c.out.trim()}`);
  fs.writeFileSync(pagePath, '<!DOCTYPE html><title>demo</title>\n<a href="downloads/demo-0.1.0.zip" download>x</a>\n', 'utf8');
  c = chk('');
  eq(c.code, 0, '下载链接正确时 check 恢复通过');

  /* data.json 与 package.json 版本不一致 → 失败 */
  fs.writeFileSync(path.join(tmp, 'demo', 'package.json'), JSON.stringify({ name: 'demo', version: '0.2.0' }, null, 2) + '\n', 'utf8');
  c = chk('');
  eq(c.code, 1, '版本与 package.json 不一致，check 必须失败');
  ok(/版本/.test(c.out), `失败原因应当提到版本：${c.out.trim()}`);
  fs.writeFileSync(path.join(tmp, 'demo', 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }, null, 2) + '\n', 'utf8');

  /* versionFrom：版本从源码常量取（Go 这类不该塞 package.json 的仓库） */
  const dj0 = path.join(tmp, 'tools-dev', 'data.json');
  const setData = (mut) => {
    const d = JSON.parse(fs.readFileSync(dj0, 'utf8'));
    mut(d.tools[0]);
    fs.writeFileSync(dj0, JSON.stringify(d, null, 2) + '\n', 'utf8');
  };
  fs.writeFileSync(path.join(tmp, 'demo', 'version.go'), 'package main\n\nconst appVersion = "0.1.0-panel"\n', 'utf8');
  setData((t) => {
    t.versionFrom = { file: 'version.go', pattern: 'appVersion = "([0-9]+\\.[0-9]+\\.[0-9]+)' };
  });
  c = chk('');
  r = run(['tools/tools.mjs', 'pack', 'demo'], tmp);
  eq(r.status, 0, `versionFrom 一致时 pack 应当成功：${(r.stdout || r.stderr).trim()}`);
  c = chk('');
  eq(c.code, 0, `versionFrom 与源码一致时 check 应当通过：${c.out.trim()}`);

  /* 源码版本变了但 data.json 没跟 → 失败（且 pack 也不许打出撒谎的包） */
  fs.writeFileSync(path.join(tmp, 'demo', 'version.go'), 'package main\n\nconst appVersion = "0.2.0-panel"\n', 'utf8');
  c = chk('');
  eq(c.code, 1, 'versionFrom 与源码不一致，check 必须失败');
  ok(/版本/.test(c.out), `失败原因应当提到版本：${c.out.trim()}`);
  r = run(['tools/tools.mjs', 'pack', 'demo'], tmp);
  eq(r.status, 1, 'versionFrom 与源码不一致，pack 必须拒绝打包');
  fs.writeFileSync(path.join(tmp, 'demo', 'version.go'), 'package main\n\nconst appVersion = "0.1.0-panel"\n', 'utf8');

  /* pattern 匹配不到（源码改了写法）→ 失败 */
  setData((t) => {
    t.versionFrom.pattern = 'version = "([0-9.]+)';
  });
  c = chk('');
  eq(c.code, 1, 'versionFrom.pattern 匹配不到，check 必须失败');
  ok(/匹配不到/.test(c.out), `失败原因应当提到匹配不到：${c.out.trim()}`);

  /* versionFrom.file 不存在 → 失败 */
  setData((t) => {
    t.versionFrom = { file: 'nope.go', pattern: 'appVersion = "([0-9.]+)' };
  });
  c = chk('');
  eq(c.code, 1, 'versionFrom.file 不存在，check 必须失败');

  /* 还原成 package.json 口径，后面的用例继续用它 */
  setData((t) => {
    delete t.versionFrom;
  });
  fs.unlinkSync(path.join(tmp, 'demo', 'version.go'));
  r = run(['tools/tools.mjs', 'pack', 'demo'], tmp);
  eq(r.status, 0, '去掉 versionFrom 后重新 pack 成功');
  c = chk('');
  eq(c.code, 0, '去掉 versionFrom 后回到 package.json 口径，check 恢复通过');

  /* 缺详情页 → 失败 */
  fs.unlinkSync(path.join(tmp, 'tools-dev', 'demo.html'));
  c = chk('');
  eq(c.code, 1, '缺详情页，check 必须失败');
  ok(/详情页/.test(c.out), `失败原因应当提到详情页：${c.out.trim()}`);

  /* 清单区被手改 → 失败 */
  fs.writeFileSync(path.join(tmp, 'tools-dev', 'demo.html'), '<!DOCTYPE html><title>demo</title>\n', 'utf8');
  const idxPath = path.join(tmp, 'index.html');
  fs.writeFileSync(idxPath, fs.readFileSync(idxPath, 'utf8').replace('示例工具', '被手改的标题'), 'utf8');
  c = chk('');
  eq(c.code, 1, '手改清单区，check 必须失败');
  ok(/不一致/.test(c.out), `失败原因应当提到不一致：${c.out.trim()}`);

  /* 非法 state 词表 → 失败 */
  const dj = path.join(tmp, 'tools-dev', 'data.json');
  const data = JSON.parse(fs.readFileSync(dj, 'utf8'));
  data.tools[0].status = '上线中';
  fs.writeFileSync(dj, JSON.stringify(data, null, 2) + '\n', 'utf8');
  c = chk('');
  eq(c.code, 1, 'status 不在词表里，check 必须失败');
  ok(/status/.test(c.out), `失败原因应当提到 status：${c.out.trim()}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---------------- 3. data.json ↔ index.html ---------------- */
{
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-dev', 'data.json'), 'utf8'));
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const region = html.slice(html.indexOf('<!-- wb:tool-list:start -->'), html.indexOf('<!-- wb:tool-list:end -->'));
  for (const t of data.tools) {
    ok(region.includes(`href="tools-dev/${t.page}"`), `${t.id} 的详情页链接写进了清单`);
    if (t.download) {
      ok(region.includes(`href="tools-dev/${t.download}"`), `${t.id} 的下载链接写进了清单`);
      ok(region.includes('download>'), `${t.id} 的下载链接带 download 属性（file:// 下直接存盘）`);
    }
    ok(region.includes(`v${t.version}`), `${t.id} 的版本号写进了清单`);
  }
  ok(!/undefined/.test(region), '清单区里没有 undefined 之类的渲染漏值');
}

/* ---------------- 4. 详情页里的本地图片都真存在 ---------------- */
{
  const pages = fs.readdirSync(path.join(ROOT, 'tools-dev')).filter((f) => f.endsWith('.html'));
  ok(pages.length > 0, '工具区至少有一个详情页');
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'tools-dev', page), 'utf8');
    const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    for (const src of imgs) {
      ok(!/^(https?:)?\/\//.test(src), `${page} 的图片不走外链（file:// 下也得能看）：${src}`);
      ok(fs.existsSync(path.join(ROOT, 'tools-dev', src)), `${page} 引的图片存在：${src}`);
    }
  }
  const shotDir = path.join(ROOT, 'tools-dev', 'shots');
  const shots = fs.existsSync(shotDir) ? fs.readdirSync(shotDir).filter((f) => f.endsWith('.png')) : [];
  ok(shots.length >= 3, `选择器截图至少三张，当前 ${shots.length} 张`);
  for (const s of shots) ok(!/\s/.test(s), `截图文件名无空格：${s}`);
}


/* ---------------- 结果 ---------------- */
console.log(fails.length ? '✗ 失败：' : '✓ 全部通过：', `${pass} 项`);
fails.forEach((f) => console.log('  · ' + f));
process.exit(fails.length ? 1 : 0);
