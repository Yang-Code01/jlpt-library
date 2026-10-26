#!/usr/bin/env node
/* 《Pi 工具链手册》生成器 / 校验器。
 *
 *   node tools/pi-toolchain-gen.mjs           # 由真源重写成品
 *   node tools/pi-toolchain-gen.mjs check     # 只校验：重渲染逐字节比 + 断言（退出码 0/1）
 *   node tools/pi-toolchain-gen.mjs probe     # 只探测本机 pi 安装（找到 0，找不到 2）
 *
 * 真源是 tools-dev/pi-toolchain.data.json。页面一个字符都不手改：改真源、重跑、跑校验。
 *
 * 为什么是「真源 → 成品」而不是手写稿：这一页要写 11 个包的命令与配置，手写必然漂移；
 * 交给 data.json 之后，漏条目、锚点死链、脱敏泄漏、版本表对不上都能被 check 抓住。
 *
 * 页面必须 `file://` 直接可开：数据与样式全部内联，不取数、不引外链。
 * 脱敏靠真源自带的可逆占位符（~/、<PI_HOME>、<REPO>、<USER>）——生成器不做替换；
 * 只有 probe / 出处可达性校验才把它们还原成真实路径。
 *
 * 十10 条断言的实现进度：本文件当前落地 A1/A2/A3/A4/A5/A9/A10（ticket 01），
 * A6「出处存在」/A7「折叠守恒」/A8「缺口不静默」在 ticket 02/03 的改动里补齐。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { norm, writePreservingEol } from './lib/eol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const DATA = path.join(REPO, 'tools-dev', 'pi-toolchain.data.json');
const OUT = path.join(REPO, 'tools-dev', 'pi-toolchain.html');
const REL_OUT = 'tools-dev/pi-toolchain.html';

const MODE = ['check', 'probe'].includes(process.argv[2]) ? process.argv[2] : 'write';

const TITLE = 'Pi 工具链手册';
const HOMEDIR = os.homedir();
const PI_HOME = path.join(HOMEDIR, '.pi', 'agent');

/* ------------------------------------------------------------------ 真源 */

function loadData() {
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

/* 可逆占位符：真源里只写占位符，需要真实路径时再还原（probe 与出处校验用） */
function realPath(p) {
  return String(p)
    .replace(/^~\//, HOMEDIR + '/')
    .replace(/<PI_HOME>/g, PI_HOME)
    .replace(/<REPO>/g, REPO)
    .replace(/<USER>/g, os.userInfo().username);
}

/* ---------------------------------------------------------------- 渲染工具 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const KIND_OF = {
  package: { label: '包与扩展', id: 'sec-packages' },
  mcp: { label: 'MCP server', id: 'sec-mcp' },
  skill: { label: '技能清单', id: 'sec-skills' },
  tool: { label: '内置工具', id: 'sec-tools' },
};

const TERMS = [
  ['包（package）', 'pi 用 `pi install` 装进来的 npm 包或本地路径包，靠 package.json 的 `pi` 字段声明要加载什么。'],
  ['扩展（extension）', '包（或 <PI_HOME>/extensions/）导出的代码，给 pi 加工具、改界面、拦事件。一个包可以带多个扩展。'],
  ['插件（plugin）', '口语词，本页不用它做技术分类：一个包可能同时带扩展、技能和 prompt。'],
  ['MCP server', '外部进程，按 Model Context Protocol 把工具暴露给 pi；本机由适配器包接管，不走 pi 内置实现。'],
  ['技能（skill）', '一段带 frontmatter 的 SKILL.md，模型按需加载；来源可以是用户目录、pi 自带目录，或某个包。'],
  ['工具（tool）', '模型在会话里能直接调用的函数。可能由 pi 核心提供，也可能由某个包注册。'],
  ['真源 / 生成物', '真源是 data.json（手改这个）；生成物是这一页（重跑生成器才变）。'],
];

function table(head, rows, cls = '') {
  if (!rows.length) return '';
  return (
    `<table${cls ? ` class="${cls}"` : ''}>\n<thead><tr>` +
    head.map((h) => `<th>${esc(h)}</th>`).join('') +
    '</tr></thead>\n<tbody>\n' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('\n') +
    '\n</tbody>\n</table>'
  );
}

const code = (s) => `<code>${esc(s)}</code>`;

/* 出处统一渲染成小字，且已经脱敏（真源里就是占位符） */
const src = (s) => (s ? `<span class="src">${esc(s)}</span>` : '');

/* ------------------------------------------------------------------ 结构块 */

function renderVersionTable(data) {
  const rows = data.packages
    .map(
      (p) =>
        `<tr data-pkg="${esc(p.name)}" data-ver="${esc(p.version)}">` +
        `<td>${code(p.name)}${p.local ? ' <span class="badge">本地路径</span>' : ''}</td>` +
        `<td class="num">${esc(p.version)}</td>` +
        `<td>${esc(p.provider)}</td>` +
        '</tr>'
    )
    .join('\n');
  return (
    '<table class="ver">\n<thead><tr><th>包</th><th>版本</th><th>来自</th></tr></thead>\n<tbody>\n' +
    rows +
    '\n</tbody>\n</table>'
  );
}

function renderItem(item) {
  const blocks = [];

  if (item.scenes && item.scenes.length) {
    blocks.push(
      `<h4>使用场景</h4><ul class="scenes">` +
        item.scenes.map((s) => `<li>${esc(s.text)} ${src(s.src)}</li>`).join('') +
        '</ul>'
    );
  }

  if (item.commands && item.commands.length) {
    blocks.push(
      '<h4>命令 / 工具</h4>' +
        table(
          ['名称', '参数', '作用', '出处'],
          item.commands.map((c) => [code(c.name), code(c.args || ''), esc(c.purpose), src(c.src)])
        )
    );
  }

  if (item.config && item.config.length) {
    blocks.push(
      '<h4>配置项</h4>' +
        table(
          ['键', '含义', '默认值', '出处'],
          item.config.map((c) => [code(c.key), esc(c.meaning), c.default ? code(c.default) : '—', src(c.src)])
        )
    );
  }

  if (item.env && item.env.length) {
    blocks.push(
      '<h4>环境变量</h4>' +
        table(
          ['变量', '含义', '出处'],
          item.env.map((e) => [code(e.name), esc(e.meaning), src(e.src)])
        )
    );
  }

  if (item.files && item.files.length) {
    blocks.push(
      '<h4>相关文件</h4>' +
        table(
          ['路径', '含义'],
          item.files.map((f) => [code(f.path), esc(f.meaning)])
        )
    );
  }

  const meta = [
    item.provider ? `<span class="meta-k">来自</span> ${esc(item.provider)}` : '',
    item.version ? `<span class="meta-k">版本</span> ${code(item.version)}` : '',
    item.versionFrom ? `<span class="meta-k">版本源</span> ${src(item.versionFrom)}` : '',
  ]
    .filter(Boolean)
    .join('');

  return (
    `<article class="entry" id="item-${esc(item.id)}" data-kind="${esc(item.kind)}">` +
    `<h3><a href="#item-${esc(item.id)}">${esc(item.name)}</a></h3>` +
    (meta ? `<p class="entry-meta">${meta}</p>` : '') +
    `<p class="entry-summary">${esc(item.summary)}</p>` +
    (blocks.length ? blocks.join('\n') : '') +
    '</article>'
  );
}

function renderSections(data) {
  const out = [];
  for (const kind of ['package', 'mcp', 'skill', 'tool']) {
    const items = data.items.filter((i) => i.kind === kind);
    if (!items.length) continue;
    const k = KIND_OF[kind];
    out.push(
      `<section data-section="${esc(kind)}" id="${k.id}">\n<h2>${esc(k.label)}</h2>\n` +
        items.map(renderItem).join('\n') +
        '\n</section>'
    );
  }
  return out;
}

function renderUndocumented(data) {
  const rows = [];
  for (const u of data.undocumented || []) {
    rows.push([esc(u.topic), src(u.srcA), src(u.srcB), esc(u.choice)]);
  }
  for (const item of data.items) {
    for (const u of item.undocumented || []) {
      rows.push([`${esc(item.name)}：${esc(u.topic)}`, src(u.srcA), src(u.srcB), esc(u.choice)]);
    }
  }
  if (!rows.length) {
    return '<p class="note">这一版没有登记到「文档未载 / 两处矛盾」的条目。</p>';
  }
  return table(['主题', '出处 A', '出处 B', '取舍'], rows);
}

function renderNav(data) {
  const links = [['sec-terms', '术语速查']];
  for (const kind of ['package', 'mcp', 'skill', 'tool']) {
    if (data.items.some((i) => i.kind === kind)) links.push([KIND_OF[kind].id, KIND_OF[kind].label]);
  }
  links.push(['sec-undoc', '文档未载'], ['sec-update', '这份页怎么更新']);
  return (
    '<nav class="toc" aria-label="目录"><h2>目录</h2><ul>' +
    links.map(([id, label]) => `<li><a href="#${id}">${esc(label)}</a></li>`).join('') +
    '</ul></nav>'
  );
}

/* -------------------------------------------------------------------- 样式 */

const CSS = `
:root{
  --bg:#0f1115; --panel:#161a21; --ink:#e7ecf3; --muted:#9aa6b6; --rule:#26303c;
  --accent:#5ec8c8; --accent-ink:#04212a; --badge:#2a3644;
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#f6f7f9; --panel:#ffffff; --ink:#1b2129; --muted:#5b6673; --rule:#dfe4ea;
    --accent:#0b7a86; --accent-ink:#ffffff; --badge:#eceff3;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.65 "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:"Cascadia Code",Consolas,ui-monospace,monospace;font-size:.9em;
  background:var(--badge);padding:.05em .35em;border-radius:4px}
.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 72px}
header.top{border-bottom:1px solid var(--rule);padding-bottom:20px;margin-bottom:28px}
h1{font-size:28px;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 14px}
.facts{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:13px;margin:0 0 18px}
.facts code{background:var(--badge)}
h2{font-size:19px;margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--rule)}
h3{font-size:16px;margin:22px 0 4px}
h4{font-size:13px;margin:16px 0 6px;color:var(--muted);text-transform:none;letter-spacing:.02em}
.layout{display:block}
.toc{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:14px 16px;margin:0 0 26px}
.toc h2{font-size:13px;margin:0 0 8px;border:0;padding:0;color:var(--muted);letter-spacing:.06em}
.toc ul{margin:0;padding-left:18px}
.toc li{margin:2px 0}
table{width:100%;border-collapse:collapse;margin:6px 0 4px;font-size:13.5px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}
td.num{white-space:nowrap;font-variant-numeric:tabular-nums}
.src{color:var(--muted);font-size:12px;word-break:break-all}
.entry{background:var(--panel);border:1px solid var(--rule);border-radius:10px;
  padding:14px 18px 18px;margin:14px 0}
.entry-meta{color:var(--muted);font-size:12.5px;margin:0 0 6px;display:flex;flex-wrap:wrap;gap:6px 16px}
.meta-k{color:var(--muted);opacity:.75;margin-right:2px}
.entry-summary{margin:0 0 4px}
.badge{background:var(--badge);color:var(--muted);font-size:11px;padding:.1em .45em;border-radius:999px}
.scenes{margin:4px 0 8px;padding-left:20px}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 20px}
#q{flex:1 1 240px;min-width:180px;padding:8px 12px;border-radius:8px;
  border:1px solid var(--rule);background:var(--panel);color:var(--ink);font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--rule);background:var(--panel);color:var(--ink);
  padding:5px 11px;border-radius:999px;font-size:12.5px;cursor:pointer;font-family:inherit}
.chip[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.filter-note{color:var(--muted);font-size:12.5px;margin:0 0 10px}
.note{color:var(--muted);font-size:13px}
footer{border-top:1px solid var(--rule);margin-top:44px;padding-top:16px;color:var(--muted);font-size:12.5px}
`;

const SCRIPT = `
(function(){
  var q=document.getElementById('q');
  var count=document.getElementById('count');
  var chips=[].slice.call(document.querySelectorAll('.chip'));
  var entries=[].slice.call(document.querySelectorAll('[data-kind]'));
  var sections=[].slice.call(document.querySelectorAll('section[data-section]'));
  var active='all';
  function apply(){
    var needle=(q.value||'').trim().toLowerCase();
    var shown=0;
    entries.forEach(function(el){
      var okKind=(active==='all')||(el.getAttribute('data-kind')===active);
      var okText=!needle||el.textContent.toLowerCase().indexOf(needle)>=0;
      var on=okKind&&okText;
      if(on){el.removeAttribute('hidden');shown++;}else{el.setAttribute('hidden','');}
    });
    sections.forEach(function(sec){
      var any=sec.querySelector('[data-kind]:not([hidden])');
      if(any){sec.removeAttribute('hidden');}else{sec.setAttribute('hidden','');}
    });
    if(count){count.textContent=shown+' / '+entries.length;}
  }
  chips.forEach(function(chip){
    chip.addEventListener('click',function(){
      active=chip.getAttribute('data-chip');
      chips.forEach(function(other){
        other.setAttribute('aria-pressed',String(other===chip));
      });
      apply();
    });
  });
  if(q){q.addEventListener('input',apply);}
  apply();
})();
`;

/* -------------------------------------------------------------------- 页面 */

function renderPage(data) {
  const chips =
    '<div class="chips" role="group" aria-label="按类型筛选">' +
    data.chips
      .map(
        (c) =>
          `<button type="button" class="chip" data-chip="${esc(c.id)}" aria-pressed="${
            c.id === 'all' ? 'true' : 'false'
          }">${esc(c.label)}</button>`
      )
      .join('') +
    '</div>';

  const terms = table(
    ['词', '本页的用法'],
    TERMS.map(([w, d]) => [esc(w), esc(d)])
  );

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="本机 pi 装了哪些包、每个包怎么用、命令与配置在哪、哪些文档根本没写。">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">

<header class="top">
<h1>${TITLE}</h1>
<p class="sub">本机 pi 装了哪些包、每个包怎么用、命令与配置在哪、哪些文档根本没写。</p>
<p class="facts">
<span>采集日期 <code>${esc(data.collectedAt)}</code></span>
<span>pi 核心 <code>${esc(data.piCore.name)}</code> <code>${esc(data.piCore.version)}</code></span>
<span>已装包 <code>${data.packages.length}</code> 个</span>
</p>
<h2 id="sec-versions">版本基线</h2>
<p class="note">这张表是这一版内容的基线：下面的命令与配置都是对着这些版本抄的。</p>
${renderVersionTable(data)}
</header>

${renderNav(data)}

<main>
<section id="sec-terms">
<h2>术语速查</h2>
${terms}
</section>

<div class="toolbar">
<input id="q" type="search" placeholder="过滤：名称 / 描述 / 命令 / 配置（Esc 清空）" aria-label="过滤条目">
${chips}
</div>
<p class="filter-note">显示 <span id="count">${data.items.length} / ${data.items.length}</span> 条</p>

${renderSections(data).join('\n')}

<section id="sec-undoc">
<h2>文档未载 / 两处矛盾</h2>
${renderUndocumented(data)}
</section>

<section id="sec-update">
<h2>这份页怎么更新</h2>
<p>这一页是生成物，不要直接改 <code>${REL_OUT}</code>。真源只有一份：<code>tools-dev/pi-toolchain.data.json</code>。</p>
<ol>
<li>改真源：新增一个包就往 <code>items</code> 里加一条，<code>id</code> 必须唯一且与页内锚点同名；<code>src</code> 一律写成 <code>~/</code>、<code>&lt;PI_HOME&gt;</code>、<code>&lt;REPO&gt;</code>、<code>&lt;USER&gt;</code> 这类占位符，不许写真实路径。</li>
<li>重生成：<code>node tools/pi-toolchain-gen.mjs</code>。</li>
<li>校验：<code>node tools/pi-toolchain-gen.mjs check</code>，再跑 <code>node tools/test.mjs</code>。</li>
<li>新增包要同时动三处：真源的 <code>items</code> 与 <code>packages</code>、<code>collectedAt</code> 日期、以及包版本变化时的 <code>version</code>/<code>versionFrom</code>。</li>
</ol>
</section>
</main>

<footer>
<p>采集于 ${esc(data.collectedAt)}，对应 pi 核心 ${esc(data.piCore.version)}。内容随版本变化：重跑生成器即刷新。</p>
</footer>

</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/* ---------------------------------------------------------------- 十条断言 */

/* 只保留「页面自身就能判」的断言：check 不依赖本机是否装了 pi（缺源是 probe 的事）。 */
const ASSERTIONS = [
  {
    id: 'A1',
    label: '条目不丢：真源条目数 == 页面条目数，id 集合相等',
    run(html, data) {
      const inPage = [...html.matchAll(/<article class="entry" id="item-([^"]+)" data-kind="/g)].map((m) => m[1]);
      const inData = data.items.map((i) => i.id);
      const missing = inData.filter((id) => !inPage.includes(id));
      const extra = inPage.filter((id) => !inData.includes(id));
      if (missing.length) return `页面缺条目：${missing.join('、')}`;
      if (extra.length) return `页面多出真源里没有的条目：${extra.join('、')}`;
      if (inPage.length !== inData.length) return `条目数不一致（真源 ${inData.length}，页面 ${inPage.length}）`;
      return null;
    },
  },
  {
    id: 'A2',
    label: '锚点不死：每个 href="#x" 都有对应 id；每个条目 id 恰好出现一次',
    run(html) {
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length) return `id 重复：${[...new Set(dupes)].join('、')}`;
      const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
      const dead = [...new Set(targets.filter((t) => !ids.includes(t)))];
      if (dead.length) return `锚点指向不存在的 id：${dead.join('、')}`;
      const itemIds = [...html.matchAll(/<article class="entry" id="item-([^"]+)"/g)].map((m) => m[1]);
      const dupItem = itemIds.filter((id, i) => itemIds.indexOf(id) !== i);
      if (dupItem.length) return `条目锚点重复：${[...new Set(dupItem)].join('、')}`;
      return null;
    },
  },
  {
    id: 'A3',
    label: '无泄漏：全页无真实用户名 / 盘符 / 本机 home',
    run(html) {
      const hits = [];
      const user = os.userInfo().username;
      if (user && html.toLowerCase().includes(user.toLowerCase())) hits.push(`用户名 ${user}`);
      if (/[A-Za-z]:[\\/]/.test(html)) hits.push('盘符路径');
      if (HOMEDIR && html.includes(HOMEDIR)) hits.push('本机 home');
      if (/AppData/i.test(html)) hits.push('AppData');
      return hits.length ? `出现 ${hits.join('、')}` : null;
    },
  },
  {
    id: 'A4',
    label: '行尾 LF：全文件无 CR',
    run(html) {
      const cr = (html.match(/\r/g) || []).length;
      return cr ? `有 ${cr} 个 CR` : null;
    },
  },
  {
    id: 'A5',
    label: 'file:// 硬约束：无 fetch/XHR、无外链 css/js/img',
    run(html) {
      const bad = [];
      if (/\bfetch\s*\(/.test(html)) bad.push('fetch(');
      if (/XMLHttpRequest/.test(html)) bad.push('XMLHttpRequest');
      if (/<link[^>]+href="https?:/i.test(html)) bad.push('外链 <link>');
      if (/<script[^>]+src="https?:/i.test(html)) bad.push('外链 <script src>');
      if (/<img[^>]+src="https?:/i.test(html)) bad.push('外链 <img src>');
      return bad.length ? `出现 ${bad.join('、')}` : null;
    },
  },
  {
    id: 'A9',
    label: '版本表一致：页头表每行都能对上真源（无多无少）',
    run(html, data) {
      const rows = [...html.matchAll(/<tr data-pkg="([^"]+)" data-ver="([^"]+)">/g)].map((m) => ({
        name: m[1],
        version: m[2],
      }));
      const want = data.packages.map((p) => ({ name: p.name, version: p.version }));
      if (rows.length !== want.length) return `表格行数 ${rows.length} ≠ 真源 ${want.length}`;
      for (const w of want) {
        const got = rows.find((r) => r.name === w.name);
        if (!got) return `表格缺 ${w.name}`;
        if (got.version !== w.version) return `${w.name} 版本不一致（表 ${got.version}，真源 ${w.version}）`;
      }
      const core = html.includes(`<code>${esc(data.piCore.version)}</code>`);
      if (!core) return `页头找不到 pi 核心版本 ${data.piCore.version}`;
      return null;
    },
  },
  {
    id: 'A10',
    label: '无 JS 不白屏：源码里没有默认隐藏的内容块',
    run(html) {
      const body = html.slice(html.indexOf('<body'));
      const markup = body.slice(0, body.indexOf('<script'));
      if (/<[a-z][^>]*\shidden[\s>=]/i.test(markup)) return '标记里有默认 hidden 的元素';
      if (/display\s*:\s*none/i.test(html)) return '样式里有 display:none';
      if (/class="[^"]*is-filtered/.test(markup)) return '标记里有默认 is-filtered';
      return null;
    },
  },
];

function runAssertions(html, data) {
  const fails = [];
  for (const a of ASSERTIONS) {
    let err = null;
    try {
      err = a.run(html, data);
    } catch (e) {
      err = `断言抛错：${e.message}`;
    }
    if (err) fails.push(`${a.id} ${a.label} —— ${err}`);
  }
  return { total: ASSERTIONS.length, fails };
}

/* ------------------------------------------------------------------ 探测 */

/** pi 核心包 package.json 的候选位置：node 同级、PATH 前缀（npm 全局装法）、PI_* 覆盖 */
function coreCandidates() {
  const rel = path.join('node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  const out = [path.join(path.dirname(process.execPath), rel), path.join(path.dirname(process.execPath), '..', 'lib', rel)];
  for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    out.push(path.join(d, rel), path.join(d, '..', 'lib', rel));
  }
  return out;
}

function findCore() {
  for (const c of coreCandidates()) {
    if (fs.existsSync(c)) {
      try {
        return { file: c, pkg: JSON.parse(fs.readFileSync(c, 'utf8')) };
      } catch {
        return { file: c, pkg: {} };
      }
    }
  }
  return null;
}

function probe() {
  const core = findCore();
  if (!core) {
    console.log('probe：找不到 @earendil-works/pi-coding-agent/package.json（本机没装 pi？）');
    return 2;
  }
  const settingsFile = path.join(PI_HOME, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    console.log(`probe：找不到 ${settingsFile.replace(HOMEDIR, '~')}（pi 装了但没跑过？）`);
    return 2;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (e) {
    console.log(`probe：settings.json 不是合法 JSON：${e.message}`);
    return 2;
  }
  const npmDir = path.join(PI_HOME, 'npm', 'node_modules');
  const wanted = (settings.packages || []).map((p) => String(p).replace(/^npm:/, ''));
  /* 相对路径包（如 ..\\packages\\pi-tui）的基准目录 pi 没写进文档：
     依次试 npm 目录、agent 目录的上一级（~/.pi）、agent 目录本身，取第一个真实存在的。
     三处都不在才报缺 —— 不把猜测当事实。 */
  const relBases = [path.join(PI_HOME, 'npm'), path.join(PI_HOME, '..'), PI_HOME];
  const isRel = (w) => w.includes('\\') || w.startsWith('.');
  const resolved = wanted.map((w) => {
    if (isRel(w)) {
      const tried = relBases.map((b) => path.join(b, w));
      const hit = tried.find((abs) => fs.existsSync(abs));
      return { name: w, abs: hit || tried[0], exists: !!hit };
    }
    const abs = path.join(npmDir, w);
    return { name: w, abs, exists: fs.existsSync(abs) };
  });
  const missing = resolved.filter((r) => !r.exists);
  console.log(`probe：pi 核心 ${core.pkg.version || '(未知版本)'}；settings 里 ${wanted.length} 项，缺目录 ${missing.length} 项`);
  for (const m of missing) console.log(`  ✗ ${m.name} → ${m.abs.replace(HOMEDIR, '~')}`);

  /* 与真源的版本基线对照：只报告漂移，不判失败（更新真源是人的决定） */
  try {
    const data = loadData();
    const drift = [];
    for (const p of data.packages) {
      if (p.local) continue;
      const f = path.join(npmDir, p.name, 'package.json');
      if (!fs.existsSync(f)) continue;
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).version;
      if (v && v !== p.version) drift.push(`${p.name}：真源 ${p.version} → 本机 ${v}`);
    }
    if (core.pkg.version && core.pkg.version !== data.piCore.version) {
      drift.push(`${data.piCore.name}：真源 ${data.piCore.version} → 本机 ${core.pkg.version}`);
    }
    if (drift.length) {
      console.log('probe：版本漂移（只提示，不改页面）：');
      for (const d of drift) console.log(`  · ${d}`);
    }
  } catch {
    /* 真源坏了是 check 的事，probe 只做探测 */
  }
  return 0;
}

/* -------------------------------------------------------------------- 主流程 */

function main() {
  if (MODE === 'probe') process.exit(probe());

  const data = loadData();
  const html = renderPage(data);
  const asserts = runAssertions(html, data);

  if (MODE === 'write') {
    const changed = writePreservingEol(OUT, html);
    console.log(
      `已生成 ${REL_OUT}（${html.length} 字节，${data.items.length} 个条目，${asserts.total} 项断言待跑）${changed ? '' : '（内容无变化）'}`
    );
    if (asserts.fails.length) {
      console.log('注意：生成物自身没通过断言，先修真源：');
      for (const f of asserts.fails) console.log(`  ✗ ${f}`);
      process.exit(1);
    }
    process.exit(0);
  }

  /* check：成品必须与真源重渲染的结果逐字节一致，然后对成品跑断言 */
  if (!fs.existsSync(OUT)) {
    console.log(`✗ ${REL_OUT} 不存在，先跑 node tools/pi-toolchain-gen.mjs`);
    process.exit(1);
  }
  const disk = fs.readFileSync(OUT, 'utf8');
  const problems = [];

  if (norm(disk) !== norm(html)) problems.push('成品与真源重渲染的结果不一致（有人手改了生成物，或改真源后忘了重跑）');
  if ((disk.match(/\r/g) || []).length) problems.push('成品含 CR（行尾必须 LF）');

  const onDisk = runAssertions(norm(disk), data);
  problems.push(...onDisk.fails);

  if (problems.length) {
    console.log(`✗ 共 ${onDisk.total} 项断言，${problems.length} 处问题：`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`共 ${onDisk.total} 项断言，全部通过（${REL_OUT}，${data.items.length} 个条目）`);
  process.exit(0);
}

main();
