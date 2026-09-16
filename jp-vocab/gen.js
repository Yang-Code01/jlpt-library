// 课堂单词 · 单元页生成器与校验器
//
// 唯一真源是每个单元目录下的 data.json。下面两处是生成物，不要手改：
//   - jp-vocab/<unit>/index.html 内联的 <script type="application/json" id="vocab-data"> 块
//   - jp-vocab/index.html 里的 const UNITS 数组
//
//   node jp-vocab/gen.js check           只校验，不改文件；有问题则退出码 1
//   node jp-vocab/gen.js write           全部单元：写 data.json + index.html，并重写目录页 UNITS
//   node jp-vocab/gen.js write <unit>    只处理一个单元（不动目录页 UNITS）
//
// 新增一个单元：建 jp-vocab/<unit>/data.json（顶层加 "audio": false 表示该单元暂无音频），
// 然后 node jp-vocab/gen.js write。目录页顺序＝现有顺序，新单元追加在末尾。

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIR_PAGE = path.join(ROOT, 'index.html');

// 卡片字段顺序即内联 JSON 的键顺序；改这里会重排全部单元页
const FIELDS = ['id','word','kana','pos','meaning_cn','example_jp','example_jp_ruby','example_cn'];
// 可选字段：显示形与朗读形不一致时（词条含「（に／と）」或「・」），用 speak_word 指定要朗读的文本。
// gen-audio.ps1 读它；省略时按 word 朗读。
const OPTIONAL_CARD_KEYS = ['speak_word'];
const CARD_KEYS = FIELDS.concat(OPTIONAL_CARD_KEYS);
const CAT_KEYS = ['name','reading','cards'];
const TOP_KEYS = ['title','reading','meaning_cn','audio','categories'];

// 单元页外壳。与既有 4 个单元逐字节一致；改动它等于改动全部单元页
const SHELL_HEAD = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>课堂单词</title>',
  '<link rel="stylesheet" href="../vocab.css">',
  '</head>',
  '<body>',
  '<div class="wrap">',
  '<nav class="pagenav">',
  '  <a href="../index.html">← 返回课堂单词</a>',
  '  <span class="spacer"></span>',
  '  <a href="../../index.html">门户首页</a>',
  '</nav>',
  '',
  '<header>',
  '  <h1 id="title">—</h1>',
  '  <div class="sub" id="sub"></div>',
  '  <span class="meaning" id="hmeaning"></span>',
  '</header>',
  '<nav class="tabs" id="tabs">',
  '  <button data-tab="browse" class="active">浏览</button>',
  '  <button data-tab="card">翻转卡</button>',
  '  <button data-tab="quiz">测验</button>',
  '  <button data-tab="srs">复习<span id="duepill" class="pill" style="display:none">0</span></button>',
  '</nav>',
  '',
  '<section id="browse"></section>',
  '<section id="card" style="display:none"></section>',
  '<section id="quiz" style="display:none"></section>',
  '<section id="srs" style="display:none"></section>',
  '</div>',
  '',
  '<!-- 数据内联：file:// 下不可 fetch，故以本块为准；与同目录 data.json 内容一致 -->',
  '<script type="application/json" id="vocab-data">',
].join('\n') + '\n';
const SHELL_TAIL = '</script>\n<script src="../vocab.js"></script>\n</body>\n</html>\n';

/* ---------------- 序列化：逐字节复现既有格式 ---------------- */

function j(v){ return JSON.stringify(v); }

function cardLine(c, last){
  const pairs = [];
  FIELDS.forEach(f => {
    pairs.push(j(f) + ': ' + j(c[f]));
    if(f === 'word' && c.speak_word) pairs.push(j('speak_word') + ': ' + j(c.speak_word));
  });
  return '        { ' + pairs.join(', ') + ' }' + (last ? '' : ',');
}

function serializeUnit(d){
  const out = ['{'];
  out.push('  "title": ' + j(d.title) + ',');
  out.push('  "reading": ' + j(d.reading) + ',');
  out.push('  "meaning_cn": ' + j(d.meaning_cn) + ',');
  if(d.audio === false) out.push('  "audio": false,');
  out.push('  "categories": [');
  d.categories.forEach((cat, ci) => {
    out.push('    {');
    out.push('      "name": ' + j(cat.name) + ',');
    out.push('      "reading": ' + j(cat.reading) + ',');
    out.push('      "cards": [');
    cat.cards.forEach((c, ki) => out.push(cardLine(c, ki === cat.cards.length - 1)));
    out.push('      ]');
    out.push('    }' + (ci === d.categories.length - 1 ? '' : ','));
  });
  out.push('  ]');
  out.push('}');
  return out.join('\n') + '\n';
}

function renderUnitPage(d){ return SHELL_HEAD + serializeUnit(d) + SHELL_TAIL; }

/* ---------------- 目录页 UNITS ---------------- */

// 中英混排的对齐要按显示宽度算，CJK 全角占 2 列
function isWide(c){
  return (c >= 0x1100 && c <= 0x115f) || c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
}
function dispLen(s){
  let n = 0;
  for(const ch of s) n += isWide(ch.codePointAt(0)) ? 2 : 1;
  return n;
}
function gap(s, W){ return ' '.repeat(Math.max(1, W - dispLen(s))); }

function unitsRows(){
  return orderedDirs().map(dir => {
    const d = readUnit(dir);
    return {
      dir: dir,
      title: d.title,
      reading: d.reading,
      meaning: d.meaning_cn,
      cards: d.categories.reduce((n, c) => n + c.cards.length, 0),
    };
  });
}

function unitsBlock(rows){
  const cells = rows.map(r => ({
    dir: 'dir:' + j(r.dir) + ',',
    title: 'title:' + j(r.title) + ',',
    reading: 'reading:' + j(r.reading) + ',',
    meaning: 'meaning:' + j(r.meaning) + ',',
    cards: 'cards:' + r.cards,
  }));
  const W = k => Math.max.apply(null, cells.map(c => dispLen(c[k])));
  const lines = cells.map(c =>
    '    { ' +
    c.dir + gap(c.dir, W('dir')) +
    c.title + gap(c.title, W('title')) +
    c.reading + gap(c.reading, W('reading')) +
    c.meaning + gap(c.meaning, W('meaning')) +
    c.cards + ' },');
  return 'const UNITS = [\n' + lines.join('\n') + '\n  ];';
}

const UNITS_RE = /const UNITS = \[[\s\S]*?\n *\];/;

/* ---------------- 读写 ---------------- */

function readText(p){ return fs.readFileSync(p, 'utf8'); }

function unitDirs(){
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'data.json')))
    .map(e => e.name);
}

// 目录页已有顺序优先（决定展示顺序），新目录追加在末尾并按名称排序
function orderedDirs(){
  const all = unitDirs();
  const seen = [];
  const m = readText(DIR_PAGE).match(UNITS_RE);
  if(m) for(const x of m[0].matchAll(/dir:\s*"([^"]+)"/g)) if(all.includes(x[1]) && !seen.includes(x[1])) seen.push(x[1]);
  return seen.concat(all.filter(d => !seen.includes(d)).sort());
}

function readUnit(dir){ return JSON.parse(readText(path.join(ROOT, dir, 'data.json'))); }

/* ---------------- 校验 ---------------- */

function checkUnit(dir){
  const bad = [];
  const dataPath = path.join(ROOT, dir, 'data.json');
  const pagePath = path.join(ROOT, dir, 'index.html');
  let raw, d;
  try { raw = readText(dataPath); } catch(e){ return ['读不到 data.json']; }
  try { d = JSON.parse(raw); } catch(e){ return ['data.json 不是合法 JSON：' + e.message]; }

  for(const k of Object.keys(d)) if(!TOP_KEYS.includes(k)) bad.push('data.json 顶层多出未知键 "' + k + '"（gen.js 会丢字段，请改用已知键）');
  for(const k of ['title','reading','meaning_cn']) if(!d[k]) bad.push('缺 ' + k);
  if(!Array.isArray(d.categories) || !d.categories.length){ bad.push('categories 为空'); return bad; }

  const ids = new Set();
  d.categories.forEach((cat, ci) => {
    if(!cat || typeof cat !== 'object'){ bad.push('第 ' + (ci + 1) + ' 个 category 不是对象'); return; }
    for(const k of Object.keys(cat)) if(!CAT_KEYS.includes(k)) bad.push('category "' + (cat.name || ci + 1) + '" 多出未知键 "' + k + '"');
    for(const k of ['name','reading']) if(!cat[k]) bad.push('category ' + (ci + 1) + ' 缺 ' + k);
    if(!Array.isArray(cat.cards) || !cat.cards.length){ bad.push('category "' + cat.name + '" 没有卡片'); return; }
    cat.cards.forEach((c, ki) => {
      const at = cat.name + ' 第 ' + (ki + 1) + ' 张';
      for(const k of Object.keys(c)) if(!CARD_KEYS.includes(k)) bad.push(at + ' 多出未知键 "' + k + '"（gen.js 会丢字段，请改用已知键）');
      for(const k of FIELDS) if(typeof c[k] !== 'string' || !c[k].trim()) bad.push(at + ' 的 ' + k + ' 为空');
      if(c.speak_word !== undefined && (typeof c.speak_word !== 'string' || !c.speak_word.trim())) bad.push(at + ' 的 speak_word 不是非空字符串');
      if(ids.has(c.id)) bad.push('id "' + c.id + '" 重复'); else ids.add(c.id);
      if(!new RegExp('^' + (ci + 1) + '-\\d+$').test(c.id || '')) bad.push(at + ' 的 id 「' + c.id + '」应为 "' + (ci + 1) + '-<序号>"');
      if(d.audio === false) return;
      for(const kind of ['w','e']){
        const p = path.join(ROOT, dir, 'audio', c.id + '-' + kind + '.wav');
        if(!fs.existsSync(p)) bad.push('缺音频 ' + c.id + '-' + kind + '.wav');
      }
      if(!c.example_jp_ruby.includes('<ruby>')) bad.push(at + ' 的 example_jp_ruby 没有 <ruby> 注音');
    });
  });

  if(raw !== serializeUnit(d)) bad.push('data.json 不是 gen.js 的规范格式（跑 write 可规范化）');
  let page = '';
  try { page = readText(pagePath); } catch(e){ bad.push('读不到 index.html'); return bad; }
  if(page !== renderUnitPage(d)) bad.push('index.html 与生成结果不一致（跑 write 可修）');
  return bad;
}

function checkDirPage(rows){
  const bad = [];
  const html = readText(DIR_PAGE);
  const m = html.match(UNITS_RE);
  if(!m) return ['目录页找不到 const UNITS = [...]'];
  const want = unitsBlock(rows);
  if(m[0] !== want){
    const got = (m[0].match(/dir:\s*"([^"]+)"/g) || []).map(s => s.replace(/.*"([^"]+)".*/, '$1'));
    const miss = rows.map(r => r.dir).filter(d => !got.includes(d));
    const extra = got.filter(d => !rows.map(r => r.dir).includes(d));
    if(miss.length) bad.push('目录页缺单元：' + miss.join(', '));
    if(extra.length) bad.push('目录页多出单元：' + extra.join(', '));
    if(!miss.length && !extra.length) bad.push('目录页 UNITS 的文案或词数与 data.json 不一致');
  }
  return bad;
}

/* ---------------- 入口 ---------------- */

function allRows(){ return unitsRows(); }

function doCheck(){
  const rows = allRows();
  let fail = 0, cards = 0;
  rows.forEach(r => {
    const bad = checkUnit(r.dir);
    cards += r.cards;
    if(bad.length){ fail++; console.log('✗ ' + r.dir); bad.forEach(b => console.log('    - ' + b)); }
    else console.log('✓ ' + r.dir + '  ' + r.cards + ' 卡' + (readUnit(r.dir).audio === false ? ' · audio:false（跳过音频检查）' : ''));
  });
  const dirBad = checkDirPage(rows);
  if(dirBad.length){ fail++; console.log('✗ 目录页 index.html'); dirBad.forEach(b => console.log('    - ' + b)); }
  else console.log('✓ 目录页 index.html  UNITS ' + rows.length + ' 单元 / ' + cards + ' 卡');
  console.log(fail ? '\n' + fail + ' 处问题。' : '\n全部通过：' + rows.length + ' 单元 / ' + cards + ' 卡。');
  process.exit(fail ? 1 : 0);
}

function doWrite(only){
  const rows = allRows();
  const targets = only ? rows.filter(r => r.dir === only) : rows;
  if(!targets.length){ console.error('找不到单元：' + only + '（该目录下没有 data.json？）'); process.exit(1); }
  targets.forEach(r => {
    const d = readUnit(r.dir);
    const before = readText(path.join(ROOT, r.dir, 'data.json'));
    const pageBefore = fs.existsSync(path.join(ROOT, r.dir, 'index.html')) ? readText(path.join(ROOT, r.dir, 'index.html')) : '';
    const json = serializeUnit(d), page = renderUnitPage(d);
    if(json !== before) fs.writeFileSync(path.join(ROOT, r.dir, 'data.json'), json, 'utf8');
    if(page !== pageBefore) fs.writeFileSync(path.join(ROOT, r.dir, 'index.html'), page, 'utf8');
    console.log('· ' + r.dir + '  ' + r.cards + ' 卡' + (json === before && page === pageBefore ? '（无改动）' : '（已写）'));
  });
  if(only) return;
  const html = readText(DIR_PAGE);
  const next = html.replace(UNITS_RE, unitsBlock(rows));
  if(next !== html){ fs.writeFileSync(DIR_PAGE, next, 'utf8'); console.log('· 目录页 UNITS 已重写（' + rows.length + ' 单元）'); }
  else console.log('· 目录页 UNITS 无改动');
}

const argv = process.argv.slice(2);
const mode = argv[0];
if(mode === 'check') doCheck();
else if(mode === 'write') doWrite(argv[1]);
else {
  console.log('用法：');
  console.log('  node jp-vocab/gen.js check          只校验，不改文件');
  console.log('  node jp-vocab/gen.js write          全部单元：写 data.json + index.html + 目录页 UNITS');
  console.log('  node jp-vocab/gen.js write <unit>   只处理一个单元');
}
