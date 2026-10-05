#!/usr/bin/env node
/* ============================================================================
   英语侧阅读：抓取 + 生成器 + 校验器
   ----------------------------------------------------------------------------
     node tools/en-reading.mjs fetch [--n 60] [--force]   抓候选书到 .scratch 缓存
     node tools/en-reading.mjs gen                        产出 30 篇 / 列表页 / 门户区
     node tools/en-reading.mjs check                      校验（含「再跑一次字节一致」）

   语料：Project Gutenberg（公有领域，须删 header/footer）。
   分档：相对分档，无绝对门槛 —— 逐篇算 cov1k（该篇里排名 ≤1000 的词 token 占比），
   全局排序后均分四段，最易一段归 1k、最难归 4k。理由与实测见
   .scratch/en-module/research/english-data-sources.md §7.5（旧规则「归累计覆盖率
   最高的档」被证伪：累计覆盖率随档单调递增，样本 18 篇全判给 4k）。

   gen 与 check 共用同一个纯函数 build()：build() 返回「相对路径 → 文件内容」的
   完整映射，gen 写盘、check 逐字比对，因此幂等 / 齐全 / 清单一致是同一件事。

   网络只在 fetch 用；gen/check 全走 .scratch 缓存（克隆者按 en/data/README.md
   自行跑一次 fetch）。

   设计依据：.scratch/en-module/PRD.md 决策 D，票 issues/06。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(ROOT, ...p.split('/'));

/* ------------------------------ 常量：语料 ------------------------------- */
const CACHE = '.scratch/en-module/research/pg';
const TOP_URL = 'https://www.gutenberg.org/browse/scores/top';
const TEXT_URL = (id) => 'https://www.gutenberg.org/cache/epub/' + id + '/pg' + id + '.txt';
const UA = { 'User-Agent': 'jlpt-library-en-module/1.0 (offline study site generator)' };

const CSV_PATH = '.scratch/en-module/research/ecdict.csv';
const CSV_SHA = '1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf';
const VOCAB_JS = 'en/data/vocab.js';

/* 篇长：目标约 1,200 词，落在 800–2,000 词内取整段。CHUNK_MAX 是「下一段会超过
   就把当前篇收掉」的阈值（沿用探针 probe-reading-tiers.mjs 的规则），因此实际
   篇长集中在 1,200–1,620；尾部不足 800 词的残篇按决策 12 丢弃。 */
const CHUNK_TARGET = 1200;
const CHUNK_MAX = 1620;
const WORDS_MIN = 800;
const WORDS_MAX = 2000;

/* 四档：分档是相对的，四段均分；每档 6–10 篇，合计 30。篇数按「较易档多一篇」
   分配，保证 1k 段确实是最容易的一段。 */
const BANDS = [
  { id: '1k', label: '1k', take: 8, sub: '最容易的一段' },
  { id: '2k', label: '2k', take: 8, sub: '偏易的一段' },
  { id: '3k', label: '3k', take: 7, sub: '偏难的一段' },
  { id: '4k', label: '4k', take: 7, sub: '最难的一段' }
];
const RANKABLE_TOTAL = 3766;

/* 分档金标准：难度指标必须逐档递减（check 用）。0.5pp 是「四档分明」的最小间隔。 */
const MIN_BAND_GAP = 0.5;

const PORTAL = 'index.html';
const MARK_START = '<!-- en:reading-lists:start -->';
const MARK_END = '<!-- en:reading-lists:end -->';
const MARK_NOTE = '<!-- 以下区块由 tools/en-reading.mjs 生成，勿手改；数据变了请重跑生成器 -->';

/* 门户入口行的编号：英语面两个 feature-block（词表 01、阅读 02）已经各占一个编号，
   所以 .path-list 里的入口行从 03 起顺延。阅读有自已的 feature-block，
   不再在 .path-list 里重复一行；按 href 定位写死，重复跑不会继续加。 */
const PATH_ROWS = [
  ['en/dictation/index.html', '03'],
  ['en/typing/index.html', '04']
];

/* ---------------------------- 词形与释义工具 ----------------------------- */
/* 词形还原：够用即可（同一套候选也用在 reader.js 里，两处必须一致）。 */
function lemmaForms(w) {
  const c = [];
  const add = (x) => { if (x && x.length > 1 && c.indexOf(x) < 0) c.push(x); };
  if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/es$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w)) add(w.slice(0, -1));
  if (/ed$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (/ing$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); }
  if (/ly$/.test(w)) add(w.slice(0, -2));
  return c;
}

/* 英文释义：保留前 3 行、上限 160 字符（同 en-vocab.mjs 的取舍，页面更省）。 */
const DEF_LINES = 3;
const DEF_MAX = 160;
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

function pad(n) { return (n < 10 ? '0' : '') + n; }
function commas(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* 内联进 <script> 的 JSON：转义 < 就足以杜绝 </script> 提前收尾。 */
function jsonIn(x) { return JSON.stringify(x).replace(/</g, '\\u003c'); }

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23b93e28'/%3E%3Ctext x='16' y='23' font-size='19' font-family='serif' fill='%23ffffff' text-anchor='middle'%3E%E8%AA%9E%3C/text%3E%3C/svg%3E";

/* ------------------------------- CSV 索引 -------------------------------- */
/* 一次遍历 ecdict.csv，产出两样东西：
     ranks：word → 1-based 位次（字母 + 中释 + frq>0，按 frq 升序）
     rows ：word → {ph,tr,def,ex}，只为 needed（正文里真正出现过的词）留，省内存。
   ECDICT 的换行在字段里是字面量 \n，字段本身仍可能含逗号与引号，故按引号态走。 */
function readEcdictIndex(csvPath, needed) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rankable = [];
  const rows = new Map();
  let field = '', row = [], inQ = false;
  const endRow = () => {
    row.push(field);
    const w = row[0];
    if (/^[a-z][a-z'-]*$/.test(w)) {
      const frq = +row[9] || 0;
      if (row[3] && frq > 0) rankable.push([frq, w]);
      if (needed.has(w) && row[3]) {
        rows.set(w, { ph: row[1] || '', tr: row[3], def: cleanDef(row[2]), ex: row[10] || '' });
      }
    }
    row = []; field = '';
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

  rankable.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  const ranks = new Map();
  rankable.forEach((r, i) => ranks.set(r[1], i + 1));
  return { ranks, rows, rankableCount: rankable.length };
}

/* 已生成的词表（en/data/vocab.js）：阅读页运行时会加载它，生成器也算同一份，
   两边口径才能一致。格式是 window.EN_VOCAB = {...}; */
function readVocab() {
  const p = rel(VOCAB_JS);
  if (!fs.existsSync(p)) throw new Error('缺少 ' + VOCAB_JS + '（先跑 node tools/en-vocab.mjs gen）');
  const text = fs.readFileSync(p, 'utf8');
  const m = text.match(/window\.EN_VOCAB\s*=\s*(\{[\s\S]*\});\s*$/);
  if (!m) throw new Error(VOCAB_JS + ' 的格式不是预期的 window.EN_VOCAB = {...};');
  const data = JSON.parse(m[1]);
  const byWord = new Map();
  for (const w of data.words) byWord.set(w.w, w);
  return { data, byWord };
}

/* ECDICT 的 exchange 字段（d:worried/p:wore/3:wears/i:wearing）切成候选词形。
   两字母前缀直接切掉，前后两处索引（词表 / 超纲词行）共用同一口径。 */
function formsOf(ex) {
  const out = [];
  for (const p of String(ex || '').split('/')) {
    const t = p.slice(2).trim();
    if (t) out.push(t);
  }
  return out;
}

/* 词形变化反查索引：由词表 ex 字段反推「词形 → 词元」。went 能查到 go、
   running 能查到 run 全靠它（票 06 第 4 级兜底）。必须是**精确**匹配：
   早先写成子串匹配（ex.indexOf(':' + w) >= 0），结果 gif 命中 gifted、
   e’er 切出的 er 命中 eras、chapt. 命中 chapters，把词表里的词硬塞进超纲词典。 */
function formIndex(byWord) {
  const idx = new Map();
  for (const [w, e] of byWord) {
    for (const t of formsOf(e.ex)) if (!idx.has(t)) idx.set(t, w);
  }
  return idx;
}

function rowFormIndex(rows) {
  const idx = new Map();
  for (const [w, e] of rows) {
    for (const t of formsOf(e.ex)) if (!idx.has(t)) idx.set(t, w);
  }
  return idx;
}

/* ------------------------------ 文本切篇 -------------------------------- */
const START_RE = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/;
const END_RE = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/;
const JUNK_RE = /project gutenberg|gutenberg\.org|produced by|transcriber's note|^\s*\[illustration/i;
const HEAD_RE = /^(chapter|part|book|volume|act|scene|letter|preface|contents|index|appendix|introduction)\b/i;

/* 分词：ASCII 字母 + 带变音符的拉丁字母。带变音符的必须算进同一个 token，
   否则 règle 会被切成 r / gle 两个碎片，碎片还会去查词典、混进超纲词表。
   前端的 reader.js 必须用逐字相同的正则（高亮与查义的判据要一致）。 */
const WORDS_RE = /[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'-]*/g;
const wordsOf = (s) => (s.match(WORDS_RE) || []);

function paragraphsOf(body) {
  const out = [];
  for (const raw of body.split(/\n\s*\n/)) {
    /* Gutenberg 用 _下划线_ 标斜体（如 _en règle_）。折掉后正文里不露下划线，
       也免得下划线被连在词上。 */
    const p = raw.replace(/_([^_\n]+)_/g, '$1').replace(/\s+/g, ' ').trim();
    if (!p) continue;
    if (JUNK_RE.test(p)) continue;
    const n = wordsOf(p).length;
    if (n < 6) continue;                       /* 标题行、单句对白碎片 */
    if (HEAD_RE.test(p) && n < 14) continue;   /* Chapter XII 之类的小标题 */
    if (p === p.toUpperCase() && n < 20) continue;
    out.push(p);
  }
  return out;
}

/* 按自然段边界聚合成篇：下一段会越过 CHUNK_MAX 就把当前篇收掉。 */
function chunkParagraphs(paras) {
  const chunks = [];
  let buf = [], n = 0;
  for (const p of paras) {
    const w = wordsOf(p).length;
    if (n && n + w > CHUNK_MAX) { chunks.push(buf.join('\n\n')); buf = []; n = 0; }
    buf.push(p); n += w;
  }
  if (buf.length) chunks.push(buf.join('\n\n'));
  return chunks;
}

/* 难度指标：cov1k / cov2k 用「篇内排名 ≤N 的 token 占比」；OOV 是「不在全表 3,766
   内」的 token 占比（超纲率）。词形先还原再判排名（running 该按 run 算）。 */
function metricsOf(text, ranks) {
  const toks = wordsOf(text).map((w) => w.toLowerCase());
  let c1 = 0, c2 = 0, oov = 0, inList = 0, rankSum = 0;
  for (const t of toks) {
    let r = ranks.get(t);
    if (!r) for (const c of lemmaForms(t)) { const x = ranks.get(c); if (x) { r = x; break; } }
    if (!r) { oov++; continue; }
    inList++; rankSum += r;
    if (r <= 1000) c1++;
    if (r <= 2000) c2++;
  }
  const n = toks.length || 1;
  return {
    words: n,
    cov1k: (c1 / n) * 100,
    cov2k: (c2 / n) * 100,
    oov: (oov / n) * 100,
    meanRank: inList ? rankSum / inList : Infinity
  };
}

/* --------------------------- 从正文到 30 篇 ------------------------------ */
/* 一本文本能不能做语料：剥头尾 → 切自然段 → 丢短段与杂质 → 判语言 → 判散文。
   诗歌、剧本、词典式条目段太短聚不成篇，用中位段长挡；非英语文本用英语功能词
   密度挡（下载榜里有西语版《罪与罚》，只靠字母数认不出来）。 */
function collectChunks(books) {
  const per = [];
  const skipped = { markers: 0, verse: 0, thin: 0, lang: 0 };
  for (const b of books) {
    const raw = fs.readFileSync(rel(CACHE + '/pg' + b.id + '.txt'), 'utf8');
    const s = raw.search(START_RE);
    const e = raw.search(END_RE);
    if (s < 0 || e < 0 || e <= s) { skipped.markers++; continue; }
    const body = raw.slice(raw.indexOf('\n', s) + 1, e);
    if (!looksEnglish(body)) { skipped.lang++; continue; }
    const paras = paragraphsOf(body);
    if (!paras.length) { skipped.thin++; continue; }
    const lens = paras.map((p) => wordsOf(p).length).sort((a, x) => a - x);
    if (lens[Math.floor(lens.length / 2)] < 18) { skipped.verse++; continue; }
    per.push({ book: b, paras, chunks: chunkParagraphs(paras) });
  }
  return { per, skipped };
}

const EN_STOP = /\b(?:the|of|and|to|in|that|it|is|was|for|with|as|his|her|she|he|they|but|not|you|at)\b/gi;
function looksEnglish(text) {
  const n = wordsOf(text).length || 1;
  const hits = (text.match(EN_STOP) || []).length;
  return hits / n >= 0.1;
}

function pickArticles(per, ranks) {
  const pool = [];
  for (const { book, chunks } of per) {
    chunks.forEach((c, i) => {
      const m = metricsOf(c, ranks);
      if (m.words < WORDS_MIN || m.words > WORDS_MAX) return;
      pool.push({
        book, bookChunk: i + 1, text: c, paras: c.split(/\n\n/),
        words: m.words, cov1k: m.cov1k, cov2k: m.cov2k, oov: m.oov, meanRank: m.meanRank
      });
    });
  }
  /* 全局排序：cov1k 降序（越高越简单），cov2k 作二级；末级用书号与段号定序，
     保证同样输入永远给出同样结果。 */
  pool.sort((a, b) =>
    b.cov1k - a.cov1k || b.cov2k - a.cov2k ||
    a.book.id - b.book.id || a.bookChunk - b.bookChunk);

  const q = Math.floor(pool.length / BANDS.length);
  const used = new Set();
  const picked = [];
  BANDS.forEach((band, bi) => {
    const seg = pool.slice(bi * q, bi === BANDS.length - 1 ? pool.length : (bi + 1) * q);
    const step = Math.max(1, Math.floor(seg.length / band.take));
    const chosen = [];
    for (let k = 0; k < seg.length && chosen.length < band.take; k += step) {
      const a = seg[k];
      if (used.has(a.book.id)) continue;
      used.add(a.book.id);
      chosen.push(a);
    }
    /* 段内可用书不够（同书多篇挤在一档）时，回头补扫，仍然一书只取一篇 */
    for (let k = 0; k < seg.length && chosen.length < band.take; k++) {
      const a = seg[k];
      if (used.has(a.book.id)) continue;
      used.add(a.book.id);
      chosen.push(a);
    }
    if (chosen.length < band.take) {
      throw new Error('候选篇数不够：' + band.label + ' 段只凑到 ' + chosen.length +
        ' 篇（要 ' + band.take + '）——候选书太少或过滤太严？');
    }
    chosen.forEach((a, k) => { a.band = band.id; a.no = k + 1; });
    picked.push(...chosen);
  });

  return { pool, picked };
}


/* ------------------------------ 超纲词词典 ------------------------------- */
/* 每篇内联一份「浏览器查不到的词的释义」。判据与 reader.js 全一致：
   先在词表（3,766）里查 → 词形还原 → 词形变化反查；都查不到的词，才落进词典。
   只出现大写形式的词（Alice / Holmes / London）当作专有名词，不入词典也不高亮
   —— 否则点名字会弹出「女子名」这种东西，票 06 要的是「点了什么都不弹」。 */
function buildGloss(article, ctx) {
  const collect = new Map();   /* token → 出现次数 */
  let proper = new Set();
  for (const p of article.paras) {
    for (const t of wordsOf(p)) {
      const low = t.toLowerCase();
      collect.set(low, (collect.get(low) || 0) + 1);
      if (t === low) proper.add(low);   /* 至少出现过一次小写 → 不是专有名词 */
    }
  }
  const gloss = {};
  const oovTypes = [];
  const unresolved = [];
  for (const [w, count] of collect) {
    const r = resolve(w, ctx, {});
    if (r) continue;                 /* 词表能查到的词不进词典 */
    if (!proper.has(w)) continue;    /* 只大写出现 = 专有名词，跳过 */
    oovTypes.push(w);
    let hit = null;
    const cands = [w].concat(lemmaForms(w));
    for (const c of cands) {
      if (ctx.rows.has(c)) { hit = c; break; }
    }
    if (!hit) hit = ctx.rowForms.get(w) || null;
    if (!hit) { unresolved.push(w); continue; }
    if (!gloss[hit]) {
      const v = ctx.rows.get(hit);
      gloss[hit] = { ph: v.ph, tr: v.tr, def: v.def, ex: v.ex };
    }
  }
  return { gloss, oovTypes: oovTypes.sort(), unresolved: unresolved.sort() };
}

/* 浏览器端（reader.js）与生成器共用的四段兜底：
     1 小写词形命中（词表）      2 词形还原后重试（词表 / 超纲词典）
     3 词形变化反查（词表）      4 查不到 → 返回 null（页面什么都不弹）
   第 2 段要同时看词表和本篇词典，所以 gloss 作为参数传进来。 */
function resolve(token, ctx, gloss) {
  const w = String(token || '').toLowerCase();
  if (!w) return null;
  const inVocab = ctx.byWord.get(w);
  if (inVocab) return inVocab;
  const inGloss = gloss[w];
  if (inGloss) return inGloss;
  for (const c of lemmaForms(w)) {
    const v = ctx.byWord.get(c) || gloss[c];
    if (v) return v;
  }
  const base = ctx.forms.get(w);
  if (base) {
    const v = ctx.byWord.get(base) || gloss[base];
    if (v) return v;
  }
  return null;
}

/* 高亮集合：词表查不到（= 超出四档 3,766 词）且不是专有名词的 token。 */
function oovSetOf(article, ctx, gloss) {
  const proper = new Set();
  const all = new Map();
  for (const p of article.paras) {
    for (const t of wordsOf(p)) {
      const low = t.toLowerCase();
      all.set(low, 1);
      if (t === low) proper.add(low);
    }
  }
  const out = [];
  for (const w of all.keys()) {
    if (!proper.has(w)) continue;
    if (resolve(w, ctx, {})) continue;      /* 只看词表：词表能查就不算超纲 */
    out.push(w);
  }
  return out.sort();
}

/* --------------------------------- 构建 ---------------------------------- */
function build() {
  /* 1. 缓存清单 */
  const candPath = rel(CACHE + '/candidates.json');
  if (!fs.existsSync(candPath)) {
    throw new Error('缺少候选书清单 ' + CACHE + '/candidates.json\n' +
      '先联网跑一次：node tools/en-reading.mjs fetch');
  }
  const books = JSON.parse(fs.readFileSync(candPath, 'utf8'));
  const missing = books.filter((b) => !fs.existsSync(rel(CACHE + '/pg' + b.id + '.txt')));
  if (missing.length) {
    throw new Error('缓存里缺 ' + missing.length + ' 本书的正文（如 pg' + missing[0].id + '.txt）\n' +
      '先联网跑一次：node tools/en-reading.mjs fetch');
  }

  /* 2. 词表、正文分块、CSV 索引 */
  const vocab = readVocab();
  const ctx = { byWord: vocab.byWord, forms: null, rows: null, ranks: null };
  ctx.forms = formIndex(ctx.byWord);

  const loaded = collectChunks(books);
  if (!loaded.per.length) throw new Error('缓存里的书一本都没过筛（header/footer 标记不对？）');

  /* 先扫正文收集「需要释义的词」，再走 CSV —— 65.9MB 只过一次，且内存只留用得上的 */
  const need = new Set();
  for (const { chunks } of loaded.per) {
    for (const c of chunks) {
      for (const t of wordsOf(c)) {
        const low = t.toLowerCase();
        need.add(low);
        for (const x of lemmaForms(low)) need.add(x);
      }
    }
  }

  const csv = readEcdictIndex(rel(CSV_PATH), need);
  if (csv.rankableCount < RANKABLE_TOTAL) {
    throw new Error('可排名词只有 ' + csv.rankableCount + ' 个（应为 ' + RANKABLE_TOTAL + '）——源文件不对？');
  }
  ctx.rows = csv.rows;
  ctx.ranks = csv.ranks;
  ctx.rowForms = rowFormIndex(csv.rows);

  /* 3. 切篇、分档 */
  const { pool, picked } = pickArticles(loaded.per, csv.ranks);
  const skipped = loaded.skipped;

  /* 4. 逐篇装配：超纲词典、高亮集、显示用的难度 */
  for (const a of picked) {
    const g = buildGloss(a, ctx);
    a.gloss = g.gloss;
    a.oovTypes = g.oovTypes;
    a.unresolved = g.unresolved;
  }

  /* 5. 输出文件 */
  const files = {};
  const bandsOut = BANDS.map((band) => {
    const arts = picked.filter((a) => a.band === band.id).sort((x, y) => x.no - y.no);
    return {
      id: band.id, label: band.label, sub: band.sub,
      count: arts.length,
      words: arts.reduce((n, a) => n + a.words, 0),
      cov1k: arts.reduce((n, a) => n + a.cov1k, 0) / (arts.length || 1),
      oov: arts.reduce((n, a) => n + a.oov, 0) / (arts.length || 1),
      articles: arts.map((a) => ({
        id: a.band + '-' + pad(a.no), band: a.band, no: a.no,
        bookId: a.book.id, title: a.book.title, author: a.book.author,
        words: a.words, cov1k: +a.cov1k.toFixed(1), cov2k: +a.cov2k.toFixed(1),
        oov: +a.oov.toFixed(1), oovTypes: a.oovTypes.length,
        marked: a.oovTypes.length - a.unresolved.length, missing: a.unresolved.length,
        glossCount: Object.keys(a.gloss).length
      }))
    };
  });

  const meta = {
    source: 'Project Gutenberg',
    license: 'Public Domain',
    url: 'https://www.gutenberg.org/',
    listUrl: TOP_URL,
    count: picked.length,
    candCount: books.length,
    chunkTarget: CHUNK_TARGET,
    bands: bandsOut
  };
  meta.generated = crypto.createHash('sha256')
    .update(JSON.stringify(bandsOut)).digest('hex').slice(0, 16);

  for (const a of picked) files['en/reading/' + a.band + '/' + pad(a.no) + '.html'] = articlePage(a);
  files['en/reading/index.html'] = listPage(meta);
  files['__portal_region__'] = portalRegion(meta);

  return { files, meta, ctx, picked, pool, skipped, books };
}

/* -------------------------------- 页面模板 ------------------------------- */
function articlePage(a) {
  const key = 'en/reading/' + a.band + '/' + pad(a.no) + '.html';
  const title = a.book.title + ' · 第 ' + a.no + ' 篇 · 英语阅读 · Language Library';
  const payload = {
    id: a.band + '-' + pad(a.no),
    band: a.band,
    no: a.no,
    bookId: a.book.id,
    title: a.book.title,
    author: a.book.author,
    words: a.words,
    cov1k: +a.cov1k.toFixed(1),
    oov: +a.oov.toFixed(1),
    oovTypes: a.oovTypes.length,
    missing: a.unresolved.length,
    paras: a.paras,
    gloss: a.gloss
  };
  const desc = '英语阅读 ' + a.band + ' 档第 ' + a.no + ' 篇：《' + a.book.title + '》' +
    '（' + commas(a.words) + ' 词，超纲 ' + (a.oovTypes.length - a.unresolved.length) + ' 词），点词查义、超纲词高亮。';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="../../../assets/style.css">
<link rel="stylesheet" href="../../unit.css">
<link rel="stylesheet" href="../../reader.css">
<script src="../../../assets/theme.js"></script>
</head>
<body>
<div class="en-wrap">
  <nav class="en-crumb">
    <a href="../../../index.html">资料库首页</a>
    <span class="en-crumb-sep">／</span>
    <a href="../index.html">英语阅读</a>
    <span class="en-crumb-sep">／</span>
    <span>${esc(a.band)} · ${pad(a.no)}</span>
  </nav>

  <main class="en-read" id="enRead">
    <noscript><p class="en-empty">本页的点词查义需要 JavaScript；正文可以直接阅读。</p></noscript>
  </main>
</div>

<script src="../../data/vocab.js"></script>
<script>window.EN_ARTICLE = ${jsonIn(payload)};</script>
<script src="../../../assets/progress.js"></script>
<script src="../../reader.js"></script>
</body>
</html>
`;
}

function artRows(meta, prefixFor) {
  return meta.bands.map((b) => {
    const rows = b.articles.map((a) => {
      const key = 'en/reading/' + b.id + '/' + pad(a.no) + '.html';
      return `            <li><a class="en-unit-row" href="${prefixFor}${key.replace('en/reading/', '')}" data-en-key="${key}">` +
        `<span class="en-u-no">${pad(a.no)}</span>` +
        `<span class="en-u-range">${commas(a.words)} 词 · 1k ${a.cov1k.toFixed(1)}%</span>` +
        `</a></li>`;
    }).join('\n');
    return `        <details class="en-band" id="en-read-${b.id}" data-en-band="${b.id}">
          <summary>
            <span class="en-band-id">${esc(b.label)}</span>
            <span class="en-band-sub">${esc(b.sub)} · 1k 覆盖 ${b.cov1k.toFixed(1)}%</span>
            <span class="en-band-prog" data-en-prog>已读 0/${b.count}</span>
          </summary>
          <ul class="en-unit-list">
${rows}
          </ul>
        </details>`;
  }).join('\n');
}

function portalRegion(meta) {
  const stations = meta.bands.map((b) =>
    `          <a class="ruler-station" href="#en-read-${b.id}"><span class="ruler-lv">${esc(b.label)}</span>` +
    `<span class="ruler-count">${b.count} 篇</span></a>`).join('\n');
  const totalWords = meta.bands.reduce((n, b) => n + b.words, 0);
  return `      <section class="feature-block" aria-labelledby="en-reading-title">
        <span class="feature-index" aria-hidden="true">02</span>
        <h3 id="en-reading-title" class="feature-title">阅读精读</h3>
        <p class="feature-lede">公有领域短文按超纲词比例自动分档，篇幅与词表单元相当。点词查义、超纲词高亮，读完手动盖章。</p>

        <nav class="ruler" aria-label="阅读档位">
${stations}
        </nav>

        <div class="en-bands" data-en-bands>
${artRows(meta, 'en/reading/')}
        </div>

        <div class="feature-foot">
          <a class="feature-cta" href="en/reading/index.html">进入阅读 <span aria-hidden="true">→</span></a>
          <span class="feature-stats">${meta.count} 篇 · ${meta.bands.length} 档 · ${commas(totalWords)} 词 · 文本来自 Project Gutenberg</span>
        </div>
      </section>`;
}

function listPage(meta) {
  const totalWords = meta.bands.reduce((n, b) => n + b.words, 0);
  const groups = meta.bands.map((b) => {
    const rows = b.articles.map((a) => `        <li>
          <a class="en-art-row" href="${b.id}/${pad(a.no)}.html" data-en-key="en/reading/${b.id}/${pad(a.no)}.html">
            <span class="en-art-title" lang="en">${esc(a.title)}</span>
            <span class="en-art-by">${esc(a.author)}</span>
            <span class="en-art-meta">${commas(a.words)} 词 · 超纲 ${a.marked} 词 · 1k 覆盖 ${a.cov1k.toFixed(1)}%</span>
          </a>
        </li>`).join('\n');
    return `    <section class="en-band-block">
      <h2 class="en-band-h"><span class="en-band-id">${esc(b.label)}</span> ${esc(b.sub)}
        <span class="en-band-count">${b.count} 篇 · 平均 ${commas(Math.round(b.words / b.count))} 词 · 平均 1k 覆盖 ${b.cov1k.toFixed(1)}%</span></h2>
      <ul class="en-art-list">
${rows}
      </ul>
    </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>英语阅读 · 分档短文 · Language Library</title>
<meta name="description" content="英语阅读：${meta.count} 篇公有领域短文按超纲词比例分四档，点词查义、超纲词高亮，读完手动盖章。">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="../../assets/style.css">
<link rel="stylesheet" href="../unit.css">
<link rel="stylesheet" href="../reader.css">
<script src="../../assets/theme.js"></script>
</head>
<body>
<div class="en-wrap">
  <nav class="en-crumb">
    <a href="../../index.html">资料库首页</a>
    <span class="en-crumb-sep">／</span>
    <a href="../../index.html#en-reading-title">英语阅读</a>
    <span class="en-crumb-sep">／</span>
    <span>篇目</span>
  </nav>

  <main class="en-read-index" id="enReadIndex">
    <div class="en-head">
      <p class="en-eyebrow">英语阅读 · 分档短文</p>
      <h1 class="en-title">按超纲词比例分档的 ${meta.count} 篇</h1>
      <p class="en-sub">${meta.bands.length} 档 · ${commas(totalWords)} 词 · 文本来自 Project Gutenberg（公有领域）</p>
      <p class="en-note">分档不含任何绝对门槛：每篇算「篇内排名前 1000 的词」的占比，
        全局排序后均分四段 —— 最易一段是 1k，最难一段是 4k。</p>
      <p class="en-meters">
        <span class="en-meter" id="enReadDone">已读 0/${meta.count}</span>
      </p>
    </div>
${groups}
  </main>
</div>

<script src="../../assets/progress.js"></script>
<script src="../reader.js"></script>
</body>
</html>
`;
}

/* ------------------------------ 门户注入 -------------------------------- */
function splicePortal(region) {
  const p = rel(PORTAL);
  const html = fs.readFileSync(p, 'utf8');
  const i = html.indexOf(MARK_START);
  const j = html.indexOf(MARK_END);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(PORTAL + ' 里找不到标记区 ' + MARK_START + ' … ' + MARK_END +
      '（门户的阅读清单区由本脚本维护，请先补上标记）');
  }
  const head = html.slice(0, i);
  const tail = html.slice(j + MARK_END.length);
  return head + MARK_START + '\n      ' + MARK_NOTE + '\n' + region + '\n    ' + MARK_END + tail;
}

/* 入口行编号顺延到 03/04/05：按 href 定位，重复跑不再加。 */
function renumberRows(html) {
  let out = html;
  for (const [href, no] of PATH_ROWS) {
    const at = out.indexOf('<a class="path-row" href="' + href + '">');
    if (at < 0) throw new Error('门户里找不到入口行 href="' + href + '"');
    const j = out.indexOf('row-index', at);
    const k = out.indexOf('>', j) + 1;
    const e = out.indexOf('</span>', k);
    if (j < 0 || k <= 0 || e < 0) throw new Error('入口行 ' + href + ' 的 row-index 结构不对');
    out = out.slice(0, k) + no + out.slice(e);
  }
  return out;
}

function transformPortal(region) { return renumberRows(splicePortal(region)); }

/* --------------------------- 内容门槛（目录） ---------------------------- */
/* 语料只取「英语小说 / 故事」：题材与语言取自 Gutenberg 目录 pg_catalog.csv
   （21MB，含 Title/Language/Authors/Subjects/Bookshelves），比标题黑名单可靠。
   另外用作者卒年挡掉古英语与韵文译本 —— 按词频看很简单的 16 世纪散文，
   对 1k 档其实是最难读的。判据都在 fetch 阶段用一次，正文缓存里只留过关的书。 */
const CATALOG = '.scratch/en-module/research/pg_catalog.csv';
const SHELF_OK = [
  'Category: Novels', 'Category: Short Stories', 'Category: Adventure', 'Category: Romance',
  'Category: Crime, Thrillers and Mystery', 'Category: Science-Fiction & Fantasy',
  'Category: Historical Novels', 'Category: Humour', 'Category: Children & Young Adult Reading',
  'Category: Classics of Literature', 'Mystery Fiction', 'Detective Fiction', 'Horror',
  'Gothic Fiction', 'Fantasy', 'Science Fiction', "Children's Literature", 'Best Books Ever Listings'
];
const SHELF_BAD = [
  'Erotic Fiction', 'Poetry', 'Plays', 'Drama', 'Biographies', 'Essays, Letters', 'Encyclopedias',
  'Dictionaries', 'Reference', 'Category: History', 'Sociology', 'Religion', 'Philosophy',
  'Travel Writing', 'How To', 'Periodicals', 'Journals', 'Science - ', 'Art', 'Music', 'Cookery'
];
const MIN_DEATH = 1800;
/* 标题露骨的书不进语料：列表页要把书名摊给读者看，正文扫过没问题也挡
   （例：The Sex Life of the Gods —— 1934 年的讽刺科幻，内容不黄，但书名不能挂在学习站上）。 */
const TITLE_BAD = /\b(?:sex|sexual|erotic|erotica|kama|sutra|orgy|porn|nude|naked|brothel)\b/i;

/* CSV 解析：字段可能被引号包住、里面还有逗号与换行（目录里有这种行）。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function catalogIndex() {
  const p = rel(CATALOG);
  if (!fs.existsSync(p)) throw new Error('缺少 Gutenberg 目录 ' + CATALOG + '\n' +
    '下载：curl -L -o ' + CATALOG + ' https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv');
  const rows = parseCsv(fs.readFileSync(p, 'utf8'));
  const head = rows[0];
  const col = (name) => head.indexOf(name);
  const [cId, cTitle, cLang, cAuthors, cSubj, cShelf] = ['Text#', 'Title', 'Language', 'Authors', 'Subjects', 'Bookshelves'].map(col);
  const byId = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 5) continue;
    byId.set(Number(r[cId]), {
      id: Number(r[cId]), title: r[cTitle], lang: (r[cLang] || '').trim(),
      authors: r[cAuthors] || '', subjects: r[cSubj] || '', shelves: r[cShelf] || ''
    });
  }
  return byId;
}

/* 作者卒年：目录里形如「Melville, Herman, 1819-1891」，取字符串里最大的四位年份。
   只看第一作者：目录会给古书挂上现代的编者/贡献者（Sidney 1554-1586 那本挂着
   1869-1941 的编者），连编者一起算就把古书当现代书放行了。
   没有年份（Homer / 12 世纪诗人 / 无名氏）一律当成太老。 */
function deathYear(authors) {
  const first = String(authors).split(';')[0];
  const ys = first.match(/\b1[0-9]{3}\b|\b20[0-9]{2}\b/g);
  return ys && ys.length ? Math.max.apply(null, ys.map(Number)) : 0;
}

const titleKey = (s) => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').replace(/^(the|a|an) /, '').trim();

function screenCandidates(cands) {
  const cat = catalogIndex();
  const drops = { miss: 0, lang: 0, shelf: 0, title: 0, era: 0, dup: 0 };
  const seen = new Map();
  const kept = [];
  for (const c of cands) {
    const m = cat.get(c.id);
    if (!m) { drops.miss++; continue; }
    if (m.lang !== 'en') { drops.lang++; continue; }
    const bad = SHELF_BAD.some((s) => m.shelves.indexOf(s) >= 0 || m.subjects.indexOf(s) >= 0);
    const ok = SHELF_OK.some((s) => m.shelves.indexOf(s) >= 0);
    if (bad || !ok) { drops.shelf++; continue; }
    if (TITLE_BAD.test(m.title)) { drops.title++; continue; }
    if (deathYear(m.authors) < MIN_DEATH) { drops.era++; continue; }
    const key = titleKey(m.title) + '|' + titleKey(String(m.authors).split(/[,;(]/)[0]);
    if (seen.has(key)) { drops.dup++; continue; }
    seen.set(key, c.id);
    kept.push({ id: c.id, title: c.title, author: c.author, shelves: m.shelves });
  }
  return { kept, drops };
}

/* ---------------------------------- fetch -------------------------------- */
async function get(url, asText) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

async function cmdFetch(n, force) {
  fs.mkdirSync(rel(CACHE), { recursive: true });
  const topPath = rel(CACHE + '/top.html');
  let top;
  if (fs.existsSync(topPath) && !force) {
    top = fs.readFileSync(topPath, 'utf8');
    console.log('复用 ' + CACHE + '/top.html');
  } else {
    top = await get(TOP_URL, true);
    fs.writeFileSync(topPath, top);
    console.log('已下载榜单页 ' + TOP_URL + '（' + top.length + ' 字节）');
  }

  /* 榜单页第一条列表 = Top 100 EBooks yesterday：<li><a href="/ebooks/2701">Title by Author (7134)</a></li> */
  const re = /<li><a href="\/ebooks\/(\d+)">([^<]{1,160})<\/a><\/li>/g;
  const cands = [];
  let m;
  while ((m = re.exec(top)) && cands.length < n) {
    const id = +m[1];
    let t = m[2].replace(/\s+/g, ' ').trim().replace(/\s*\(\d+\)$/, '');
    let author = '';
    const by = t.lastIndexOf(' by ');
    if (by > 0) { author = t.slice(by + 4).trim(); t = t.slice(0, by).trim(); }
    if (cands.some((c) => c.id === id)) continue;
    cands.push({ id, title: t, author });
  }
  console.log('候选书 ' + cands.length + ' 本（下载榜前 ' + cands.length + '）');

  const screened = screenCandidates(cands);
  const d = screened.drops;
  const cands2 = screened.kept;
  console.log('内容门槛：留 ' + cands2.length + ' 本（目录缺 ' + d.miss + ' · 非英语 ' + d.lang +
    ' · 题材不合 ' + d.shelf + ' · 标题露骨 ' + d.title + ' · 卒年早于 ' + MIN_DEATH + ' 的 ' + d.era + ' · 重复 ' + d.dup + '）');

  const queue = cands2.slice();
  const done = { ok: 0, skip: 0, fail: 0 };
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      const p = rel(CACHE + '/pg' + c.id + '.txt');
      if (fs.existsSync(p) && !force) { done.skip++; continue; }
      try {
        const buf = await get(TEXT_URL(c.id), false);
        fs.writeFileSync(p, buf);
        done.ok++;
        process.stdout.write('  ✓ pg' + c.id + ' ' + c.title.slice(0, 48) + '（' + (buf.length / 1024 | 0) + ' KB）\n');
      } catch (e) {
        done.fail++;
        process.stdout.write('  ✗ pg' + c.id + ' ' + c.title.slice(0, 48) + ' —— ' + e.message + '\n');
        c.failed = true;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const kept = cands2.filter((c) => !c.failed);
  fs.writeFileSync(rel(CACHE + '/candidates.json'), JSON.stringify(kept, null, 1) + '\n');
  console.log('正文缓存：新下 ' + done.ok + ' 本 / 已有 ' + done.skip + ' 本 / 失败 ' + done.fail + ' 本');
  console.log('候选清单 ' + CACHE + '/candidates.json（' + kept.length + ' 本）');
}

/* ---------------------------------- 命令 --------------------------------- */
const argv = process.argv.slice(2);
const cmd = argv[0] || 'gen';
const force = argv.indexOf('--force') >= 0;
const nIdx = argv.indexOf('--n');
const nTop = nIdx >= 0 ? (+argv[nIdx + 1] || 200) : 200;

if (cmd === 'fetch') {
  await cmdFetch(nTop, force);
  process.exit(0);
}

const built = build();
const REGION = built.files.__portal_region__;
delete built.files.__portal_region__;

const portalPath = rel(PORTAL);
const portalNow = fs.readFileSync(portalPath, 'utf8');
const portalNext = transformPortal(REGION);
const all = Object.assign({}, built.files, { [PORTAL]: portalNext });

const shaOk = () => crypto.createHash('sha256').update(fs.readFileSync(rel(CSV_PATH))).digest('hex') === CSV_SHA;

if (cmd === 'gen') {
  for (const p of Object.keys(all)) {
    const target = rel(p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, all[p]);
  }
  let bytes = 0;
  for (const p of Object.keys(all)) bytes += Buffer.byteLength(all[p]);
  console.log('已生成 ' + Object.keys(all).length + ' 个文件（' + (bytes / 1024).toFixed(0) + ' KB）');
  console.log('篇 ' + built.meta.count + ' · 档 ' + built.meta.bands.length + ' · 指纹 ' + built.meta.generated);
  for (const b of built.meta.bands) {
    console.log('  ' + b.label + '  ' + b.count + ' 篇  平均 ' + (b.words / b.count).toFixed(0) +
      ' 词  cov1k ' + b.cov1k.toFixed(1) + '%  超纲 ' + b.oov.toFixed(1) + '%');
  }
  const sk = built.skipped;
  console.log('候选书 ' + built.meta.candCount + ' 本：用过 ' +
    new Set(built.picked.map((a) => a.book.id)).size + ' 本 · 过筛 ' +
    (built.meta.candCount - sk.markers - sk.verse - sk.thin - sk.lang) + ' 本 · 无标记 ' + sk.markers +
    ' · 非英语 ' + sk.lang + ' · 疑似诗歌剧本 ' + sk.verse + ' · 切不出篇 ' + sk.thin);
  console.log('可挑选篇池 ' + built.pool.length + ' 篇（' + WORDS_MIN + '–' + WORDS_MAX + ' 词）');
  process.exit(0);
}

if (cmd === 'check') {
  const bad = [];
  if (!shaOk()) bad.push('源数据 sha256 与台账不符（' + CSV_PATH + '）');
  for (const p of Object.keys(all)) {
    const target = rel(p);
    if (!fs.existsSync(target)) { bad.push('缺失 ' + p); continue; }
    if (fs.readFileSync(target, 'utf8') !== all[p]) bad.push('内容不一致 ' + p);
  }

  /* 反向：en/reading/<档>/ 下多出来的孤儿页 */
  const expect = new Set(Object.keys(built.files));
  for (const b of BANDS) {
    const dir = rel('en/reading/' + b.id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.html$/.test(f)) continue;
      const p = 'en/reading/' + b.id + '/' + f;
      if (!expect.has(p)) bad.push('多余页面 ' + p);
    }
  }

  /* 篇数 / 篇长 / 分档分明 / 一篇只归一档 */
  const arts = built.picked;
  if (arts.length !== 30) bad.push('篇数 ' + arts.length + '（应为 30）');
  for (const b of built.meta.bands) {
    if (b.count < 6 || b.count > 10) bad.push(b.label + ' 档篇数越界：' + b.count);
  }
  const seenText = new Set();
  const seenBook = new Set();
  for (const a of arts) {
    const tag = a.band + '/' + pad(a.no);
    if (a.words < WORDS_MIN || a.words > WORDS_MAX) bad.push(tag + ' 篇长越界：' + a.words);
    const fp = crypto.createHash('sha1').update(a.text).digest('hex');
    if (seenText.has(fp)) bad.push(tag + ' 与另一篇正文完全相同');
    seenText.add(fp);
    if (seenBook.has(a.book.id)) bad.push(tag + ' 与另一篇取自同一本书（pg' + a.book.id + '）');
    seenBook.add(a.book.id);
    if (!Object.keys(a.gloss).length) bad.push(tag + ' 的超纲词典是空的');
    if (!/^\d{1,7}$/.test(String(a.book.id))) bad.push(tag + ' 的书号可疑：' + a.book.id);
  }
  const ordered = built.meta.bands.map((b) => b.cov1k);
  for (let i = 1; i < ordered.length; i++) {
    if (!(ordered[i - 1] - ordered[i] > MIN_BAND_GAP)) {
      bad.push('分档不分明：' + built.meta.bands[i - 1].label + ' ' + ordered[i - 1].toFixed(1) +
        '% 与 ' + built.meta.bands[i].label + ' ' + ordered[i].toFixed(1) + '% 相差不足 ' + MIN_BAND_GAP + 'pp');
    }
  }

  /* 超纲词典口径：每个词条都得能在 ECDICT 里查到，且确实查不到于词表 */
  for (const a of arts) {
    const tag = a.band + '/' + pad(a.no);
    for (const w of Object.keys(a.gloss)) {
      const v = built.ctx.rows.get(w);
      if (!v) { bad.push(tag + ' 词典里的 ' + w + ' 不在 ECDICT 索引里'); break; }
      if (built.ctx.byWord.has(w)) { bad.push(tag + ' 词典里的 ' + w + ' 其实词表里就有'); break; }
      if (!v.tr) { bad.push(tag + ' 词典里的 ' + w + ' 没有中文释义'); break; }
    }
    /* 正文里不许有中文（票 06：不做全文中文翻译） */
    for (const p of a.paras) {
      if (/[\u4e00-\u9fff]/.test(p)) { bad.push(tag + ' 的正文含中文字符'); break; }
    }
    /* 高亮集：不能含专有名词，也不能含词表里有的词 */
    const proper = new Set();
    const low = new Set();
    for (const p of a.paras) {
      for (const t of wordsOf(p)) {
        if (t === t.toLowerCase()) proper.add(t.toLowerCase());
        low.add(t.toLowerCase());
      }
    }
    for (const w of a.oovTypes) {
      if (!proper.has(w)) { bad.push(tag + ' 高亮集里 ' + w + ' 只以大写出现（应视作专有名词）'); break; }
      if (built.ctx.byWord.has(w)) { bad.push(tag + ' 高亮集里 ' + w + ' 词表里有'); break; }
    }
  }

  /* 清单 ≡ 文件：门户区与阅读列表页里的 data-en-key 必须与产出页面一一对应 */
  const linked = [];
  const reKey = /data-en-key="([^"]+)"/g;
  let m2;
  while ((m2 = reKey.exec(REGION))) linked.push(m2[1]);
  const pageList = Object.keys(built.files).filter((p) => /^en\/reading\/[1-4]k\/\d+\.html$/.test(p));
  if (linked.length !== pageList.length) bad.push('门户清单 ' + linked.length + ' 条 ≠ 页面 ' + pageList.length + ' 个');
  for (const k of linked) if (!built.files[k]) bad.push('门户清单指向不存在的页面 ' + k);
  for (const p of pageList) if (linked.indexOf(p) < 0) bad.push('页面未出现在门户清单 ' + p);
  const listHtml = built.files['en/reading/index.html'];
  for (const p of pageList) {
    const k = p.replace('en/reading/', '');
    if (listHtml.indexOf('data-en-key="' + p + '"') < 0) bad.push('列表页缺少 ' + k);
  }

  /* 每一行的 href 都必须真的指到那一页
     （票 09 抓到的真 bug：门户区 artRows 漏了 'en/reading/' 前缀，30 条链接全成 /1k/01.html） */
  for (const [text, base] of [[REGION, ''], [listHtml, 'en/reading/']]) {
    const reRow = /<a class="en-(?:unit|art)-row" href="([^"]+)" data-en-key="([^"]+)"/g;
    let m3;
    while ((m3 = reRow.exec(text))) {
      if (base + m3[1] !== m3[2]) {
        bad.push('行 href 与键不一致：href=' + m3[1] + ' 应写成 ' + m3[2].replace(base, '') + '（基准 ' + (base || '门户根') + '）');
      } else if (!fs.existsSync(rel(m3[2]))) {
        bad.push('行 href 不可达：' + m3[2]);
      }
    }
  }
  if (portalNext.indexOf(MARK_START) < 0) bad.push('门户缺少阅读清单区标记');
  for (const [href, no] of PATH_ROWS) {
    const at = portalNext.indexOf('<a class="path-row" href="' + href + '">');
    const seg = portalNext.slice(at, at + 220);
    if (at < 0 || seg.indexOf('>' + no + '<') < 0) bad.push('入口行 ' + href + ' 的编号不是 ' + no);
  }

  if (bad.length) {
    console.error('校验失败（' + bad.length + ' 项）:');
    for (const x of bad) console.error('  - ' + x);
    process.exit(1);
  }
  console.log('校验通过');
  console.log('  篇 ' + built.meta.count + ' · 文件 ' + Object.keys(all).length + ' · 门户清单 ' + linked.length + ' 条 · 指纹 ' + built.meta.generated);
  for (const b of built.meta.bands) {
    console.log('  ' + b.label + '  ' + b.count + ' 篇  平均 ' + (b.words / b.count).toFixed(0) +
      ' 词  cov1k ' + b.cov1k.toFixed(1) + '%  超纲 ' + b.oov.toFixed(1) + '%');
  }
  console.log('  篇长 ' + Math.min(...arts.map((a) => a.words)) + '–' + Math.max(...arts.map((a) => a.words)) + ' 词（要求 ' + WORDS_MIN + '–' + WORDS_MAX + '）');
  console.log('  一书一篇：' + seenBook.size + ' 本不同的书');
  console.log('  源数据 sha256 相符 · 幂等性、篇长、分档分明、词典口径均一致');
  process.exit(0);
}

console.error('未知命令：' + cmd + '（可用：fetch / gen / check）');
process.exit(2);
