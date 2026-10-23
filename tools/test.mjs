#!/usr/bin/env node
/* ============================================================================
   仓库统一入口：把「逻辑套件 + 静态校验」一次跑完。

     node tools/test.mjs                    # 默认：跑克隆仓库就能跑的（CI 也是这条）
     node tools/test.mjs --all              # 连需要本地密钥/源材料的也一起跑（缺的会报 ✗）
     node tools/test.mjs --exam-pass <口令>  # 额外跑 test_lock.js（需要当前真题口令）
     node tools/test.mjs --only area        # 只跑名字/文件名含 "area" 的
     node tools/test.mjs --list             # 只看清单，不执行

   设计约定（retro 2026-10-15 第 1 条）：
   · 默认**只跑克隆仓库也能跑的东西** —— 需要 .scratch/ 里源材料（ECDICT、真题明文/
     密钥/口令）的套件与校验一律 SKIP 并打印原因，不伪装成通过、也不算失败。
   · 加 --all 则把它们也跑起来（本地全量验收用），此时缺依赖会真报 ✗。
   · 退出码：任一实跑的项失败 → 1。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const ALL = has('--all');
const LIST = has('--list');
const ONLY = opt('--only');
const EXAM_PASS = opt('--exam-pass');
const QUIET = !has('--verbose');

const c = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

/* ---------------------------------------------------------------- 依赖探测 */
const SCRATCH = path.join(ROOT, '.scratch');
const ECDICT = path.join(SCRATCH, 'en-module', 'research', 'ecdict.csv');
const DEK = process.env.EXAM_DEK_FILE || path.join(SCRATCH, 'jlpt-exam', 'enc-keys', 'dek.b64');
const EXAM_DATA = path.join(ROOT, 'exam', 'data', 'N2');

/* pi 更新履历报告要找本机的 pi 包：委托给生成器的 probe 子命令，免得两处各写一套探测逻辑 */
function probePiChangelog() {
  const r = spawnSync(process.execPath, ['tools/pi-changelog-gen.mjs', 'probe'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  return r.status === 0;
}

const DEP = {
  ecdict: { ok: fs.existsSync(ECDICT),
    why: '缺 .scratch/en-module/research/ecdict.csv（见 en/README 的「数据来源」）' },
  dek: { ok: fs.existsSync(DEK),
    why: '缺 .scratch/jlpt-exam/enc-keys/dek.b64（node tools/encrypt-exam.mjs gen-key）' },
  pass: { ok: !!EXAM_PASS, why: '需要当前真题口令：--exam-pass <口令>' },
  plain: { ok: fs.existsSync(EXAM_DATA) && fs.readdirSync(EXAM_DATA).some((f) => /^\d{4}-\d{2}\.js$/.test(f)),
    why: '缺 exam/data/N2/2010-07.js 之类的明文卷（须在 exam/ 里跑 node gen-exam-data.js 生成）' },
  pi: { ok: probePiChangelog(),
    why: '本机没装 pi（找不到 @earendil-works/pi-coding-agent/CHANGELOG.md；可用 PI_CHANGELOG=<路径> 指定）' },
};

/* ---------------------------------------------------------------- 清单 */
/* needs: 依赖键数组；只列实跑所需的（skip 时逐条打印原因） */
const SUITES = [
  { f: 'tools/tests/test_area.js',           name: '工作台区状态机',        needs: [] },
  { f: 'tools/tests/test_snooker.js',        name: '斯诺克排名解析',        needs: [] },
  { f: 'tools/tests/test_tools_dev.js',     name: '工具开发区（生成/校验/打包）', needs: [] },
  { f: 'tools/tests/test_pi_changelog.js',  name: 'pi 更新履历源探测',      needs: [] },
  { f: 'tools/tests/icon-set.js',            name: '图标集 / 品牌标记',      needs: [] },
  { f: 'tools/tests/test_progress.js',       name: '进度脚本',              needs: [] },
  { f: 'tools/tests/test_reading.js',        name: '阅读页',                needs: [] },
  { f: 'tools/tests/test_unit.js',           name: '词表单元页',            needs: [] },
  { f: 'tools/tests/test_dictation.js',      name: '听写（英语）',          needs: [] },
  { f: 'tools/tests/test_dictation_en.js',   name: '听写生成物',            needs: [] },
  { f: 'tools/tests/test_typing_en.js',      name: '搭配 / 打字（英语）',   needs: [] },
  { f: 'tools/tests/test_integration_en.js', name: '英语侧集成',            needs: [] },
  { f: 'tools/tests/test_typing_smoke.js',   name: '打字练习冒烟',          needs: [] },
  { f: 'tools/tests/test_lazy.js',           name: '真题按需加载',          needs: ['dek'] },
  { f: 'tools/tests/test_back.js',           name: '真题返回路径',          needs: ['dek'] },
  { f: 'tools/tests/test_back2.js',          name: '题型专练返回路径',      needs: ['dek'] },
  { f: 'tools/tests/test_back3.js',          name: '复盘返回 / 再考一次',   needs: ['dek'] },
  { f: 'tools/tests/test_newexams.js',       name: '新卷挂载',              needs: ['dek'] },
  { f: 'tools/tests/test_lock.js',           name: '加解密往返',            needs: ['dek', 'pass'], args: () => [EXAM_PASS] },
];

/* 静态守卫：仓库的硬约束里能用几十行代码钉住的那几条 */
function guardNoFetch() {
  /* file:// 优先：数据加载必须内联 / 相对 <script src>，不得走 fetch / XHR。
     dictation/dictation.js 的 fetch 指向本机 VOICEVOX HTTP API，是已知例外。 */
  const ALLOW = new Set(['dictation/dictation.js']);
  /* research/ 下的报告是引用他人文本的成品：pi 更新履历里就贴着 `await fetch(catalogUrl)`
     这种上游代码样例，扫它会因为「如实引用」而假失败。报告本身自包含（research.mjs check
     保证无外链 css/js），不靠 fetch 取数。 */
  const EXTS = ['.html', '.js'];
  /* 工具本体（tools-dev/data.json 里的 dir）是下载到别处去跑的东西，不是本站用 file://
     打开的页面：wb2api 的面板 app.js 走 HTTP，fetch 天经地义。只扫站点自己的 html/js。 */
  const toolDirs = (() => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-dev/data.json'), 'utf8'));
      return (d.tools || [])
        .map((t) => t.dir && t.dir.replace(/^\.\.[\\/]/, '').split(/[\\/]/).join('/'))
        .filter(Boolean);
    } catch { return []; }
  })();
  const inToolDir = (f) => toolDirs.some((d) => f === d || f.startsWith(d + '/'));
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0').filter(Boolean)
    .filter((f) => EXTS.some((e) => f.endsWith(e)) && !ALLOW.has(f) && !/^research\//.test(f) && !inToolDir(f));
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|<!--)/.test(line)) return;                    // 注释不算
      if (/\b(fetch|XMLHttpRequest)\s*\(/.test(line) || /new\s+XMLHttpRequest/.test(line)) {
        bad.push(`${f}:${i + 1}`);
      }
    });
  }
  if (bad.length) throw new Error('file:// 下会被拦的取数调用：' + bad.join('、'));
  return `扫了 ${files.length} 个 html/js，无 fetch/XHR`;
}

/* 静态校验：与套件同样对待，缺依赖就 SKIP */
const CHECKS = [
  { fn: guardNoFetch, name: 'file:// 硬约束（无 fetch/XHR）', needs: [] },
  { cmd: ['node', 'tools/rail.mjs', 'check'], name: '左栏一致性（全站）', needs: [] },
  { cmd: ['node', 'tools/portal.mjs', 'check'], name: '门户进度分母', needs: [] },
  { cmd: ['node', 'tools/tests/contrast-and-tokens.js'], name: '三主题对比度 + 裸色值', needs: [] },
  { cmd: ['node', 'tools/research.mjs', 'check'], name: '调查报告清单自洽',   needs: [] },
  { cmd: ['node', 'tools/tools.mjs', 'check'], name: '工具开发清单自洽',   needs: [] },
  { cmd: ['node', 'tools/pi-changelog-gen.mjs', 'check'], name: 'pi 更新履历报告', needs: ['pi'] },
  { cmd: ['node', 'tools/check-exam-data.js'],    name: '真题全库审计',       needs: ['plain'] },
  { cmd: ['node', 'jp-vocab/gen.js', 'check'], name: '课堂单词数据',         needs: [] },
  { cmd: ['node', 'tools/en-accept.mjs'],         name: '英语侧整合验收',     needs: ['ecdict'] },
  { cmd: ['node', 'tools/en-typing.mjs', 'check'], name: '英语搭配清单',      needs: [] },
  { cmd: ['node', 'tools/listening-handout.mjs'], name: '听力注音讲义齐套',    needs: [] },
  { cmd: ['node', 'tools/jp-reading.mjs', 'check'], name: '日语阅读（真源 ≡ 生成物）', needs: [] },
];

/* ---------------------------------------------------------------- 执行 */
function run(cmd, args = []) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
function countAssertions(out) {
  const pats = [/全部通过\s*[（(:：]\s*(\d+)/, /共\s*(\d+)\s*项/, /(\d+)\s*项断言/, /通过\s*(\d+)\s*项/];
  for (const p of pats) { const m = out.match(p); if (m) return +m[1]; }
  const ticks = (out.match(/✓/g) || []).length;
  return ticks || null;
}
const matches = (s) => !ONLY || s.toLowerCase().includes(ONLY.toLowerCase());

const results = [];
let passN = 0, failN = 0, skipN = 0, asserts = 0;

function skipped(label, needs) {
  const why = needs.map((k) => DEP[k].why).filter(Boolean);
  console.log(`  ${c.y}–${c.x} ${label}  ${c.d}SKIP：${why.join('；')}${c.x}`);
  results.push({ label, state: 'skip' });
  skipN++;
}
function done(label, ok, out, ms) {
  const n = countAssertions(out);
  if (ok) { passN++; if (n) asserts += n; }
  else failN++;
  const mark = ok ? `${c.g}✓${c.x}` : `${c.r}✗${c.x}`;
  console.log(`  ${mark} ${label}${n ? `  ${c.d}${n} 项${c.x}` : ''}  ${c.d}${ms}ms${c.x}`);
  results.push({ label, state: ok ? 'pass' : 'fail', out });
}

/* 套件 */
console.log(`${c.b}■ 逻辑套件${c.x} ${c.d}(${SUITES.length} 个)${c.x}`);
for (const s of SUITES) {
  if (!matches(s.f) && !matches(s.name)) continue;
  if (LIST) { console.log(`  · ${s.f}  ${s.name}`); continue; }
  const missing = s.needs.filter((k) => !DEP[k].ok);
  if (missing.length && !ALL) { skipped(`${s.name}  ${c.d}${s.f}${c.x}`, missing); continue; }
  if (missing.length) { skipped(`${s.name}  ${c.d}${s.f}${c.x}`, missing); continue; }
  const t0 = Date.now();
  const r = run('node', [s.f, ...(s.args ? s.args() : [])]);
  done(`${s.name}  ${c.d}${s.f}${c.x}`, r.code === 0, r.out, Date.now() - t0);
  if (r.code !== 0 && !QUIET) console.log(c.d + r.out.split('\n').slice(-12).join('\n') + c.x);
}

/* 静态校验 */
console.log(`\n${c.b}■ 静态校验${c.x} ${c.d}(${CHECKS.length} 个)${c.x}`);
for (const k of CHECKS) {
  if (!matches(k.name) && !(k.cmd && matches(k.cmd.join(' ')))) continue;
  if (LIST) { console.log(`  · ${k.fn ? '内置守卫' : k.cmd.join(' ')}  ${k.name}`); continue; }
  const label0 = `${k.name}  ${c.d}${k.fn ? '内置守卫' : k.cmd.join(' ')}${c.x}`;
  const missing = k.needs.filter((n) => !DEP[n].ok);
  if (missing.length) { skipped(label0, missing); continue; }
  const t0 = Date.now();
  const r = k.fn
    ? (() => { try { return { code: 0, out: String(k.fn()) }; } catch (e) { return { code: 1, out: String(e.message) }; } })()
    : run(k.cmd[0], k.cmd.slice(1));
  done(label0, r.code === 0, r.out, Date.now() - t0);
  if (r.code !== 0 && !QUIET) console.log(c.d + r.out.split('\n').slice(-12).join('\n') + c.x);
}

if (LIST) process.exit(0);

/* 汇总 */
const total = passN + failN + skipN;
console.log(`\n${c.b}汇总${c.x}：${passN} 通过 · ${failN} 失败 · ${skipN} 跳过（共 ${total} 项）` +
  (asserts ? ` · ${asserts} 项断言` : ''));
if (skipN) {
  console.log(`${c.d}跳过的项需要本地材料（.scratch/ 不入库）；本地全量验收：node tools/test.mjs --all${c.x}`);
}
if (failN) {
  console.log(`\n${c.r}失败的项：${c.x}`);
  for (const r of results.filter((r) => r.state === 'fail')) console.log(`  ✗ ${r.label}`);
}
process.exit(failN ? 1 : 0);
