/* ============================================================
   图标集 / 个人品牌标记 · 静态回归
   运行：node tools/tests/icon-set.js   （失败退出码 1）

   为什么有这个套件（2026-10-15 那轮「线描图标 + 品牌标记 QY」改造）：
   · 图标一律走 CSS mask + data URI（仓库既定标准），而 mask 写坏了浏览器**不报错**——
     `--ic-*` 裸写在顶层 → 整段静默丢弃 → 图标全空白、控制台一声不吭。踩过一次。
   · 13 处 emoji / 文字符号要全换掉，换漏了没人看得见（emoji 能渲染，页面照常「正常」）。
   · 改 JS 模板里的标记时踩过真事故：`class='im im-play'` 写在单引号字符串里 →
     整个脚本 SyntaxError → 单元页白屏，而当时的套件全绿。故这里顺带做全仓语法普查。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/* ---------- 断言工具 ---------- */
let failed = 0, total = 0;
function ok(cond, name, extra) {
  total++;
  if (cond) console.log('  PASS  ' + name);
  else { failed++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  → ' + extra)); }
}
function section(t) { console.log('\n# ' + t); }

/* ---------- 待扫文件表（git 跟踪 + 未入库的新文件，排除数据、.scratch 与测试源码） ----------
   为什么排除 tools/tests/：本文件自己就写着禁用符号的字面量与 `<span class="im …>`
   正则，一旦它被 git 跟踪（本套件入库那次），普查就会扫到自己而自报失败。
   测试源码不是 UI。
   为什么带 --others：只扫 tracked 时，新写的文件在 `git add` 前对哨兵是隐形的 ——
   本地「全绿」、提交后 CI 才红（2026-10-15 真踩过：提交报告后两个守卫同时报假失败）。 */
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const isUI = (f) => !/^\.scratch\//.test(f) && !/node_modules\//.test(f) && !/(^|\/)data\//.test(f)
  && !/^tools\/tests\//.test(f)
  // research/ 下的报告是**引用他人文本**的成品（pi / 技能更新履历里就写着 ⏸、🎯 这些字符），
  // 不是我们自己的图标集；扫它会因为「如实引用」而假失败。
  && !/^research\//.test(f)
  && /\.(html|js|mjs|css|json)$/.test(f);
const UI = tracked.filter(isUI);

/* ============================ 1. 禁用符号普查 ============================ */
section('1. 禁用符号（换掉的那批 emoji / 文字符号）不得复辟');
const BANNED = ['\u{1F3AF}', '\u{1F4C4}', '\u{1F5C2}', '\u{26A1}', '\u{23F8}', '\u{27F2}', '\u{2699}', '\u{1F389}', '\u25B6'];
const nameOf = { '\u{1F3AF}': '🎯 靶心', '\u{1F4C4}': '📄 文件', '\u{1F5C2}': '🗂 夹子', '\u{26A1}': '⚡ 闪电', '\u{23F8}': '⏸ 暂停', '\u{27F2}': '⟲ 重播', '\u{2699}': '⚙ 齿轮', '\u{1F389}': '🎉 彩带', '\u25B6': '▶ 三角' };
let bannedHits = 0;
for (const f of UI) {
  const src = read(f);
  for (const ch of BANNED) {
    if (src.includes(ch)) {
      bannedHits++;
      const line = src.split('\n').findIndex((l) => l.includes(ch)) + 1;
      console.log(`        ${f}:${line} 还有 ${nameOf[ch]}`);
    }
  }
}
ok(bannedHits === 0, `UI 源里没有禁用符号（扫了 ${UI.length} 个文件）`, bannedHits ? `${bannedHits} 处残留` : '');
ok(!/[\u{1F300}-\u{1FAFF}]/u.test(read('assets/style.css')), 'assets/style.css 里没有 emoji');

/* ============================ 2. .im-* 用法 ↔ 定义 ============================ */
section('2. 每个用到的 .im-* 都在 assets/style.css 里有定义（mask 写坏是静默失败）');
const CSS = read('assets/style.css');
const ICON_BLOCK = (() => {
  const a = CSS.indexOf('/* ====================== 线描图标集');
  const b = CSS.indexOf('/* ====================== /线描图标集');
  return a >= 0 && b > a ? CSS.slice(a, b) : '';
})();
ok(ICON_BLOCK.length > 0, 'assets/style.css 里有「线描图标集」标记区');

const USED = new Map();   // name → 首个出现位置（file:line）
for (const f of UI) {
  const lines = read(f).split('\n');
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/class\s*=\s*["']im ([a-z- ]+)["']/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (/^im-[a-z]+$/.test(cls) && !USED.has(cls)) USED.set(cls, `${f}:${i + 1}`);
      }
    }
  });
}
ok(USED.size > 0, `扫到 .im-* 用法（${USED.size} 个不同图标）`);
for (const [cls, where] of USED) {
  const name = cls.slice(3);
  ok(ICON_BLOCK.includes(`.${cls} {`) || ICON_BLOCK.includes(`.${cls}{`),
    `.${cls} 有样式定义（用在 ${where}）`);
  ok(ICON_BLOCK.includes(`--ic-${name}:`), `.${cls} 对应的 --ic-${name} 变量存在`);
}

/* ---------- data URI 必须真的编码过、且能解出合法 SVG ---------- */
section('3. data URI 编码正确、能解出合法 SVG');
const VARS = [...ICON_BLOCK.matchAll(/(--ic-[a-z]+):\s*url\("(data:image\/svg\+xml,)([^"]+)"\)/g)];
ok(VARS.length >= 10, `--ic-* 变量解析出 ${VARS.length} 条`);
for (const [, varName, prefix, payload] of VARS) {
  const rawBad = /[<>#"]/.test(payload);
  let svg = '';
  try { svg = decodeURIComponent(payload); } catch (e) { /* 下面断言会报 */ }
  ok(!rawBad, `${varName} 的 payload 没有裸 <>#" `);
  ok(/^%3Csvg/.test(payload) && /%3C\/svg%3E$/.test(payload), `${varName} 是首尾完整的 svg`);
  ok(/^<svg[\s>]/.test(svg) && svg.endsWith('</svg>'), `${varName} 解码后是 <svg>…</svg>`);
}

/* ---------- --ic-* 不许裸写在顶层（整段会被静默丢弃） ---------- */
section('4. --ic-* 必须写在选择器块里（裸声明 → 浏览器整段丢弃、图标全空白）');
{
  const lines = ICON_BLOCK.split('\n');
  let lastReal = '';
  let bare = 0;
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('⚠')) continue;
    if (/^--ic-[\w-]+\s*:/.test(t)) {
      if (!lastReal.endsWith('{')) { bare++; console.log(`        裸声明：${t.slice(0, 40)}…（上一行是 ${JSON.stringify(lastReal.slice(0, 40))}）`); }
      continue;
    }
    lastReal = t;
  }
  ok(bare === 0, '--ic-* 全部在 `:root { … }` 之类的块内');
}

/* ============================ 5. .im 基类 ============================ */
section('5. .im 基类：尺寸可参数化、颜色跟随 currentColor');
ok(/\.im \{[^}]*width:\s*var\(--im-size/.test(ICON_BLOCK), '.im 宽度走 var(--im-size)（不写死 px）');
ok(/\.im \{[^}]*height:\s*var\(--im-size/.test(ICON_BLOCK), '.im 高度走 var(--im-size)');
ok(/\.im \{[^}]*background:\s*currentColor/.test(ICON_BLOCK), '.im 颜色来自 currentColor（跟着主题走）');
ok(/\.im \{[^}]*mask:\s*var\(--ic\)/.test(ICON_BLOCK), '.im 用 mask + var(--ic) 成像（不是字库图标）');

/* ============================ 6. 标记必须 aria-hidden ============================ */
section('6. 每个 .im 标记都带 aria-hidden（装饰性图形，不该被读屏念出来）');
{
  let miss = 0, seen = 0;
  for (const f of UI) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/<span class="im [^>]*>/g)) {
        seen++;
        if (!/aria-hidden=/.test(m[0])) { miss++; console.log(`        ${f}:${i + 1} 缺 aria-hidden → ${m[0]}`); }
      }
    });
  }
  ok(seen > 0, `扫到 ${seen} 个 .im 标记`);
  ok(miss === 0, '所有 .im 标记都标了 aria-hidden');
}

/* ============================ 7. 品牌标记四处同源 ============================ */
section('7. 品牌标记（QY）四处同源：门户 / favicon / 报告外壳 / 英语侧生成页');
const INDEX = read('index.html');
const FAVICON_URI = (() => {
  const fav = INDEX.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)">/);
  ok(!!fav, 'index.html 有 favicon data URI');
  return fav ? fav[1] : null;
})();
{
  const m = INDEX.match(/<span class="portal-brand-mark"[^>]*>([^<]*)</);
  ok(!!m, 'index.html 里有 .portal-brand-mark');
  ok(m && m[1] === 'QY', '门户头部标记是 QY', m ? `实为 ${JSON.stringify(m[1])}` : '');
  ok(!!FAVICON_URI && decodeURIComponent(FAVICON_URI).includes('>QY<'), 'favicon 里画的也是 QY');
  ok(!!FAVICON_URI && /Georgia/.test(decodeURIComponent(FAVICON_URI)), 'favicon 用拉丁衬线栈（两字母要塞进 32 视框）');

  /* --- 7b. favicon：全仓 111 个页面画的是同一个字 ---
     英语侧的 109 份页面由 tools/en-vocab.mjs / en-reading.mjs 生成，favicon 常量
     曾经抄成两份、改标记时漏改 → 110 个页面集体停在旧「語」（2026-10-15 发现）。
     现在常量收在 tools/brand.mjs，这里逐字节比对兜底。 */
  const favs = [];
  for (const f of tracked) {
    if (!/\.html$/.test(f) || /^\.scratch\//.test(f)) continue;
    const mm = read(f).match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)">/);
    if (mm) favs.push({ f, uri: mm[1] });
  }
  ok(favs.length >= 100, `扫到 ${favs.length} 个页面带 favicon`);
  const stale = favs.filter((x) => x.uri !== FAVICON_URI);
  ok(stale.length === 0, '每个 favicon 都与门户那份逐字节相同',
    stale.length ? `${stale.length} 页不一致：${stale.slice(0, 5).map((x) => x.f).join(', ')}${stale.length > 5 ? ' …' : ''}` : '');
  ok(!favs.some((x) => /%E8%AA%9E/.test(x.uri)), '没有页面还停在旧「語」favicon');

  /* --- 7c. 生成器侧只留一处定义 --- */
  const BRAND = read('tools/brand.mjs');
  const def = BRAND.match(/export const FAVICON = "([^"]+)";/);
  ok(!!def, 'tools/brand.mjs 导出 FAVICON');
  ok(!!def && def[1] === FAVICON_URI, 'tools/brand.mjs 里的 FAVICON 与门户手写的那份逐字节相同');
  ok(/export const MARK = 'QY';/.test(BRAND), 'tools/brand.mjs 导出 MARK = QY');
  for (const g of ['tools/en-vocab.mjs', 'tools/en-reading.mjs']) {
    const src = read(g);
    ok(/import \{ FAVICON \} from '\.\/brand\.mjs'/.test(src), `${g} 从 tools/brand.mjs 取 favicon`);
    ok(!/const FAVICON\s*=/.test(src), `${g} 不再自带 FAVICON 字面量（抄两份就会漏改一处）`);
  }

  const RM = read('tools/research.mjs');
  const marks = (RM.match(/wb-shell-mark" aria-hidden="true">QY</g) || []).length;
  ok(marks === 2, `research.mjs 里外壳模板两处标记都是 QY（顶条 + 浮动胶囊）`, `实为 ${marks} 处`);
  ok(!/>語</.test(RM), 'research.mjs 里不再残留 語 标记');

  const reports = tracked.filter((f) => /^research\/.*\.html$/.test(f));
  ok(reports.length > 0, `找到 ${reports.length} 份报告`);
  for (const f of reports) {
    const html = read(f);
    const n = (html.match(/wb-shell-mark" aria-hidden="true">QY</g) || []).length;
    ok(n === 2, `${f} 的外壳两处标记已重加为 QY`, `实为 ${n} 处（跑 node tools/research.mjs add-shell）`);
    ok(!/wb-shell-mark[^>]*>語</.test(html), `${f} 里没有残留的 語 标记`);
  }
}

/* ============================ 8. 全仓 JS 语法普查 ============================ */
section('8. 全仓 JS 语法普查（改字符串里的标记时最容易把脚本写崩）');
{
  const jsFiles = tracked.filter((f) => /\.(js|mjs)$/.test(f) && !/^\.scratch\//.test(f) && !/node_modules\//.test(f));
  const broken = [];
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { cwd: REPO, encoding: 'utf8' });
    if (r.status !== 0) {
      broken.push(f);
      console.log(`        ${f}: ${String(r.stderr || '').split('\n').slice(0, 3).join(' / ')}`);
    }
  }
  ok(broken.length === 0, `${jsFiles.length} 个 JS 文件全部语法通过`, broken.join(', '));
}

console.log('\n' + (failed ? 'RESULT: FAIL（' + failed + '/' + total + ' 项失败）' : 'RESULT: ALL PASS（共 ' + total + ' 项断言）'));
process.exit(failed ? 1 : 0);
