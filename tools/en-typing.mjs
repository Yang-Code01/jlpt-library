#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   英语打字 · 固定搭配挖掘（生成 en/typing/phrases.js）

   用法（在仓库根运行）：
     node tools/en-typing.mjs gen      # 从站内阅读正文挖固定搭配，写 en/typing/phrases.js
     node tools/en-typing.mjs check    # 逐字节比对 + 口径校验（不改任何文件）

   语料来源 = 已入库的 30 篇阅读正文（en/reading/<档>/NN.html 里的 window.EN_ARTICLE.paras，
   文本来自 Project Gutenberg 公有领域）。**只读仓库内文件，不联网、不依赖 .scratch**，
   所以任何克隆都能复现同一份数据。

   口径（详见 en/typing/README.md）：
     1. 句内相邻二元组，两侧词都必须是词表前 2,000 名内的词（用 en/data/vocab.js 的 rank）；
     2. 两侧都是功能词 → 丢（"of the" 这类纯语法串）；
     3. 任一侧是限定词 / 物主词 / 代词 → 丢（"the world" / "man who" 这类只是句法槽位）；
     4. 命中人手维护的 EXCLUDE 清单 → 丢（高频但不成搭配的串，理由逐条见 en/typing/README.md）；
     5. 出现次数 ≥ MIN_COUNT 且 PMI ≥ MIN_PMI；
     6. 三词搭配提升：两侧二元组各自都够格时（如 "as soon" + "soon as"），
        合并成一条三词搭配（"as soon as"），出现次数门槛为 TRI_MIN_COUNT；
     7. 按次数降序截取前 LIMIT 条。

   为什么要挖：ECDICT 里 30 万条词组的中释都有，但 frq/bnc 全为 0，无法判断常用度；
   连字符复合词与撇号词的 frq 也全为 0（在可排名池里 0 条）。所以固定搭配只能从语料挖。
   --------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOCAB_JS = path.join(ROOT, 'en/data/vocab.js');
const READING = path.join(ROOT, 'en/reading');
const OUT = path.join(ROOT, 'en/typing/phrases.js');

const BANDS = ['1k', '2k', '3k', '4k'];
const RANK_MAX = 2000;     // 只认前 2,000 名内的词（搭配要够常用才值得练）
const MIN_COUNT = 4;       // 语料只有约 4.6 万词，4 次以下噪声太大
const MIN_PMI = 3.3;
const TRI_MIN_COUNT = 3;   // 三词搭配的门槛（语料小，放到 3 次）
const LIMIT = 120;         // 上限（过门槛后按次数截取；实际条数由门槛决定）
const MIN_ITEMS = 30;      // 少于这个数说明门槛把数据筛没了，check 报错

/* 功能词：两侧都是功能词时丢弃（"of the" / "in the" / "and the" …） */
const FUNC = new Set(('a an the and or but of to in on at by for from with as if that this these those than then ' +
  'so such not no nor be am is are was were been being do does did done have has had he she it they we you i ' +
  'him her his its their our your my me us them there here when where why how what which who whom whose will ' +
  'would shall should can could may might must upon into out up down over again very too also all any some ' +
  'each every both more most other another own same only just now ever never still yet well one').split(' '));

/* 限定词 / 物主词：任一侧出现即丢弃（这类组合是语法位置，不是固定搭配） */
const DET = new Set(('the a an this that these those his her my your their our its some any no every each all ' +
  'both such another other').split(' '));

/* 代词：任一侧出现即丢弃（"man who" / "see them" / "will come" 这类是句法槽位）。
   代价是丢掉 "thank you" / "let me" 这类口语串——本清单只要固定搭配，不要口语句型。 */
const PRON = new Set(('i me my mine myself you your yours yourself he him his himself she her hers herself it its ' +
  'itself we us our ours ourselves they them their theirs themselves who whom whose this that these those ' +
  'what which').split(' '));

/* 人工剔除清单：语料里高频、但**不成搭配**的串（多为「助动词 / 否定词 + 动词」
   或名词 + of 的所有格片段）。只按频率与 PMI 挖时这些一定挤进前排，故显式排除；
   逐条理由见 en/typing/README.md。 */
const EXCLUDE = new Set([
  'not know',      // 否定词 + 动词，任何动词都能这么搭
  'corner of',     // 名词 + of 的所有格片段（"the corner of the room"）
  'seem to',       // 系词式连接，不固定
  'will come',     // 助动词 + 动词
  'would make',    // 助动词 + 动词
  'look so',       // 动词 + 副词片段（"look so pale"）
  'in town',       // 介词短语，非固定搭配
  'off into',      // 副词 + 介词（"off into the night"）
  'one side',      // 数量词 + 名词（"on one side"）
  'sleep two',     // 语料里的偶然相邻（"sleep two in a bed"）
  'to receive',    // 不定式片段
  'same time',     // "at the same time" 的片段
  'oh sir',        // 呼语
  'glad when',     // 形容词 + 连词片段
  'shall deal',    // 助动词 + 动词
  'into two',      // 介词 + 数词片段
  'or three',      // 连词 + 数词片段
  'none but',      // 古诗文用法
  'can get',       // 助动词 + 动词
  'could get',     // 助动词 + 动词
  'necessary for', // 形容词 + 介词，非固定搭配
  'so near'        // 副词短语片段
]);

/* 与生成器 / 阅读页同口径的分词（带变音符的字母也是词的一部分） */
const WORDS_RE = /[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'-]*/g;
const wordsOf = (s) => (s.match(WORDS_RE) || []);

function readVocab() {
  const raw = fs.readFileSync(VOCAB_JS, 'utf8');
  const start = raw.indexOf('{', raw.indexOf('window.EN_VOCAB'));
  const json = raw.slice(start, raw.lastIndexOf('}') + 1);
  const V = JSON.parse(json);
  const rank = new Map();
  for (const w of V.words) rank.set(w.w, w.rank);
  return { meta: V.meta, rank };
}

/* 逐篇读出 window.EN_ARTICLE.paras（正文已剥去版权头尾，段落是普通文本） */
function readArticles() {
  const out = [];
  for (const band of BANDS) {
    const dir = path.join(READING, band);
    if (!fs.existsSync(dir)) throw new Error('缺少目录：' + dir);
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.html$/.test(f)) continue;
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = /window\.EN_ARTICLE\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(html);
      if (!m) throw new Error('读不到 payload：en/reading/' + band + '/' + f);
      const A = JSON.parse(m[1]);
      out.push({ file: band + '/' + f, paras: A.paras });
    }
  }
  return out;
}

/* 挖二元组（同时统计三元组，用于把 "as soon as" 这类三词搭配提升成一条，
   避免列出 "as soon" 与 "soon as" 两个半截片段）。 */
function mine(articles, rank) {
  const uni = new Map();
  const big = new Map();
  const tri = new Map();
  let tokens = 0;
  for (const a of articles) {
    for (const p of a.paras) {
      for (const sent of String(p).split(/[.!?;:"()[\]*_]+/)) {
        const ws = wordsOf(sent).map((w) => w.toLowerCase());
        tokens += ws.length;
        for (let i = 0; i < ws.length; i++) {
          const w1 = ws[i];
          if (rank.has(w1)) uni.set(w1, (uni.get(w1) || 0) + 1);
          if (i + 2 < ws.length) {
            const w3 = ws[i + 2];
            if (rank.has(w1) && rank.has(ws[i + 1]) && rank.has(w3) &&
                rank.get(w1) <= RANK_MAX && rank.get(ws[i + 1]) <= RANK_MAX && rank.get(w3) <= RANK_MAX) {
              const t = w1 + ' ' + ws[i + 1] + ' ' + w3;
              tri.set(t, (tri.get(t) || 0) + 1);
            }
          }
          if (i + 1 >= ws.length) continue;
          const w2 = ws[i + 1];
          const r1 = rank.get(w1), r2 = rank.get(w2);
          if (r1 == null || r2 == null || r1 > RANK_MAX || r2 > RANK_MAX) continue;
          if (FUNC.has(w1) && FUNC.has(w2)) continue;
          if (DET.has(w1) || DET.has(w2)) continue;
          const key = w1 + ' ' + w2;
          big.set(key, (big.get(key) || 0) + 1);
        }
      }
    }
  }
  return { uni, big, tri, tokens };
}

function pick(mined) {
  const rows = [];
  const cand = new Set();
  for (const [key, c] of mined.big) {
    if (c < MIN_COUNT) continue;
    if (EXCLUDE.has(key)) continue;
    const [w1, w2] = key.split(' ');
    if (PRON.has(w1) || PRON.has(w2)) continue;
    const c1 = mined.uni.get(w1) || 0;
    const c2 = mined.uni.get(w2) || 0;
    if (!c1 || !c2) continue;
    const pmi = Math.log((c * mined.tokens) / (c1 * c2));
    if (!(pmi >= MIN_PMI)) continue;
    cand.add(key);
    rows.push({ w: key, k: key.replace(/\s+/g, ''), c: c, pmi: Math.round(pmi * 100) / 100 });
  }

  /* 三词搭配提升：只当两侧二元组**各自都够格**（已进入候选集）时，才把两个片段
     合并成一条三词搭配——否则会挖出 "and you shall" 这类句法残段。 */
  const tri = [];
  for (const [key, c] of mined.tri) {
    if (c < TRI_MIN_COUNT || EXCLUDE.has(key)) continue;
    const [w1, w2, w3] = key.split(' ');
    if (!cand.has(w1 + ' ' + w2) || !cand.has(w2 + ' ' + w3)) continue;
    tri.push({ w: key, k: key.replace(/\s+/g, ''), c: c, pmi: null });
  }
  const used = new Set();
  tri.sort((a, b) => (b.c - a.c) || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0));
  for (const t of tri) {
    const [w1, w2, w3] = t.w.split(' ');
    used.add(w1 + ' ' + w2);
    used.add(w2 + ' ' + w3);
  }
  const kept = rows.filter((r) => !used.has(r.w)).concat(tri);
  kept.sort((a, b) => (b.c - a.c) || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0));
  return kept.slice(0, LIMIT);
}

function render(rows, meta) {
  const lines = [];
  lines.push('/* ---------------------------------------------------------------------------');
  lines.push('   英语打字 · 4k 档固定搭配（生成物，请勿手改）');
  lines.push('');
  lines.push('   生成：node tools/en-typing.mjs gen      校验：node tools/en-typing.mjs check');
  lines.push('   语料：站内 30 篇阅读正文（en/reading/<档>/NN.html，Project Gutenberg 公有领域）');
  lines.push('   口径：二元组 · 两侧词都在词表前 ' + RANK_MAX + ' 名 · 非双功能词 · 不含限定词 ·');
  lines.push('         出现 ≥' + MIN_COUNT + ' 次且 PMI ≥' + MIN_PMI + '，按次数降序取前 ' + LIMIT + ' 条');
  lines.push('   统计：语料 ' + meta.files + ' 篇 / ' + meta.tokens.toLocaleString('en-US') + ' 次分词 /');
  lines.push('         候选 ' + meta.candidates.toLocaleString('en-US') + ' 条（过门槛后按次数截取）');
  lines.push('   c = 在语料里出现的次数（仅用于复核与排序，运行时不使用）');
  lines.push('   --------------------------------------------------------------------------- */');
  lines.push('window.EN_TYPING_PHRASES = [');
  rows.forEach((r) => {
    lines.push('  { w: ' + JSON.stringify(r.w) + ', k: ' + JSON.stringify(r.k) + ', c: ' + r.c + ' },');
  });
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function sha256(t) {
  return crypto.createHash('sha256').update(t, 'utf8').digest('hex');
}

function build() {
  const vocab = readVocab();
  const articles = readArticles();
  const mined = mine(articles, vocab.rank);
  const rows = pick(mined);
  let candidates = 0;
  for (const c of mined.big.values()) if (c >= MIN_COUNT) candidates++;
  const meta = { files: articles.length, tokens: mined.tokens, candidates: candidates };
  return { text: render(rows, meta), rows: rows, meta: meta };
}

/* ---------------------------------------------------------------- 命令 */

function cmdGen() {
  const b = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, b.text, 'utf8');
  console.log('写入 en/typing/phrases.js · ' + b.rows.length + ' 条 · ' +
    b.text.length + ' B · 指纹 ' + sha256(b.text).slice(0, 16));
  console.log('语料 ' + b.meta.files + ' 篇 / ' + b.meta.tokens.toLocaleString('en-US') + ' 次分词 / 候选 ' +
    b.meta.candidates.toLocaleString('en-US') + ' 条');
  const longest = b.rows.slice().sort((x, y) => y.k.length - x.k.length)[0];
  console.log('最长搭配：' + longest.w + '（' + longest.k.length + ' 字母）');
}

function cmdCheck() {
  const problems = [];
  const b = build();
  if (!fs.existsSync(OUT)) {
    problems.push('缺少 en/typing/phrases.js，请先跑 gen');
  } else {
    const cur = fs.readFileSync(OUT, 'utf8');
    if (cur !== b.text) problems.push('en/typing/phrases.js 与重新挖掘的结果不一致（请重跑 gen）');
  }
  if (b.rows.length > LIMIT) problems.push('搭配条数 ' + b.rows.length + '，超过上限 ' + LIMIT);
  if (b.rows.length < MIN_ITEMS) problems.push('搭配只有 ' + b.rows.length + ' 条，少于下限 ' + MIN_ITEMS);
  const seen = new Set();
  const vocab = readVocab();
  for (const r of b.rows) {
    if (seen.has(r.w)) problems.push('重复条目：' + r.w);
    seen.add(r.w);
    if (!/^[a-z][a-z'-]*(?: [a-z][a-z'-]*){1,2}$/.test(r.w)) problems.push('形状不合规（应为两到三个小写词）：' + r.w);
    if (r.k !== r.w.replace(/\s+/g, '')) problems.push('k 必须是去掉空格的写法：' + r.w);
    if (r.c < (r.w.split(' ').length === 3 ? TRI_MIN_COUNT : MIN_COUNT)) problems.push('出现次数过低：' + r.w);
    // 三词搭配的片段不应同时出现
    const ws = r.w.split(' ');
    if (ws.length === 3) {
      if (seen.has(ws[0] + ' ' + ws[1]) || seen.has(ws[1] + ' ' + ws[2])) {
        problems.push('三词搭配与其片段同时出现：' + r.w);
      }
    }
    for (const w of r.w.split(' ')) {
      const rk = vocab.rank.get(w);
      if (rk == null) problems.push('词不在词表内：' + w + '（' + r.w + '）');
      else if (rk > RANK_MAX) problems.push('词不在前 ' + RANK_MAX + ' 名：' + w + '（' + r.w + '）');
    }
  }
  const lens = b.rows.map((r) => r.k.length);
  console.log('搭配 ' + b.rows.length + ' 条 · 语料 ' + b.meta.files + ' 篇 / ' +
    b.meta.tokens.toLocaleString('en-US') + ' 次分词 · 字母数 ' +
    Math.min.apply(null, lens) + '–' + Math.max.apply(null, lens));
  if (problems.length) {
    problems.forEach((p) => console.log('  - ' + p));
    console.log('FAIL');
    process.exit(1);
  }
  console.log('OK · 口径与字节一致');
}

const cmd = process.argv[2];
if (cmd === 'gen') cmdGen();
else if (cmd === 'check') cmdCheck();
else {
  console.log('用法：node tools/en-typing.mjs gen | check');
  process.exit(1);
}
