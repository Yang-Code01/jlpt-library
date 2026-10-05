#!/usr/bin/env node
/* ============================================================================
   英语侧词表：生成器 + 校验器
   ----------------------------------------------------------------------------
     node tools/en-vocab.mjs gen            生成数据 / 单元页 / 门户清单区
     node tools/en-vocab.mjs check          校验（含「再跑一次字节一致」）

   gen 与 check 共用同一个纯函数 build()：build() 返回「相对路径 → 文件内容」
   的完整映射，gen 把它写盘，check 把磁盘上的字节与它逐字比对。因此幂等性、
   齐全性、清单一致性是同一件事的三个侧面，不需要各自维护一套规则。

   源数据 .scratch/en-module/research/ecdict.csv（65.9MB）被 .gitignore 排除，
   克隆仓库的人要按 README「数据来源」一节自己下载、核对 sha256。

   设计依据：.scratch/en-module/PRD.md 决策 B / C，票 issues/03、04。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, ...p.split('/'));

/* --------------------------- 常量：数据来源与分档 --------------------------- */
const SOURCE = {
  name: 'ECDICT',
  license: 'MIT',
  url: 'https://github.com/skywind3000/ECDICT',
  file: 'ecdict.csv',
  sha256: '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf'
};
const CSV_PATH = '.scratch/en-module/research/ecdict.csv';

/* 四档按「全表词频排序后的位次」切，不按词频数值切（该字段不是从 1 起的连续序）。
   每档内每 50 词一个单元；单元号全局连续 01–77，路径与界面显示共用同一个数。 */
const PER_UNIT = 50;

/* 分档切点上的词，实测确定（见 .scratch/en-module/research/english-data-sources.md §7）。
   check 用它当金标准：切点错位、换了数据源，都会在校验里立刻报出来。 */
const BOUNDARY = [
  [1, 'the'], [1000, 'access'], [1001, 'restaurant'], [2000, 'passion'],
  [2001, 'volunteer'], [2809, 'ease'], [2810, 'seize'], [3766, 'foster']
];
const BANDS = [
  { id: '1k', label: '1k', rankFrom: 1, rankTo: 1000, sub: '最高频 1,000 词' },
  { id: '2k', label: '2k', rankFrom: 1001, rankTo: 2000, sub: '次高频 1,000 词' },
  { id: '3k', label: '3k', rankFrom: 2001, rankTo: 2809, sub: '常用 809 词' },
  { id: '4k', label: '4k', rankFrom: 2810, rankTo: 3766, sub: '进阶级 957 词' }
];

const PORTAL = 'index.html';
const MARK_START = '<!-- en:unit-lists:start -->';
const MARK_END = '<!-- en:unit-lists:end -->';
const MARK_NOTE = '<!-- 以下区块由 tools/en-vocab.mjs 生成，勿手改；数据变了请重跑生成器 -->';

/* 考纲标签的显示名。ECDICT 的 tag 字段只出这 8 个 token。 */
const TAG_TEXT = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级',
  ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE'
};
const TAG_ORDER = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'];

/* 中文释义的行首词性前缀 → 短标签。ECDICT 基础版的 pos 字段整列为空
   （770,611 行里只有表头有值），词性只能从释义行前缀反推。 */
const POS_RE = /^(n|vt|vi|v|a|adj|adv|ad|prep|pron|conj|art|num|int|aux|abbr)\.\s*/;
const POS_TEXT = {
  n: 'n.', v: 'v.', vt: 'vt.', vi: 'vi.', a: 'adj.', adj: 'adj.', adv: 'adv.', ad: 'adv.',
  prep: 'prep.', pron: 'pron.', conj: 'conj.', art: 'art.', num: 'num.', int: 'int.',
  aux: 'aux.', abbr: 'abbr.'
};

/* 英文释义保留前 3 行、上限 200 字符：WordNet 式释义干净，但高频词会混进
   Webster 的古义长文（"to" 一条 2,810 字符），不截断会把卡片撑爆。 */
const DEF_LINES = 3;
const DEF_MAX = 200;

/* ------------------------------- CSV 解析 -------------------------------- */
/* ECDICT 的换行在字段里写成字面量 \\n，但字段本身仍可能含逗号与双引号，
   所以按引号状态逐字符走；只留下候选行，避免把 77 万行进内存。 */
function readEcdict(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const out = [];
  let field = '', row = [], inQ = false;
  const endRow = () => {
    row.push(field); field = '';
    const w = row[0];
    /* 词形：小写字母起头，只含字母 / 撇号 / 连字符（滤掉短语、缩写、专名） */
    if (/^[a-z][a-z'-]*$/.test(w) && row[3] && (+row[9] || 0) > 0) out.push(row.slice(0, 13));
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (field || row.length) endRow();
  return out;
}

/* ------------------------------- 字段加工 -------------------------------- */
function cleanDef(s) {
  const lines = String(s || '').split('\\n').map((x) => x.trim()).filter(Boolean);
  let t = lines.slice(0, DEF_LINES).join('\n');
  if (t.length > DEF_MAX) {
    const cut = t.slice(0, DEF_MAX);
    const sp = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(' '));
    t = cut.slice(0, sp > DEF_MAX * 0.6 ? sp : DEF_MAX).replace(/[;,.\s]+$/, '') + '…';
  }
  return t;
}

function posOf(tr) {
  const seen = [];
  for (const line of String(tr || '').split('\\n')) {
    const m = line.match(POS_RE);
    if (!m) continue;
    const t = POS_TEXT[m[1]] || m[1] + '.';
    if (seen.indexOf(t) < 0) seen.push(t);
  }
  return seen.join('/');
}

function tagsOf(tag) {
  const have = String(tag || '').split(/\s+/).filter(Boolean);
  return TAG_ORDER.filter((t) => have.indexOf(t) >= 0);
}

/* --------------------------------- 构建 ---------------------------------- */
function build(csvPath) {
  const raw = readEcdict(csvPath);
  raw.sort((a, b) => (+a[9] || 0) - (+b[9] || 0));

  const total = BANDS[BANDS.length - 1].rankTo;
  if (raw.length < total) {
    throw new Error('可用词数不足：需要 ' + total + '，实际 ' + raw.length + '（源文件不对？）');
  }

  const words = [];
  let unitNo = 0;
  const bands = BANDS.map((b) => {
    const slice = raw.slice(b.rankFrom - 1, b.rankTo);
    /* 每档各自切单元：末单元不足 50 词是正常的，不补齐、不报错。 */
    const units = Math.ceil(slice.length / PER_UNIT);
    const first = unitNo + 1;
    slice.forEach((r, i) => {
      words.push({
        w: r[0],
        ph: r[1] || '',
        tr: r[3],
        def: cleanDef(r[2]),
        pos: posOf(r[3]),
        tag: tagsOf(r[7]),
        collins: +r[5] || 0,
        oxford: r[6] ? 1 : 0,
        bnc: +r[8] || 0,
        frq: +r[9] || 0,
        ex: r[10] || '',
        band: b.id,
        unit: first + Math.floor(i / PER_UNIT),
        rank: b.rankFrom + i
      });
    });
    unitNo += units;
    return {
      id: b.id, label: b.label, sub: b.sub,
      words: slice.length, units,
      from: b.rankFrom, to: b.rankTo,
      unitFrom: first, unitTo: unitNo
    };
  });

  const payload = JSON.stringify({ words, bands });
  const meta = {
    source: SOURCE.name,
    license: SOURCE.license,
    url: SOURCE.url,
    sourceFile: SOURCE.file,
    sourceSha256: SOURCE.sha256,
    generated: crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16),
    totalWords: words.length,
    totalUnits: unitNo,
    perUnit: PER_UNIT,
    bands
  };

  const vocab = { meta, words };
  const files = {};
  files['en/data/vocab.js'] =
    '/* 本文件由 tools/en-vocab.mjs 生成，勿手改。\n' +
    '   源：' + SOURCE.name + '（' + SOURCE.license + '）' + SOURCE.url + '\n' +
    '   sha256(' + SOURCE.file + ') = ' + SOURCE.sha256 + '\n' +
    '   内容指纹 = ' + meta.generated + '（再跑一次应当逐字一致） */\n' +
    'window.EN_VOCAB = ' + JSON.stringify(vocab, null, 0) + ';\n';

  /* 单元页：只由生成器注入一条 window.EN_UNIT 与页头文案，视图全在 en/unit.js。
     77 个页面若各自内联整套结构会有 600KB 重复，且后续切片要改 77 处。 */
  const pageUnits = [];
  for (const b of bands) {
    for (let i = 0; i < b.units; i++) {
      const no = b.unitFrom + i;
      const w0 = (i * PER_UNIT) + 1;
      const w1 = Math.min((i + 1) * PER_UNIT, b.words);
      pageUnits.push({ band: b.id, unit: no, from: b.from + w0 - 1, to: b.from + w1 - 1, i: w0, j: w1 });
    }
  }
  for (const u of pageUnits) files['en/' + u.band + '/' + pad(u.unit) + '.html'] = unitPage(u, bands);

  /* 门户清单区：由生成器写进 index.html 的标记区，避免 77 行手工维护漂移。 */
  const unitsByBand = {};
  for (const u of pageUnits) (unitsByBand[u.band] = unitsByBand[u.band] || []).push(u);
  files['__portal_region__'] = portalRegion(bands, unitsByBand, meta);

  return { files, meta, pageUnits, words };
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function commas(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23b93e28'/%3E%3Ctext x='16' y='23' font-size='19' font-family='serif' fill='%23ffffff' text-anchor='middle'%3E%E8%AA%9E%3C/text%3E%3C/svg%3E";

function unitPage(u, bands) {
  if (!Number.isFinite(u.from) || !Number.isFinite(u.to)) {
    throw new Error('单元 ' + u.band + '/' + pad(u.unit) + ' 的位次区间不是数字：' + u.from + '–' + u.to);
  }
  const b = bands.find((x) => x.id === u.band);
  const title = b.label + ' · ' + pad(u.unit) + ' · 英语词表 · Language Library';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="英语词表 ${esc(b.label)} 档第 ${u.unit} 单元：${commas(u.i)}–${commas(u.j)} 号词，列表速览与翻转卡自测。">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="../../assets/style.css">
<link rel="stylesheet" href="../unit.css">
<script src="../../assets/theme.js"></script>
</head>
<body>
<div class="en-wrap">
  <nav class="en-crumb">
    <a href="../../index.html">资料库首页</a>
    <span class="en-crumb-sep">／</span>
    <a href="../../index.html#en-band-${b.id}">英语词表</a>
    <span class="en-crumb-sep">／</span>
    <span>${esc(b.label)} · ${pad(u.unit)}</span>
  </nav>

  <main class="en-unit" id="enUnit" data-band="${b.id}" data-unit="${u.unit}">
    <noscript><p class="en-empty">本页的单词卡需要 JavaScript。</p></noscript>
  </main>
</div>

<script src="../data/vocab.js"></script>
<script>window.EN_UNIT = ${JSON.stringify({ band: u.band, unit: u.unit, from: u.from, to: u.to })};</script>
<script src="../../assets/progress.js"></script>
<script src="../unit.js"></script>
</body>
</html>
`;
}

function portalRegion(bands, unitsByBand, meta) {
  const stations = bands.map((b) =>
    `          <a class="ruler-station" href="#en-band-${b.id}"><span class="ruler-lv">${esc(b.label)}</span>` +
    `<span class="ruler-count">${b.units} 单元</span></a>`).join('\n');

  const blocks = bands.map((b) => {
    const us = unitsByBand[b.id] || [];
    const rows = us.map((u) => {
      const key = 'en/' + b.id + '/' + pad(u.unit) + '.html';
      return `            <li><a class="en-unit-row" href="${key}" data-en-key="${key}">` +
        `<span class="en-u-no">${pad(u.unit)}</span>` +
        `<span class="en-u-range">词 ${commas(u.i)}–${commas(u.j)}</span>` +
        `</a></li>`;
    }).join('\n');
    return `        <details class="en-band" id="en-band-${b.id}" data-en-band="${b.id}">
          <summary>
            <span class="en-band-id">${esc(b.label)}</span>
            <span class="en-band-sub">${esc(b.sub)}</span>
            <span class="en-band-prog" data-en-prog>已看 0/${us.length}</span>
          </summary>
          <ul class="en-unit-list">
${rows}
          </ul>
        </details>`;
  }).join('\n');

  const totalPages = Object.keys(unitsByBand).reduce((n, k) => n + unitsByBand[k].length, 0);

  return `      <section class="feature-block" aria-labelledby="en-feature-title">
        <span class="feature-index" aria-hidden="true">01</span>
        <h3 id="en-feature-title" class="feature-title">词表资料</h3>
        <p class="feature-lede">按全表词频位次切成四档，每 50 词一个单元。列表速览、翻转卡自测，背满一遍自动盖章。</p>

        <nav class="ruler" aria-label="词频档位">
${stations}
        </nav>

        <div class="en-bands" data-en-bands>
${blocks}
        </div>

        <div class="feature-foot">
          <a class="feature-cta" href="#en-band-${bands[0].id}">开始背词 <span aria-hidden="true">→</span></a>
          <span class="feature-stats">${commas(meta.totalWords)} 词 · ${meta.totalUnits} 单元 · ${bands.length} 档 · <b data-en-overall>已看 0/${totalPages}</b></span>
        </div>
      </section>`;
}

/* ---------------------------------- 注入 ---------------------------------- */
function splicePortal(region) {
  const p = rel(PORTAL);
  const html = fs.readFileSync(p, 'utf8');
  const i = html.indexOf(MARK_START);
  const j = html.indexOf(MARK_END);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(PORTAL + ' 里找不到标记区 ' + MARK_START + ' … ' + MARK_END +
      '（门户的英语清单区由本脚本维护，请先补上标记）');
  }
  const head = html.slice(0, i);
  const tail = html.slice(j + MARK_END.length);
  return head + MARK_START + '\n      ' + MARK_NOTE + '\n' + region + '\n    ' + MARK_END + tail;
}

/* ---------------------------------- 命令 ---------------------------------- */
const argv = process.argv.slice(2);
const cmd = argv[0] || 'gen';
const srcIdx = argv.indexOf('--src');
const csvPath = srcIdx >= 0 ? argv[srcIdx + 1] : rel(CSV_PATH);

if (!fs.existsSync(csvPath)) {
  console.error('源文件不存在：' + csvPath);
  console.error('按 README「数据来源」下载 ecdict.csv 到 ' + CSV_PATH + '，或加 --src <路径>');
  process.exit(2);
}

const { files, meta, pageUnits, words } = build(csvPath);

/* 源数据校验和：用默认源时一定比对（台账里写了这个值）；--src 允许指向别处，用于自测。 */
const sumOk = () => crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex') === SOURCE.sha256;
const REGION = files.__portal_region__;
delete files.__portal_region__;

/* 门户是「读进来 → 换掉标记区 → 写回去」，单独处理。 */
const portalPath = rel(PORTAL);
const portalNow = fs.readFileSync(portalPath, 'utf8');
const portalNext = splicePortal(REGION);
const all = Object.assign({}, files, { [PORTAL]: portalNext });

if (cmd === 'gen') {
  for (const p of Object.keys(all)) {
    const target = rel(p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, all[p]);
  }
  let bytes = 0;
  for (const p of Object.keys(all)) bytes += Buffer.byteLength(all[p]);
  console.log('已生成 ' + Object.keys(all).length + ' 个文件（' + (bytes / 1024).toFixed(0) + ' KB）');
  console.log('词 ' + meta.totalWords + ' · 单元 ' + meta.totalUnits + ' · 页面 ' + pageUnits.length +
    ' · 指纹 ' + meta.generated);
  for (const b of meta.bands) {
    console.log('  ' + b.label + '  词 ' + b.words + '  单元 ' + b.units +
      '  单元号 ' + pad(b.unitFrom) + '–' + pad(b.unitTo) + '  词频位次 ' + b.from + '–' + b.to);
  }
  process.exit(0);
}

if (cmd === 'check') {
  const bad = [];
  if (srcIdx < 0 && !sumOk()) bad.push('源数据 sha256 与台账不符（' + CSV_PATH + '）');
  for (const p of Object.keys(all)) {
    const target = rel(p);
    if (!fs.existsSync(target)) { bad.push('缺失 ' + p); continue; }
    if (fs.readFileSync(target, 'utf8') !== all[p]) bad.push('内容不一致 ' + p);
  }
  /* 反向：磁盘上多出来的单元页（生成器不再产出的孤儿） */
  for (const b of meta.bands) {
    const dir = rel('en/' + b.id);
    if (!fs.existsSync(dir)) continue;
    const keep = [];
    for (const f of fs.readdirSync(dir)) if (/\.html$/.test(f)) keep.push('en/' + b.id + '/' + f);
    const expect = pageUnits.filter((u) => u.band === b.id).map((u) => 'en/' + b.id + '/' + pad(u.unit) + '.html');
    for (const f of keep) if (expect.indexOf(f) < 0) bad.push('多余页面 ' + f);
  }
  /* 清单区与实际文件的配对：注意 files 里已含全部页面路径 */
  const region = REGION;
  const linked = [];
  const re = /data-en-key="([^"]+)"/g; let m;
  while ((m = re.exec(region))) linked.push(m[1]);
  for (const k of linked) if (!files[k]) bad.push('门户清单指向不存在的页面 ' + k);
  for (const p of Object.keys(files)) {
    if (/^en\/[^/]+\/\d+\.html$/.test(p) && linked.indexOf(p) < 0) bad.push('页面未出现在门户清单 ' + p);
  }
  if (portalNow.indexOf(MARK_START) < 0) bad.push('门户缺少清单区标记');

  /* 分档切点固定：下面这些边界词是实测确定的。换数据源、改过滤规则、或源文件被
     换掉却没更新 sha256，都会在这里报出来 —— 这是「切点正确」唯一能自动验的形态。 */
  for (const [rank, want] of BOUNDARY) {
    const got = words[rank - 1];
    if (!got) bad.push('词表缺第 ' + rank + ' 位（应为 ' + want + '）');
    else if (got.w !== want) bad.push('分档切点错位：第 ' + rank + ' 位应为 ' + want + '，实为 ' + got.w);
  }
  if (words.length !== meta.totalWords) bad.push('词表条数 ' + words.length + ' 与 meta.totalWords ' + meta.totalWords + ' 不一致');

  /* 单元与词数自洽：位次区间长度 = 词数，且落在 1..PER_UNIT 内，且每词的档位/单元字段与页面相符 */
  for (const u of pageUnits) {
    const n = u.j - u.i + 1;
    const tag = '单元 ' + u.band + '/' + pad(u.unit);
    if (u.to - u.from + 1 !== n) bad.push(tag + ' 位次区间与词数不符');
    if (n < 1 || n > PER_UNIT) bad.push(tag + ' 词数越界：' + n);
    for (let k = u.i; k <= u.j; k++) {
      const w = words[u.from - 1 + (k - u.i)];
      if (!w) { bad.push(tag + ' 取词越界'); break; }
      if (w.unit !== u.unit || w.band !== u.band) {
        bad.push(tag + ' 里的词 ' + w.w + ' 档位/单元字段不符（' + w.band + '/' + w.unit + '）');
        break;
      }
    }
  }

  /* 字段非空率：三样会直接显示在卡面上的东西 */
  const emptyPh = words.filter((w) => !w.ph).length;
  if (emptyPh / words.length > 0.01) bad.push('音标缺失率过高：' + emptyPh + '/' + words.length);
  const emptyTr = words.filter((w) => !w.tr).length;
  if (emptyTr) bad.push('中文释义缺失 ' + emptyTr + ' 条');
  const emptyDef = words.filter((w) => !w.def).length;
  if (emptyDef / words.length > 0.01) bad.push('英文释义缺失率过高：' + emptyDef + '/' + words.length);

  if (bad.length) {
    console.error('校验失败（' + bad.length + ' 项）:');
    for (const x of bad) console.error('  - ' + x);
    process.exit(1);
  }
  console.log('校验通过');
  console.log('  词 ' + meta.totalWords + ' · 单元 ' + meta.totalUnits + ' · 页面 ' + pageUnits.length + ' · 门户清单 ' + linked.length + ' 条');
  for (const b of meta.bands) {
    console.log('  ' + b.label + '  词 ' + b.words + '  单元 ' + b.units + '（' + pad(b.unitFrom) + '–' + pad(b.unitTo) + '）');
  }
  console.log('  切点 ' + BOUNDARY.map(([r, w]) => '#' + r + ' ' + w).join(' / '));
  console.log('  源数据 sha256 ' + (srcIdx < 0 ? '相符' : '已跳过（--src）'));
  console.log('  分档、单元数、页面清单、字段非空率、幂等性均一致');
  process.exit(0);
}

console.error('未知命令：' + cmd + '（可用：gen / check）');
process.exit(2);
