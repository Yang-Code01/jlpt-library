#!/usr/bin/env node
/*
 * 调查报告（AI Research）模块：清单生成 / 校验 / 报告加壳
 *
 *   node tools/research.mjs gen              # 由 research/data.json 生成 index.html 里的报告清单区
 *   node tools/research.mjs check            # 校验 data.json / 报告文件 / 清单区一致性，有问题退出码 1
 *   node tools/research.mjs add-shell <文件…> # 给报告文件写/刷新工作台外壳（幂等，可重复跑）
 *
 * 真源是 research/data.json；报告本身是 research/ 下的自包含单文件 HTML（无外链 css/js），
 * 随仓库发布，不进构建管线。index.html 里的标记区由 gen 写，勿手改。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = join(ROOT, 'research/data.json');
const INDEX_PATH = join(ROOT, 'index.html');
const RESEARCH_DIR = join(ROOT, 'research');

const LIST_START = '<!-- wb:report-list:start -->';
const LIST_END = '<!-- wb:report-list:end -->';
const SHELL_KEYS = ['bar', 'float', 'foot'];
const BACK_HREF = '../index.html#survey';

const problems = [];
const bad = (msg) => problems.push(msg);

/* ------------------------------------------------------------------ 工具 */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const norm = (s) => s.replace(/\r\n/g, '\n');
const tail = (p) => p.split(/[\\/]/).pop();

function readData() {
  if (!existsSync(DATA_PATH)) {
    bad(`找不到 ${tail(DATA_PATH)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    bad(`research/data.json 不是合法 JSON：${e.message}`);
    return null;
  }
}

function shellRegion(text, key) {
  const re = new RegExp(
    `[ \\t]*<!-- wb:shell:${key}:start -->[\\s\\S]*?<!-- wb:shell:${key}:end -->\\r?\\n?`,
    'g'
  );
  return text.replace(re, '');
}

/* --------------------------------------------------------- 清单区渲染 */

function pageMeta(file) {
  const abs = join(RESEARCH_DIR, file);
  const body = readFileSync(abs, 'utf8');
  const n =
    (body.match(/<section\b/g) || []).length || (body.match(/<h2\b/g) || []).length || 0;
  const kb = Math.max(1, Math.round(statSync(abs).size / 1024));
  return `${n} 章 · ${kb} KB`;
}

function renderItem(rep) {
  const tags = rep.tags.map((t) => `          <span class="tag">${esc(t)}</span>`).join('\n');
  const src = rep.source || {};
  const main = src.url
    ? `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.label)} ↗</a>`
    : esc(src.label || '');
  return [
    `      <div class="survey-item" data-tags="${esc(rep.tags.join(' '))}">`,
    `        <span class="survey-date">${esc(rep.date)}</span>`,
    `        <span>`,
    `          <span class="survey-title"><a href="research/${esc(rep.file)}">${esc(rep.title)}</a></span>`,
    `          <span class="survey-desc">${esc(rep.summary)}</span>`,
    `          <span class="survey-tags">`,
    tags,
    `          </span>`,
    `        </span>`,
    `        <span class="survey-src">`,
    `          <span class="src-main">${main}</span>`,
    `          <span class="src-sub">${pageMeta(rep.file)}</span>`,
    `        </span>`,
    `      </div>`,
  ].join('\n');
}

function renderFilterBar(tags, reports) {
  const count = (t) => reports.filter((r) => r.tags.includes(t)).length;
  const chips = tags.map((t) => {
    const n = count(t);
    const dis = n === 0 ? ' disabled' : '';
    return `        <button type="button" class="filter-chip" data-filter="${esc(t)}"${dis}>${esc(t)} <span class="n">${n}</span></button>`;
  });
  return [
    `      <div class="filter-bar" role="group" aria-label="按标签筛选">`,
    `        <span class="filter-label">标签</span>`,
    `        <button type="button" class="filter-chip on" data-filter="all">全部 <span class="n">${reports.length}</span></button>`,
    ...chips,
    `      </div>`,
  ].join('\n');
}

function renderRegion(data) {
  const reports = data.reports || [];
  const body = [
    `      <div class="zone-head zone-first">`,
    `        <div class="zone-head-main">`,
    `          <h2 class="zone-title">全部报告 <span class="zone-en">Reports</span></h2>`,
    `          <p class="zone-sub">按定稿日期倒序。点标题进报告；标签筛选只影响本页显示。</p>`,
    `        </div>`,
    `        <div class="zone-aside"><span class="zone-count">${reports.length} 篇</span></div>`,
    `      </div>`,
    ``,
    renderFilterBar(data.tags || [], reports),
    ``,
    `      <div class="survey-list" id="report-list">`,
    ...reports.map(renderItem),
    `      </div>`,
    ``,
    `      <p class="filter-empty" id="filter-empty" hidden>这个标签下还没有报告。</p>`,
    LIST_END,
  ].join('\n');
  return `${LIST_START}\n${body}`;
}

/* -------------------------------------------------------------- 校验 */

function validate(data) {
  if (!data || typeof data !== 'object') return;
  const tags = data.tags;
  if (!Array.isArray(tags) || !tags.length) bad('data.json：tags 必须是非空数组（受控词表）');
  if (Array.isArray(tags)) {
    const dup = tags.filter((t, i) => tags.indexOf(t) !== i);
    if (dup.length) bad(`data.json：tags 里有重复项 ${[...new Set(dup)].join('、')}`);
    tags.forEach((t) => {
      if (typeof t !== 'string' || !t.trim()) bad('data.json：tags 里有空标签');
    });
  }

  const reports = data.reports;
  if (!Array.isArray(reports) || !reports.length) bad('data.json：reports 必须是非空数组');
  if (!Array.isArray(reports)) return;

  const seen = new Set();
  reports.forEach((rep, i) => {
    const at = `reports[${i}]（${rep && rep.title ? rep.title : '无标题'}）`;
    if (!rep || typeof rep !== 'object') return bad(`${at}：不是对象`);
    for (const key of ['file', 'title', 'date', 'summary']) {
      if (typeof rep[key] !== 'string' || !rep[key].trim()) bad(`${at}：缺 ${key}`);
    }
    if (typeof rep.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(rep.date))
      bad(`${at}：date 要写成 YYYY-MM-DD，现在是「${rep.date}」`);
    if (!Array.isArray(rep.tags) || !rep.tags.length) bad(`${at}：tags 必须是非空数组`);
    if (Array.isArray(rep.tags)) {
      rep.tags.forEach((t) => {
        if (Array.isArray(tags) && !tags.includes(t))
          bad(`${at}：标签「${t}」不在受控词表里（先加进 data.json 的 tags）`);
      });
      const dup = rep.tags.filter((t, j) => rep.tags.indexOf(t) !== j);
      if (dup.length) bad(`${at}：tags 里有重复项 ${[...new Set(dup)].join('、')}`);
    }
    if (rep.source && typeof rep.source === 'object') {
      if (!rep.source.label) bad(`${at}：source.label 不能空`);
      if (rep.source.url && !/^https?:\/\//.test(rep.source.url))
        bad(`${at}：source.url 要是 http(s) 链接`);
    } else if (rep.source !== undefined) {
      bad(`${at}：source 要么省略，要么写成 { label, url? }`);
    }

    if (typeof rep.file === 'string' && rep.file) {
      if (seen.has(rep.file)) bad(`${at}：file「${rep.file}」重复`);
      seen.add(rep.file);
      if (!/^[a-z0-9][a-z0-9.-]*\.html$/.test(rep.file))
        bad(`${at}：文件名要小写 kebab-case + .html，现在是「${rep.file}」`);
      if (/^\d{4}-\d{2}-\d{2}/.test(rep.file))
        bad(`${at}：文件名不要带日期前缀（日期记在 data.json 的 date 里）`);
      const abs = join(RESEARCH_DIR, rep.file);
      if (!existsSync(abs)) {
        bad(`${at}：找不到文件 research/${rep.file}`);
      } else {
        const body = readFileSync(abs, 'utf8');
        const external = [
          /<link\b[^>]*\bhref=["']https?:\/\//i,
          /<script\b[^>]*\bsrc=["']https?:\/\//i,
          /<img\b[^>]*\bsrc=["']https?:\/\//i,
        ].find((re) => re.test(body));
        if (external)
          bad(`${at}：research/${rep.file} 不是自包含单文件（发现外链资源，file:// 下会挂）`);
        SHELL_KEYS.forEach((k) => {
          const open = body.split(`<!-- wb:shell:${k}:start -->`).length - 1;
          const close = body.split(`<!-- wb:shell:${k}:end -->`).length - 1;
          if (open !== 1 || close !== 1)
            bad(
              `${at}：research/${rep.file} 的外壳 ${k} 标记有 ${open}/${close} 对` +
                `（应各 1 对，跑 node tools/research.mjs add-shell research/${rep.file}）`
            );
        });
      }
    }
  });

  // 排序：按日期倒序
  const dates = reports.map((r) => (typeof r.date === 'string' ? r.date : ''));
  const sorted = [...dates].sort().reverse();
  if (dates.join('|') !== sorted.join('|'))
    bad('data.json：reports 未按日期倒序（新的排前面）');
}

function checkIndex(data) {
  if (problems.length || !data) return;
  const disk = readFileSync(INDEX_PATH, 'utf8');
  const i = disk.indexOf(LIST_START);
  const j = disk.indexOf(LIST_END);
  if (i === -1 || j === -1 || j < i) {
    bad('index.html：找不到报告清单标记区（wb:report-list:start / end）');
    return;
  }
  const re = new RegExp(
    `${LIST_START.replace(/[-[\]{}()*+?.\\^$|]/g, '\\$&')}[\\s\\S]*?${LIST_END.replace(
      /[-[\]{}()*+?.\\^$|]/g,
      '\\$&'
    )}`
  );
  const canonical = disk.replace(re, renderRegion(data));
  if (norm(canonical) !== norm(disk)) {
    bad('index.html：报告清单区与 research/data.json 不一致（跑 node tools/research.mjs gen）');
  }
}

/* ------------------------------------------------------------ 报告外壳 */

const SHELL_FONT =
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif';

const SHELL_CSS = `<style data-wb-shell="1">
  /* ===== 工作台外壳（顶部细条 + 浮动胶囊 + 页脚返回）：由 tools/research.mjs add-shell 写入，勿手改 =====
     颜色尽量套用报告自己的令牌，套不到就退到中性半透明灰：浅色报告与深色报告都不违和。 */
  .wb-shell-bar{display:flex;align-items:center;gap:10px;padding:9px 20px;
    border-bottom:1px solid var(--rule,var(--border,rgba(127,127,127,.28)));
    background:var(--card,var(--panel,rgba(127,127,127,.08)));
    ${SHELL_FONT};font-size:.78rem;line-height:1.6}
  .wb-shell-mark{display:grid;place-items:center;flex:none;width:20px;height:20px;border-radius:5px;
    background:var(--accent,#B4451F);color:#fff;font-size:.7rem;font-weight:700;letter-spacing:-.01em;
    /* QY 是两枚拉丁大写 —— 字号按 20px 容器实测定（.scratch/icons/probe-mark.mjs）；
       门户头部那枚 30px 的同形标记在 index.html 的 .portal-brand-mark 里，两处要一起改。 */
    font-family:Georgia,"Times New Roman","Songti SC",serif}
  .wb-shell-path{color:var(--muted,#6C6A73)}
  .wb-shell-path b{color:var(--ink,var(--text,inherit));font-weight:600}
  .wb-shell-back{margin-left:auto;flex:none;color:var(--accent,#B4451F);font-weight:600;text-decoration:none}
  .wb-shell-back:hover{text-decoration:underline}
  .wb-shell-float{position:fixed;right:22px;bottom:22px;z-index:50;display:inline-flex;align-items:center;gap:9px;
    padding:9px 15px;border:1px solid var(--rule-strong,var(--border,rgba(127,127,127,.4)));border-radius:999px;
    background:var(--card,var(--panel,rgba(127,127,127,.14)));color:var(--ink,var(--text,inherit));
    ${SHELL_FONT};font-size:.8rem;font-weight:600;text-decoration:none;
    box-shadow:0 2px 4px rgba(0,0,0,.06),0 12px 28px -14px rgba(0,0,0,.4)}
  .wb-shell-float:hover{color:var(--accent,#B4451F);border-color:var(--accent,#B4451F)}
  .wb-shell-foot{max-width:760px;margin:56px auto 0;padding:22px 24px 0;
    border-top:2px solid var(--ink,var(--text,currentColor));
    display:flex;flex-wrap:wrap;align-items:center;gap:14px;
    ${SHELL_FONT};font-size:.8rem;color:var(--muted,#6C6A73)}
  .wb-shell-foot b{color:var(--ink,var(--text,inherit))}
  .wb-shell-foot a{margin-left:auto;color:var(--accent,#B4451F);font-weight:600;text-decoration:none}
  .wb-shell-foot a:hover{text-decoration:underline}
  @media (max-width:560px){
    .wb-shell-bar{gap:8px;padding:8px 14px}
    .wb-shell-float{right:14px;bottom:14px}
  }
</style>`;

const SHELL_BAR = `<!-- wb:shell:bar:start -->
<div class="wb-shell-bar">
  <span class="wb-shell-mark" aria-hidden="true">QY</span>
  <span class="wb-shell-path">工作台 › <b>调查报告</b></span>
  <a class="wb-shell-back" href="${BACK_HREF}">← 返回报告清单</a>
</div>
<!-- wb:shell:bar:end -->`;

const SHELL_FOOT = `<!-- wb:shell:foot:start -->
<div class="wb-shell-foot">
  <span>这份报告属于 <b>工作台 › 调查报告</b></span>
  <a href="${BACK_HREF}">← 返回报告清单</a>
</div>
<!-- wb:shell:foot:end -->`;

const SHELL_FLOAT = `<!-- wb:shell:float:start -->
<a class="wb-shell-float" href="${BACK_HREF}">
  <span class="wb-shell-mark" aria-hidden="true">QY</span>
  <span>返回调查报告</span>
</a>
<!-- wb:shell:float:end -->`;

function addShell(file) {
  const abs = file.includes('/') || file.includes('\\') ? file : join(RESEARCH_DIR, file);
  if (!existsSync(abs)) return bad(`找不到报告文件 ${file}`);
  const raw = readFileSync(abs, 'utf8');
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  // 内部一律用 LF 处理，最后再整体写回原行尾 —— 避免 CRLF 报告被拼成混合行尾。
  let text = raw.replace(/\r\n/g, '\n');

  // 先清掉旧外壳（幂等）
  text = text.replace(/[ \t]*<style data-wb-shell="1">[\s\S]*?<\/style>\r?\n?/g, '');
  SHELL_KEYS.forEach((k) => (text = shellRegion(text, k)));

  const head = text.lastIndexOf('</head>');
  const bodyOpen = text.indexOf('<body');
  const bodyClose = text.lastIndexOf('</body>');
  if (head === -1 || bodyOpen === -1 || bodyClose === -1)
    return bad(`${basename(abs)}：找不到 </head> / <body> / </body>，无法加壳`);

  const gt = text.indexOf('>', bodyOpen) + 1;
  text =
    text.slice(0, head) +
    SHELL_CSS +
    '\n' +
    text.slice(head, gt) +
    '\n' +
    SHELL_BAR +
    text.slice(gt, bodyClose) +
    SHELL_FOOT +
    '\n' +
    SHELL_FLOAT +
    '\n' +
    text.slice(bodyClose);
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  writeFileSync(abs, text);
  console.log(`加壳完成：${basename(abs)}（${Buffer.byteLength(text)} 字节）`);
}

/* ---------------------------------------------------------------- 入口 */

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'gen') {
  const data = readData();
  if (data) validate(data);
  if (problems.length) {
    problems.forEach((p) => console.error(`✗ ${p}`));
    process.exit(1);
  }
  const disk = readFileSync(INDEX_PATH, 'utf8');
  const i = disk.indexOf(LIST_START);
  const j = disk.indexOf(LIST_END);
  if (i === -1 || j === -1) {
    console.error(`✗ index.html 里找不到 ${LIST_START} / ${LIST_END}`);
    process.exit(1);
  }
  const next = (() => {
    // 保留 index.html 自己的行尾：仓库里门户是 CRLF，别让生成器把标记区写成混合行尾。
    const eol = /\r\n/.test(disk) ? '\r\n' : '\n';
    const rendered = renderRegion(data);
    const want = eol === '\n' ? rendered : rendered.replace(/\n/g, eol);
    return disk.slice(0, i) + want + disk.slice(j + LIST_END.length);
  })();
  if (next === disk) {
    console.log('报告清单区已是最新，未改动 index.html');
  } else {
    writeFileSync(INDEX_PATH, next);
    console.log(
      `已写入 index.html 报告清单区：${(data.reports || []).length} 篇（${(
        data.tags || []
      ).join('、')}）`
    );
  }
} else if (cmd === 'check') {
  const data = readData();
  validate(data);
  checkIndex(data);
  if (problems.length) {
    problems.forEach((p) => console.error(`✗ ${p}`));
    console.error(`\n检查未通过：${problems.length} 个问题`);
    process.exit(1);
  }
  console.log(
    `✓ 报告清单自洽：${data.reports.length} 篇 · ${data.tags.length} 个受控标签 · index.html 标记区一致`
  );} else if (cmd === 'add-shell') {
  if (!rest.length) {
    console.error('用法：node tools/research.mjs add-shell research/<文件>.html');
    process.exit(1);
  }
  rest.forEach(addShell);
  if (problems.length) {
    problems.forEach((p) => console.error(`✗ ${p}`));
    process.exit(1);
  }
} else {
  console.error(
    '用法：\n  node tools/research.mjs gen                     # 生成 index.html 清单区\n' +
      '  node tools/research.mjs check                   # 校验\n' +
      '  node tools/research.mjs add-shell <文件…>        # 报告加壳'
  );
  process.exit(1);
}
