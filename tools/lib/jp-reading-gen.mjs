/* ============================================================================
   日语阅读 · 页面生成（gen）

   分工：`tools/jp-reading.mjs` 只做命令分发与 fetch；这里负责
   「缓存正文 + 注释真源 → 页面载荷 → HTML」。

   判据只在这一处：切词、词条表、非高频词集合都在生成时算完，写成 data-l / data-o。
   视图层（reading/reading.js）只照着渲染，不再做第二次判断 ——
   这条不变量由 check 的「页面高亮词数 ≡ 载荷 oov」断言钉住。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { writePreservingEol } from './eol.mjs';
import { buildLexicon, segment, parseInline, paragraphsOf, displayEntry } from './katsuyo.mjs';
import { railHtml, prefixOf, activeOf } from '../shell.mjs';
import { FAVICON } from '../brand.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 共享中文词表（reading/data/zh-gloss.json，键＝辞書形）。缺文件就当空表，不阻止生成。 */
export function loadZhGloss(root) {
  const f = path.join(root, 'reading', 'data', 'zh-gloss.json');
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error('reading/data/zh-gloss.json 不是合法 JSON：' + e.message);
  }
}

const ESC_CLOSE = '<' + String.fromCharCode(92) + '/';

/** 从已生成的页面里读回载荷（--only 重跑篇目页时要用，也供 check 使用） */
export function readPayload(file) {
  const html = fs.readFileSync(file, 'utf8');
  const at = html.indexOf('window.JP_READING = ');
  if (at < 0) throw new Error('页面里没有 window.JP_READING：' + file);
  const start = at + 'window.JP_READING = '.length;
  const end = html.indexOf('</script>', start);
  let raw = html.slice(start, end).trim();
  if (raw.endsWith(';')) raw = raw.slice(0, -1);
  return JSON.parse(raw.split(ESC_CLOSE).join('</'));
}

export function pagePathOf(root, work) {
  return path.join(root, 'reading', work.band, pad2(work.no) + '.html');
}

/** 一段正文 → 每词一个 span，词典形式写进 data-l */
function renderParagraph(line, lex, terms, oov, stats, gaiji) {
  const parts = [];
  for (const atom of parseInline(line, gaiji)) {
    if (atom.t === 'ruby') {
      const e = lex.forms.get(atom.base);
      const lemma = atom.base;
      if (!terms[lemma]) terms[lemma] = { kana: atom.rt, pos: e ? e.pos : '', en: e ? e.en : '' };
      stats.tokens++;
      if (e) stats.known++;
      const hl = !e && atom.base.length >= 2;
      if (hl) oov.add(lemma);
      parts.push(
        '<span class="w' + (hl ? ' u' : '') + '" data-l="' + esc(lemma) + '" data-s="' + esc(atom.base) + '"' + (hl ? ' data-o="1"' : '') + '>' +
          '<ruby>' + esc(atom.base) + '<rt>' + esc(atom.rt) + '</rt></ruby>' +
        '</span>'
      );
      continue;
    }
    for (const t of segment(atom.s, lex)) {
      if (t.cls !== 'punct') {
        stats.tokens++;
        if (t.entry) stats.known++;
      }
      if (t.entry) {
        /* 显示用词条：假名表层用假名（否则「ように」会顶着「容認」出现），汉字表层用辞書形。 */
        const shown = displayEntry(t.surface, t.entry);
        if (!terms[shown.lemma]) {
          terms[shown.lemma] = { kana: shown.kana, pos: shown.pos, en: shown.en };
        }
        parts.push('<span class="w" data-l="' + esc(shown.lemma) + '" data-s="' + esc(t.surface) + '">' + esc(t.surface) + '</span>');
      } else if (t.cls === 'kanji') {
        /* 未収録的**单字**多是切词失败的碎片（連・頗・斥…），不是词汇项：
           只让它可点（看得到「未収録」提示），不进高亮集合，否则满屏飘红。 */
        const highlight = t.surface.length >= 2;
        if (highlight) oov.add(t.surface);
        if (!terms[t.surface]) terms[t.surface] = { kana: '', pos: '', en: '' };
        parts.push(
          '<span class="w' + (highlight ? ' u' : '') + '" data-l="' + esc(t.surface) + '" data-s="' + esc(t.surface) + '"' +
          (highlight ? ' data-o="1"' : '') + '>' + esc(t.surface) + '</span>'
        );
      } else {
        parts.push(esc(t.surface));
      }
    }
  }
  return parts.join('');
}

/** 缓存正文 + 注释真源 → 页面载荷（纯函数，check 也会用它算期望值） */
export function buildPayload(work, meta, notes, lex, bodyText, zhMap = {}) {
  const full = paragraphsOf(bodyText);
  const [fromRaw, toRaw] = (notes.excerpt && notes.excerpt.paras) || [0, full.length];
  const from = Math.max(0, fromRaw || 0);
  const to = Math.min(full.length, toRaw === undefined ? full.length : toRaw);
  const picked = full.slice(from, to);

  if (!notes.paras || notes.paras.length !== picked.length) {
    throw new Error(
      `${work.id}：注释真源 ${(notes.paras && notes.paras.length) || 0} 段，` +
      `节选区间（第 ${from + 1}–${to} 段）${picked.length} 段 —— 段数必须相等`
    );
  }

  const terms = {};
  const oov = new Set();
  const stats = { tokens: 0, known: 0 };
  const body = picked.map((line) => renderParagraph(line, lex, terms, oov, stats, notes.gaiji || {}));

  /* 中文来源三层：本篇生词表 > 共享中文词表 > （没有就只显示英文与读音） */
  for (const k of Object.keys(terms)) {
    if (!terms[k].zh && zhMap[k]) terms[k].zh = zhMap[k];
  }

  for (const [k, v] of Object.entries(notes.gloss || {})) {
    if (!terms[k]) terms[k] = { kana: '', pos: '', en: '' };
    if (v.kana) terms[k].kana = v.kana;
    if (v.pos) terms[k].pos = v.pos;
    if (v.en) terms[k].en = v.en;
    if (v.zh) terms[k].zh = v.zh;
  }

  return {
    work: {
      id: work.id, band: work.band, no: work.no,
      title: meta.title, kana: meta.kana, author: meta.author,
      kanaType: meta.kanaType, cardUrl: meta.cardUrl,
      bib: meta.bib, parentBib: meta.parentBib, input: meta.input, proof: meta.proof,
      released: meta.released, revised: meta.revised,
    },
    excerpt: {
      from, to,
      chars: picked.join('').replace(/\s/g, '').length,
      fullChars: meta.chars,
      fullParas: full.length,
    },
    terms,
    oov: [...oov],
    stats: {
      tokens: stats.tokens,
      known: stats.known,
      coverage: stats.tokens ? +(stats.known / stats.tokens * 100).toFixed(1) : 0,
      oovTypes: oov.size,
    },
    notes: { intro: notes.intro || '', paras: notes.paras },
    body,
  };
}

function pageHtml(work, payload) {
  const rel = 'reading/' + work.band + '/' + pad2(work.no) + '.html';
  const prefix = prefixOf(rel);
  const active = activeOf(rel);
  const band = work.band.toUpperCase();
  const title = `${payload.work.title} · ${band} · 日语阅读 · 个人工作站`;
  const desc = `日语阅读 ${band} 档：《${payload.work.title}》（${payload.work.author}，节选 ${payload.excerpt.chars} 字，非高频词 ${payload.oov.length} 个），点词查读音与释义。`;
  const data = JSON.stringify(payload).replace(/<\//g, '<\\/');
  const scriptTag = '<script>window.JP_READING = ' + data + ';</script>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="${prefix}assets/style.css">
<link rel="stylesheet" href="${prefix}en/unit.css">
<link rel="stylesheet" href="${prefix}reading/reading.css">
<script src="${prefix}assets/theme.js"></script>
</head>
<body class="has-rail">
${railHtml({ prefix, active })}
<div class="jp-wrap">
  <nav class="jp-crumb">
    <a href="${prefix}index.html">资料库首页</a>
    <span class="jp-crumb-sep">／</span>
    <a href="${prefix}reading/index.html">日语阅读</a>
    <span class="jp-crumb-sep">／</span>
    <span>${band} · ${pad2(work.no)}</span>
  </nav>
  <noscript><p class="jp-empty">本页的点词查义与注释需要 JavaScript；正文可以直接阅读。</p></noscript>
  <main class="jp-read" id="jpRead"></main>
</div>
${scriptTag}
<script src="${prefix}assets/progress.js"></script>
<script src="${prefix}reading/reading.js"></script>
</body>
</html>`;
}

/** gen 子命令：逐篇组装并写页面（幂等：内容没变不落盘） */
export function generate({ root, works, only, log, dryRun = false }) {
  const scratch = path.join(root, '.scratch', 'jp-reading');
  const dictFile = path.join(scratch, 'jmdict-eng-common.json');
  if (!fs.existsSync(dictFile)) throw new Error('缺 JMdict 缓存：先跑 node tools/jp-reading.mjs fetch');
  const dict = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
  const lex = buildLexicon(dict.words);
  const zhMap = loadZhGloss(root);

  const written = [];
  const skipped = [];
  const entries = [];
  for (const work of works) {
    if (only && work.id !== only && work.band !== only) continue;
    const notesFile = path.join(root, 'reading', 'notes', work.id + '.json');
    const metaFile = path.join(scratch, 'aozora', work.id + '.json');
    const bodyFile = path.join(scratch, 'aozora', work.id + '.txt');
    if (!fs.existsSync(notesFile)) {
      skipped.push(`${work.id}（缺 reading/notes/${work.id}.json）`);
      continue;
    }
    if (!fs.existsSync(metaFile) || !fs.existsSync(bodyFile)) {
      skipped.push(`${work.id}（缺缓存正文，先跑 fetch）`);
      continue;
    }
    const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const payload = buildPayload(work, meta, notes, lex, fs.readFileSync(bodyFile, 'utf8'), zhMap);
    const changed = writePreservingEol(pagePathOf(root, work), pageHtml(work, payload), { dry: dryRun });
    if (changed) written.push(work.id);
    entries.push({ work, payload });
    log(
      `  · ${work.id} ${meta.title}　节选 ${payload.excerpt.chars} 字 / ${payload.body.length} 段` +
      `　词表 ${Object.keys(payload.terms).length}　非高频 ${payload.oov.length}` +
      (changed ? '　已写' : '　无变化')
    );
  }
  if (skipped.length) log('  跳过：' + skipped.join('、'));

  /* --only 只重生成一篇时，篇目页仍然要列全部已有篇目：按磁盘重读，而不是用本次的 entries。 */
  const allEntries = works
    .map((w) => {
      const page = pagePathOf(root, w);
      if (!fs.existsSync(page)) return null;
      const hit = entries.find((e) => e.work.id === w.id);
      return hit || { work: w, payload: readPayload(page) };
    })
    .filter(Boolean);

  if (allEntries.length) {
    entries.length = 0;
    entries.push(...allEntries);
  }

  if (entries.length) {
    /* 分档数据：人工定档 + 覆盖率排序给出的「规则档」，两者不一致就要在台账里写明。
       篇数上来后（每档 ≥5）再切到规则分档，切换条件写在 reading/README.md。 */
    const byCoverage = entries.slice().sort((a, b) => b.payload.stats.coverage - a.payload.stats.coverage);
    const third = Math.ceil(byCoverage.length / 3);
    const ruleBand = {};
    byCoverage.forEach((e, i) => {
      ruleBand[e.work.id] = i < third ? 'n3' : i < third * 2 ? 'n2' : 'n1';
    });
    const grading = byCoverage.map((e, i) => ({
      id: e.work.id,
      band: e.work.band,
      ruleBand: ruleBand[e.work.id],
      rank: i + 1,
      chars: e.payload.excerpt.chars,
      tokens: e.payload.stats.tokens,
      coverage: e.payload.stats.coverage,
      oovTypes: e.payload.stats.oovTypes,
    }));
    writePreservingEol(
      path.join(root, 'reading', 'data', 'grading.json'),
      JSON.stringify({ rule: '按高频词覆盖率排序，均分三段（n3 最高 → n1 最低）；首批为人工定档', items: grading }, null, 2) + String.fromCharCode(10),
      { dry: dryRun }
    );
    for (const g of grading) {
      log('  · 分档 ' + g.id + '　人工 ' + g.band + '／规则 ' + g.ruleBand + '　覆盖率 ' + g.coverage + '%');
    }

    const indexFile = path.join(root, 'reading', 'index.html');
    if (writePreservingEol(indexFile, renderIndex(entries), { dry: dryRun })) written.push('index');
    log('  · 篇目页　' + entries.length + ' 篇　' + (written.includes('index') ? '已写' : '无变化'));
  }
  return { written, skipped };
}

/* -------------------------------------------------------------- 篇目页 */

const BAND_LABEL = { n3: 'N3 · 入门', n2: 'N2 · 进阶', n1: 'N1 · 挑战' };

function renderIndex(entries) {
  const total = entries.length;
  const chars = entries.reduce((n, e) => n + e.payload.excerpt.chars, 0);
  const oov = entries.reduce((n, e) => n + e.payload.oov.length, 0);

  const bandBlock = (band) => {
    const rows = entries.filter((e) => e.work.band === band);
    if (!rows.length) return '';
    return '<section class="jp-band" aria-label="' + BAND_LABEL[band] + '">' +
      '<h2 class="jp-band-h">' + BAND_LABEL[band] + '<span class="jp-band-n">' + rows.length + ' 篇</span></h2>' +
      '<ul class="jp-work-list">' +
      rows.map((e) => {
        const p = e.payload;
        const href = e.work.band + '/' + pad2(e.work.no) + '.html';
        const key = 'reading/' + href;
        return '<li class="jp-work" data-key="' + key + '">' +
          '<a class="jp-work-a" href="' + href + '">' +
            '<span class="jp-work-title">' + esc(p.work.title) + '</span>' +
            '<span class="jp-work-kana">' + esc(p.work.kana) + '</span>' +
            '<span class="jp-work-meta">' + esc(p.work.author) +
              '　·　' + p.excerpt.chars + ' 字（第 ' + (p.excerpt.from + 1) + '–' + p.excerpt.to + ' 段）' +
              '　·　非高频词 ' + p.oov.length + '</span>' +
          '</a>' +
          '<span class="jp-seal" aria-hidden="true">済</span>' +
        '</li>';
      }).join('') +
      '</ul></section>';
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>日语阅读 · 青空文庫 分级精读 · 个人工作站</title>
<meta name="description" content="日语阅读：青空文庫 公有领域作品，按 N3–N1 分档节选，振假名保留、点词查读音与释义、逐段中文译文与语法点。">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="../assets/style.css">
<link rel="stylesheet" href="reading.css">
<script src="../assets/theme.js"></script>
</head>
<body class="has-rail">
${railHtml({ prefix: '../', active: 'reading' })}
<div class="jp-wrap">
  <nav class="jp-crumb">
    <a href="../index.html">资料库首页</a>
    <span class="jp-crumb-sep">／</span>
    <span>日语阅读</span>
  </nav>
  <main class="jp-index">
    <header class="jp-head">
      <p class="jp-eyebrow">日语阅读 · 青空文庫</p>
      <h1 class="jp-title">按 N3–N1 分档的精读短篇</h1>
      <p class="jp-sub">${total} 篇 · ${chars.toLocaleString('en-US')} 字 · 非高频词 ${oov} 个 · 全部公有领域</p>
      <p class="jp-note">每篇节选 1,200–2,500 字，原文一字未改（只把青空文庫 的注記转成振假名）。
        正文任意词可点开看读音、词性与释义；非高频词自动高亮；每段「注」里有中文译文、语法点与背景。</p>
      <p class="jp-meter" id="jpReadDone">已读 0/${total}</p>
    </header>
    ${['n3', 'n2', 'n1'].map(bandBlock).join('')}
    <section class="jp-foot">
      <p class="jp-credit">正文来自<a href="https://www.aozora.gr.jp/" rel="noopener">青空文庫</a>（公有领域），
        每篇页脚标有底本、入力校正者与図書カード 链接。词典数据派生自 JMdict（CC BY-SA 4.0），
        中文释义为本页注释的一部分。站点整体 CC BY-NC 4.0。</p>
    </section>
  </main>
</div>
<script src="../assets/progress.js"></script>
<script src="index.js"></script>
</body>
</html>`;
}

export { renderIndex };
