#!/usr/bin/env node
/* ============================================================================
   英语侧整合验收（票 09）

     node tools/en-accept.mjs            # 只校验：107 项、门户清单双向、死链、file:// 安全、许可与台账
     node tools/en-accept.mjs --gen      # 先跑三个生成器，再校验，并核对「再跑一次字节一致」
     node tools/en-accept.mjs --from-zero --gen   # 更狠：先把生成物挪走，从零重新产出再比对
     node tools/en-accept.mjs --src <ecdict.csv>  # 透传给 en-vocab / en-reading

   校验不依赖 .scratch/（测试缝与源材料都不在仓库里）：除 --gen 外，克隆仓库即可跑。
   --gen 需要两个源：ECDICT 的 ecdict.csv、Project Gutenberg 的缓存（见各 README）。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANDS = ['1k', '2k', '3k', '4k'];
const UNIT_COUNT = 77;
const READING_COUNT = 30;
const TOTAL = UNIT_COUNT + READING_COUNT;   // 107

const argv = process.argv.slice(2);
const DO_GEN = argv.includes('--gen');
const FROM_ZERO = argv.includes('--from-zero');
const SRC = (() => { const i = argv.indexOf('--src'); return i >= 0 ? argv[i + 1] : null; })();

let pass = 0;
const fails = [];
function check(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? '  ::  ' + extra : '')); console.log('  ✗ ' + name + (extra ? '  ::  ' + extra : '')); }
}
function head(t) { console.log('\n■ ' + t); }
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(path.join(ROOT, ...p.split('/')), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, ...p.split('/')));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, ...p.split('/')))).digest('hex').slice(0, 16);

/* 生成物与门户（「再跑一次字节一致」的比对范围） */
function generatedFiles() {
  const out = ['index.html', 'en/data/vocab.js', 'en/typing/phrases.js', 'en/reading/index.html'];
  for (const b of BANDS) for (const f of fs.readdirSync(path.join(ROOT, 'en', b))) {
    if (f.endsWith('.html')) out.push(`en/${b}/${f}`);
  }
  for (const b of BANDS) for (const f of fs.readdirSync(path.join(ROOT, 'en/reading', b))) {
    if (f.endsWith('.html')) out.push(`en/reading/${b}/${f}`);
  }
  return out;
}
function snapshot(files) {
  const h = {};
  for (const f of files) h[f] = sha(f);
  return h;
}
function runNode(script, args, label) {
  const cmd = ['node', path.join('tools', script), ...args];
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    return { ok: false, out: String((e.stdout || '') + (e.stderr || '')).trim() };
  }
}

/* ---------------------------------------------------------------- ① 生成管线 */
head('① 生成管线：词表 / 阅读 / 固定搭配');
const srcArgs = SRC ? ['--src', SRC] : [];

if (DO_GEN) {
  let backup = null;
  if (FROM_ZERO) {
    const files = generatedFiles();
    backup = { dir: fs.mkdtempSync(path.join(ROOT, '.en-accept-')), files };
    for (const f of files) {
      const dst = path.join(backup.dir, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, ...f.split('/')), dst);
    }
    for (const f of files) { if (f !== 'index.html') fs.rmSync(path.join(ROOT, ...f.split('/'))); }
    console.log('  · 生成物已挪到 ' + rel(backup.dir) + '（校验失败会自动还原）');
  }
  const gens = [
    ['en-vocab.mjs', [...srcArgs, 'gen'], '词表'],
    ['en-reading.mjs', [...srcArgs, 'gen'], '阅读'],
    ['en-typing.mjs', ['gen'], '搭配']
  ];
  let genOk = true;
  for (const [script, args, label] of gens) {
    const r = runNode(script, args, label);
    if (r.ok) { pass++; console.log(`  ✓ ${label}生成（${script}）`); }
    else { genOk = false; fails.push(`${label}生成失败`); console.log(`  ✗ ${label}生成失败  ::  ${r.out.split('\n').slice(-3).join(' / ')}`); }
  }
  if (genOk && backup) {
    /* 从零跑通：产出必须与挪走的那份逐字节一致 */
    const now = snapshot(backup.files);
    const before = snapshot(backup.files.filter((f) => fs.existsSync(path.join(backup.dir, ...f.split('/')))));
    const diff = Object.keys(before).filter((f) => now[f] !== before[f]);
    check(diff.length === 0, `从零重新产出 ${backup.files.length} 个生成物，与原文件逐字节一致`,
      diff.length ? diff.slice(0, 5).join(', ') + ' 等 ' + diff.length + ' 个不同' : '');
    if (diff.length) {
      for (const f of diff) fs.copyFileSync(path.join(backup.dir, ...f.split('/')), path.join(ROOT, ...f.split('/')));
      console.log('  · 已从备份还原不同的文件（避免把差异留在工作区）');
    }
    fs.rmSync(backup.dir, { recursive: true, force: true });
  }
  if (genOk) {
    const files = generatedFiles();
    const first = snapshot(files);
    for (const [script, args] of [['en-vocab.mjs', [...srcArgs, 'gen']], ['en-reading.mjs', [...srcArgs, 'gen']], ['en-typing.mjs', ['gen']]]) {
      runNode(script, args, script);
    }
    const second = snapshot(files);
    const diff = files.filter((f) => first[f] !== second[f]);
    check(diff.length === 0, '再跑一次生成，字节一致（幂等）', diff.slice(0, 5).join(', '));
  }
} else {
  console.log('  · 跳过生成（加 --gen 可重跑管线）');
}

for (const [script, args, label] of [
  ['en-vocab.mjs', [...srcArgs, 'check'], '词表'],
  ['en-reading.mjs', [...srcArgs, 'check'], '阅读'],
  ['en-typing.mjs', ['check'], '搭配']
]) {
  const r = runNode(script, args, label);
  check(r.ok, `${label} check 退出码 0（清单与文件双向、口径、幂等）`, r.ok ? '' : r.out.split('\n').slice(-3).join(' / '));
}

/* ---------------------------------------------------------------- ② 107 项 */
head(`② 全部 ${TOTAL} 项都在（${UNIT_COUNT} 个词表单元 + ${READING_COUNT} 篇阅读）`);
const unitPages = [];
for (const b of BANDS) {
  const files = fs.readdirSync(path.join(ROOT, 'en', b)).filter((f) => f.endsWith('.html')).sort();
  for (const f of files) unitPages.push(`en/${b}/${f}`);
}
const readPages = [];
for (const b of BANDS) {
  const files = fs.readdirSync(path.join(ROOT, 'en/reading', b)).filter((f) => f.endsWith('.html')).sort();
  for (const f of files) readPages.push(`en/reading/${b}/${f}`);
}
check(unitPages.length === UNIT_COUNT, `词表单元页 ${UNIT_COUNT} 个`, '实际 ' + unitPages.length);
check(readPages.length === READING_COUNT, `阅读页 ${READING_COUNT} 篇`, '实际 ' + readPages.length);
check(unitPages.length + readPages.length === TOTAL, `合计 ${TOTAL} 项`);

/* ---------------------------------------------------------------- ③ 门户清单双向 */
head('③ 门户与篇目页的清单 ≡ 实际文件（双向，无孤儿页、无死链）');
function keysOfHtml(pathInRepo) {
  const text = read(pathInRepo);
  const keys = [];
  const re = /data-en-key="([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) keys.push(m[1]);
  return keys;
}
const expected = [...unitPages, ...readPages].sort();
const portalKeys = keysOfHtml('index.html');
const portalUniq = [...new Set(portalKeys)].sort();
check(portalUniq.length === portalKeys.length, '门户没有重复的 data-en-key', portalKeys.length + ' → ' + portalUniq.length);
const missing = expected.filter((k) => portalUniq.indexOf(k) < 0);
const orphan = portalUniq.filter((k) => expected.indexOf(k) < 0);
check(missing.length === 0, `门户列全了 ${TOTAL} 项（无遗漏）`, missing.slice(0, 5).join(', '));
check(orphan.length === 0, '门户没有指向不存在文件的条目（无孤儿）', orphan.slice(0, 5).join(', '));
check(portalUniq.length === TOTAL, `门户分母 = ${TOTAL}`);

const listKeys = [...new Set(keysOfHtml('en/reading/index.html'))].sort();
check(listKeys.length === READING_COUNT && listKeys.every((k, i) => k === [...readPages].sort()[i]),
  `阅读篇目页列全了 ${READING_COUNT} 篇且与实际文件一致`);
check(portalKeys.every((k) => !/\/(?:dictation|typing)\//.test(k)), '听写与打字不计入 107（各自管自己的成绩）');

/* ---------------------------------------------------------------- ④ 死链 */
head('④ 静态链接扫描：英语侧页面 + 门户的每个本地 href / src 都要存在');
const htmlFiles = ['index.html', ...unitPages, ...readPages, 'en/reading/index.html', 'en/dictation/index.html', 'en/typing/index.html'];
const dead = [];
for (const f of htmlFiles) {
  const text = read(f);
  const dir = path.posix.dirname(f);
  const re = /(?:href|src)="([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;   // http(s): data: mailto: //host #frag
    const clean = raw.split('#')[0].split('?')[0];
    if (!clean) continue;
    const target = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : dir + '/' + clean);
    if (!fs.existsSync(path.join(ROOT, ...target.split('/')))) dead.push(`${f} → ${raw}`);
  }
}
check(dead.length === 0, `${htmlFiles.length} 个页面的本地链接全部可达`, dead.slice(0, 6).join(' | '));

/* ---------------------------------------------------------------- ⑤ file:// 安全 */
head('⑤ file:// 硬约束：不许 fetch、不许 ES module、数据一律 <script> 注入');
const logicFiles = ['en/unit.js', 'en/reader.js', 'en/dictation/cfg.js', 'en/dictation/lists.js',
  'en/typing/cfg.js', 'en/typing/words.js'];
const dataFiles = ['en/data/vocab.js', 'en/typing/phrases.js'];   // 英文散文，只查注入标记
const unsafe = [];
for (const f of [...htmlFiles, ...logicFiles]) {
  const text = read(f);
  if (/\bfetch\s*\(/.test(text)) unsafe.push(f + ' 用了 fetch()');
  if (/type="module"/.test(text)) unsafe.push(f + ' 用了 type="module"');
  if (/^\s*import\s+\S/m.test(text)) unsafe.push(f + ' 用了 import 语句');
  if (/\brequire\s*\(/.test(text)) unsafe.push(f + ' 用了 require()');
}
check(unsafe.length === 0, '没有 fetch / module / import / require', unsafe.slice(0, 5).join(' | '));
check(/window\.EN_VOCAB\s*=/.test(read('en/data/vocab.js')), '词表以 window.EN_VOCAB 注入');
check(/window\.EN_TYPING_PHRASES\s*=/.test(read('en/typing/phrases.js')), '搭配以 window.EN_TYPING_PHRASES 注入');
check(/window\.EN_UNIT\s*=/.test(read(unitPages[0])), '词表单元页内联 window.EN_UNIT');
check(/window\.EN_ARTICLE\s*=/.test(read(readPages[0])), '阅读页内联 window.EN_ARTICLE');
check(dataFiles.every((f) => /^window\.[A-Z_]+\s*=/m.test(read(f))),
  '数据文件都是一句 window.X = {…}（代码模式扫描不覆盖它们）');

/* ---------------------------------------------------------------- ⑥ 许可与台账 */
head('⑥ 许可声明与台账（数据不入库，README 写清来源）');
const readme = read('README.md');
check(/sha256/.test(readme) && /1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf/.test(read('en/data/README.md')),
  'ECDICT 的校验和写在台账里');
check(/skywind3000\/ECDICT/.test(readme) && /MIT/.test(readme), 'README 标了来源与 MIT 许可');
check(/CC BY-NC 4\.0/.test(readme), '站点许可仍是 CC BY-NC 4.0');
check(/gutenberg\.org/.test(readme), 'README 标了 Project Gutenberg 来源');
check(/www\.gutenberg\.org/.test(read('en/reading/README.md')), '阅读台账标了来源');
for (const f of ['en/data/README.md', 'en/reading/README.md', 'en/typing/README.md']) {
  check(exists(f), `台账存在：${f}`);
}
check(/ECDICT/.test(read('en/typing/README.md')) && /Gutenberg/.test(read('en/typing/README.md')),
  '打字台账写清词源与搭配语料来源');

/* 克隆者不该因为英语侧多背几十 MB：源数据、测试与中间产物一律不进仓库 */
function biggestIn(dir) {
  let best = { size: 0, file: '' };
  for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = dir + '/' + f.name;
    if (f.isDirectory()) { const b = biggestIn(p); if (b.size > best.size) best = b; }
    else { const s = fs.statSync(path.join(ROOT, ...p.split('/'))).size; if (s > best.size) best = { size: s, file: p }; }
  }
  return best;
}
const big = biggestIn('en');
check(big.size < 2 * 1024 * 1024, `en/ 下最大的文件不到 2 MB（生成物 ${(big.size / 1024).toFixed(0)} KB：${big.file}）`);
check(/\.scratch\//.test(read('.gitignore')), '.gitignore 排除 .scratch/（源数据与测试留在工作区）');
check(!exists('en/data/ecdict.csv') && !exists('en/data/vocab-src.csv'), 'ECDICT 源文件不在仓库里');

/* ---------------------------------------------------------------- 汇总 */
console.log('\n' + (fails.length ? '✗ 未通过 ' + fails.length + ' 项（通过 ' + pass + '）' : `✓ 整合验收全部通过（${pass} 项）`));
if (fails.length) {
  for (const f of fails) console.log('  · ' + f);
  process.exitCode = 1;
}
