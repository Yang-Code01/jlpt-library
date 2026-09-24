// 动词专练 · 生成器与校验器
//
// 复制改造自 jp-vocab/gen.js。两种数据形态：
//   A. 词卡单元：唯一真源 verb/units/<unit>/data.json。生成物（不要手改）：
//      - verb/units/<unit>/index.html 内联的 <script type="application/json" id="vocab-data"> 块
//      - verb/units/index.html 里的 const UNITS 数组
//   B. 变形练习：唯一真源 verb/conjugation/data.json。生成物（不要手改）：
//      - verb/conjugation/index.html 整页（含内联数据与全部交互）
//
//   node verb/gen.js check           只校验，不改文件；有问题则退出码 1
//   node verb/gen.js write           全部单元 + 变形练习页，并重写目录页 UNITS
//   node verb/gen.js write <unit>    只处理一个词卡单元（不动目录页与变形练习页）
//
// 与 jp-vocab 的差异：
//   - 顶层多一个 "examples": false 旗标（例文未起草完时豁免例文三字段的非空与 ruby 检查）
//   - 音频只查 <id>-w.wav（无例文音频 -e.wav）
//   - check 对变形练习数据跑 11 形态变形规则校验（含 行く/する/来る 例外）

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const UNIT_ROOT = path.join(ROOT, 'units');
const DIR_PAGE = path.join(UNIT_ROOT, 'index.html');
const CONJ_DIR = path.join(ROOT, 'conjugation');
const CONJ_DATA = path.join(CONJ_DIR, 'data.json');
const CONJ_PAGE = path.join(CONJ_DIR, 'index.html');

// 卡片字段顺序即内联 JSON 的键顺序；改这里会重排全部单元页
const FIELDS = ['id','word','kana','pos','meaning_cn','example_jp','example_jp_ruby','example_cn'];
// 可选字段：显示形与朗读形不一致时（词条含「（…）」或「・」），用 speak_word 指定要朗读的文本。
const OPTIONAL_CARD_KEYS = ['speak_word'];
const CARD_KEYS = FIELDS.concat(OPTIONAL_CARD_KEYS);
const CAT_KEYS = ['name','reading','cards'];
const TOP_KEYS = ['title','reading','meaning_cn','audio','examples','categories'];
// examples:false 时豁免的例文字段
const EXAMPLE_FIELDS = ['example_jp','example_jp_ruby','example_cn'];

/* ============================================================
   A. 词卡单元页
   ============================================================ */

// 单元页外壳。改动它等于改动全部单元页
const SHELL_HEAD = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>动词专练</title>',
  '<link rel="stylesheet" href="../../../assets/style.css">',
  '<script src="../../../assets/theme.js"></script>',
  '<link rel="stylesheet" href="../../vocab.css">',
  '</head>',
  '<body>',
  '<div class="wrap">',
  '<nav class="pagenav">',
  '  <a href="../index.html">← 返回词卡目录</a>',
  '  <span class="spacer"></span>',
  '  <a href="../../index.html">动词专练首页</a>',
  '  <a href="../../../index.html">门户首页</a>',
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
const SHELL_TAIL = '</script>\n<script src="../../vocab.js"></script>\n</body>\n</html>\n';

/* ---------------- 序列化：逐字节复现 jp-vocab 格式 ---------------- */

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
  if(d.examples === false) out.push('  "examples": false,');
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
  if(!fs.existsSync(UNIT_ROOT)) return [];
  return fs.readdirSync(UNIT_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(UNIT_ROOT, e.name, 'data.json')))
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

function readUnit(dir){ return JSON.parse(readText(path.join(UNIT_ROOT, dir, 'data.json'))); }

/* ---------------- 单元校验 ---------------- */

function checkUnit(dir){
  const bad = [];
  const dataPath = path.join(UNIT_ROOT, dir, 'data.json');
  const pagePath = path.join(UNIT_ROOT, dir, 'index.html');
  let raw, d;
  try { raw = readText(dataPath); } catch(e){ return ['读不到 data.json']; }
  try { d = JSON.parse(raw); } catch(e){ return ['data.json 不是合法 JSON：' + e.message]; }

  for(const k of Object.keys(d)) if(!TOP_KEYS.includes(k)) bad.push('data.json 顶层多出未知键 "' + k + '"（gen.js 会丢字段，请改用已知键）');
  for(const k of ['title','reading','meaning_cn']) if(!d[k]) bad.push('缺 ' + k);
  if(!Array.isArray(d.categories) || !d.categories.length){ bad.push('categories 为空'); return bad; }

  const noEx = d.examples === false;
  const ids = new Set();
  d.categories.forEach((cat, ci) => {
    if(!cat || typeof cat !== 'object'){ bad.push('第 ' + (ci + 1) + ' 个 category 不是对象'); return; }
    for(const k of Object.keys(cat)) if(!CAT_KEYS.includes(k)) bad.push('category "' + (cat.name || ci + 1) + '" 多出未知键 "' + k + '"');
    for(const k of ['name','reading']) if(!cat[k]) bad.push('category ' + (ci + 1) + ' 缺 ' + k);
    if(!Array.isArray(cat.cards) || !cat.cards.length){ bad.push('category "' + cat.name + '" 没有卡片'); return; }
    cat.cards.forEach((c, ki) => {
      const at = cat.name + ' 第 ' + (ki + 1) + ' 张';
      for(const k of Object.keys(c)) if(!CARD_KEYS.includes(k)) bad.push(at + ' 多出未知键 "' + k + '"（gen.js 会丢字段，请改用已知键）');
      for(const k of FIELDS){
        if(noEx && EXAMPLE_FIELDS.includes(k)) continue;   // examples:false：例文三字段豁免
        if(typeof c[k] !== 'string' || !c[k].trim()) bad.push(at + ' 的 ' + k + ' 为空');
      }
      if(c.speak_word !== undefined && (typeof c.speak_word !== 'string' || !c.speak_word.trim())) bad.push(at + ' 的 speak_word 不是非空字符串');
      if(ids.has(c.id)) bad.push('id "' + c.id + '" 重复'); else ids.add(c.id);
      if(!new RegExp('^' + (ci + 1) + '-\\d+$').test(c.id || '')) bad.push(at + ' 的 id 「' + c.id + '」应为 "' + (ci + 1) + '-<序号>"');
      if(d.audio !== false){
        const p = path.join(UNIT_ROOT, dir, 'audio', c.id + '-w.wav');
        if(!fs.existsSync(p)) bad.push('缺音频 ' + c.id + '-w.wav');
      }
      if(!noEx && /[一-龥々〆〇]/.test(c.example_jp) && !c.example_jp_ruby.includes('<ruby>')) bad.push(at + ' 的 example_jp_ruby 没有 <ruby> 注音');
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

/* ============================================================
   B. 变形练习
   ============================================================ */

const CONJ_FORMS = ['ます形','ない形','て形','た形','命令形','可能形','假定形','意志形','被动形','使役形','使役被动形'];
const CONJ_TOP_KEYS = ['title','forms','verbs'];
const CONJ_VERB_KEYS = ['word','reading','class','forms'];

/* ---- 变形规则（校验用）---- */
const GODAN = {
  'う': ['い','わ','って','った','え','お'],
  'く': ['き','か','いて','いた','け','こ'],
  'ぐ': ['ぎ','が','いで','いだ','げ','ご'],
  'す': ['し','さ','して','した','せ','そ'],
  'つ': ['ち','た','って','った','て','と'],
  'ぬ': ['に','な','んで','んだ','ね','の'],
  'ぶ': ['び','ば','んで','んだ','べ','ぼ'],
  'む': ['み','ま','んで','んだ','め','も'],
  'る': ['り','ら','って','った','れ','ろ'],
};

function conjGodan(word){
  const stem = word.slice(0, -1), m = GODAN[word.slice(-1)];
  if(!m) return null;
  const te = word === '行く' ? '行って' : stem + m[2];
  const ta = word === '行く' ? '行った' : stem + m[3];
  return {
    'ます形': stem + m[0] + 'ます', 'ない形': stem + m[1] + 'ない',
    'て形': te, 'た形': ta,
    '命令形': stem + m[4], '可能形': stem + m[4] + 'る',
    '假定形': stem + m[4] + 'ば', '意志形': stem + m[5] + 'う',
    '被动形': stem + m[1] + 'れる', '使役形': stem + m[1] + 'せる',
    '使役被动形': stem + m[1] + 'される',
  };
}

function conjIchidan(word){
  const stem = word.slice(0, -1);
  return {
    'ます形': stem + 'ます', 'ない形': stem + 'ない',
    'て形': stem + 'て', 'た形': stem + 'た',
    '命令形': stem + 'ろ', '可能形': stem + 'られる',
    '假定形': stem + 'れば', '意志形': stem + 'よう',
    '被动形': stem + 'られる', '使役形': stem + 'させる',
    '使役被动形': stem + 'させられる',
  };
}

const SURU_FORMS = {
  'ます形': 'します', 'ない形': 'しない', 'て形': 'して', 'た形': 'した',
  '命令形': 'しろ', '可能形': 'できる', '假定形': 'すれば', '意志形': 'しよう',
  '被动形': 'される', '使役形': 'させる', '使役被动形': 'させられる',
};
const KURU_FORMS = {
  'ます形': 'きます', 'ない形': 'こない', 'て形': 'きて', 'た形': 'きた',
  '命令形': 'こい', '可能形': 'こられる', '假定形': 'くれば', '意志形': 'こよう',
  '被动形': 'こられる', '使役形': 'こさせる', '使役被动形': 'こさせられる',
};

function conjClass3(word){
  if(word === '来る') return KURU_FORMS;
  const prefix = word === 'する' ? '' : word.slice(0, -2);
  const out = {};
  CONJ_FORMS.forEach(f => { out[f] = prefix + SURU_FORMS[f]; });
  return out;
}

function conjExpected(v){
  if(v.class === 1) return conjGodan(v.word);
  if(v.class === 2) return conjIchidan(v.word);
  return conjClass3(v.word);
}

function checkConj(){
  const bad = [];
  let raw, d;
  try { raw = readText(CONJ_DATA); } catch(e){ return ['读不到 conjugation/data.json']; }
  try { d = JSON.parse(raw); } catch(e){ return ['conjugation/data.json 不是合法 JSON：' + e.message]; }

  for(const k of Object.keys(d)) if(!CONJ_TOP_KEYS.includes(k)) bad.push('conjugation data.json 顶层多出未知键 "' + k + '"');
  if(JSON.stringify(d.forms) !== JSON.stringify(CONJ_FORMS)) bad.push('forms 与约定的 11 形态清单或顺序不一致');
  if(!Array.isArray(d.verbs) || !d.verbs.length){ bad.push('verbs 为空'); return bad; }

  const seen = new Set();
  d.verbs.forEach((v, i) => {
    const at = 'verbs[' + i + '] ' + (v.word || '?');
    for(const k of Object.keys(v)) if(!CONJ_VERB_KEYS.includes(k)) bad.push(at + ' 多出未知键 "' + k + '"');
    if(!v.word || !v.reading) bad.push(at + ' 缺 word/reading');
    if(![1,2,3].includes(v.class)) bad.push(at + ' 的 class 应为 1/2/3');
    if(seen.has(v.word)) bad.push('word "' + v.word + '" 重复'); else seen.add(v.word);
    if(!v.forms || typeof v.forms !== 'object'){ bad.push(at + ' 缺 forms'); return; }
    CONJ_FORMS.forEach(f => {
      if(typeof v.forms[f] !== 'string' || !v.forms[f].trim()) bad.push(at + ' 的 ' + f + ' 为空');
    });
    for(const k of Object.keys(v.forms)) if(!CONJ_FORMS.includes(k)) bad.push(at + ' 的 forms 多出未知形态 "' + k + '"');
    const want = conjExpected(v);
    if(want) CONJ_FORMS.forEach(f => {
      if(v.forms[f] && v.forms[f] !== want[f]) bad.push(at + ' 的 ' + f + ' 「' + v.forms[f] + '」与变形规则不符（应为「' + want[f] + '」）');
    });
  });

  if(raw !== serializeConj(d)) bad.push('conjugation/data.json 不是 gen.js 的规范格式（跑 write 可规范化）');
  let page = '';
  try { page = readText(CONJ_PAGE); } catch(e){ bad.push('读不到 conjugation/index.html'); return bad; }
  if(page !== renderConjPage(d)) bad.push('conjugation/index.html 与生成结果不一致（跑 write 可修）');
  return bad;
}

function serializeConj(d){
  return JSON.stringify(d, null, 2) + '\n';
}

/* ---- 变形练习页模板：数据内联，交互照已确认的 prototype/conjugation-template.html ---- */
function renderConjPage(d){
  const json = serializeConj(d).replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>动词专练 · 变形练习</title>
<!-- 本页由 verb/gen.js 从 conjugation/data.json 生成，不要手改（交互设计档案：.scratch/verb-module/prototype/conjugation-template.html） -->
<link rel="stylesheet" href="../../assets/style.css">
<script src="../../assets/theme.js"></script>
<style>
  :root{
    --bg:var(--paper); --line:var(--border); --card:var(--surface);
    --accent2:var(--accent); --ok:var(--green); --bad:var(--red);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:"Hiragino Sans","Yu Gothic","Noto Sans CJK JP","Microsoft YaHei",system-ui,sans-serif;
    line-height:1.6;padding-top:0}
  .wrap{max-width:680px;margin:0 auto;padding:28px 20px 60px}
  nav.pagenav{display:flex;flex-wrap:wrap;gap:8px;align-items:center;
    margin-bottom:20px;border-bottom:1px solid var(--line);padding-bottom:12px}
  nav.pagenav a{text-decoration:none;font-size:.88em;padding:4px 14px;border-radius:999px;
    border:1px solid var(--line);color:var(--accent);background:var(--card);transition:background .15s ease}
  nav.pagenav a:hover{background:var(--accent-soft)}
  nav.pagenav .spacer{flex:1}
  h1{font-size:1.5rem;margin:0 0 4px}
  .sub{color:var(--muted);font-size:.92rem;margin:0 0 18px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:18px}
  .lbl{font-size:.82rem;font-weight:700;color:var(--muted);letter-spacing:.05em;margin:10px 0 6px}
  .lbl:first-child{margin-top:0}
  .pills{display:flex;flex-wrap:wrap;gap:8px}
  .pills button{font-size:.85rem;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:5px 13px;border-radius:999px;cursor:pointer;font-family:inherit}
  .pills button:hover{border-color:var(--accent)}
  .pills button.on{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .startr{display:flex;gap:12px;align-items:center;margin-top:16px;flex-wrap:wrap}
  .count{color:var(--muted);font-size:.88rem}
  button.act{font-size:1rem;font-weight:700;background:var(--accent2);color:var(--on-accent);border:none;border-radius:10px;padding:10px 22px;cursor:pointer;font-family:inherit}
  button.act:hover{background:var(--accent)}
  button.ghost{font-size:.92rem;background:transparent;border:1px solid var(--line);color:var(--accent);border-radius:10px;padding:9px 16px;cursor:pointer;font-family:inherit}
  button.ghost:hover{background:var(--accent-soft)}
  .status{display:flex;gap:14px;color:var(--muted);font-size:.88rem;margin-bottom:14px;flex-wrap:wrap}
  .status b{color:var(--ink)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px 24px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .prompt .cls{color:var(--muted);font-size:.9rem}
  .prompt .dict{font-size:2.6rem;font-weight:800;letter-spacing:.02em}
  .prompt .rd{color:var(--muted);font-size:1rem;margin-left:10px;font-weight:400}
  .prompt .form{margin-top:2px;font-weight:700;color:var(--accent)}
  .prompt .form em{font-style:normal;background:var(--accent-soft);border-radius:6px;padding:1px 8px}
  .row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;align-items:center}
  input[type=text]{flex:1;min-width:180px;font-size:1.25rem;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font-family:inherit}
  input[type=text]:focus{outline:2px solid var(--accent2)}
  .fb{margin-top:16px;font-weight:700;min-height:1.6em}
  .fb.ok{color:var(--ok)} .fb.bad{color:var(--bad)} .fb.ans{color:var(--accent)}
  .choices{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:22px}
  .choices button{font-size:1.3rem;font-weight:700;padding:14px 10px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;font-family:inherit}
  .choices button:hover:not(:disabled){border-color:var(--accent)}
  .choices button.right{background:var(--green-l);border-color:var(--green-line);color:var(--ok)}
  .choices button.wrong{background:var(--red-l);border-color:var(--red-line);color:var(--bad)}
  .choices button:disabled{cursor:default}
  .answer-reveal{font-size:2.4rem;font-weight:800;color:var(--accent);margin:18px 0 4px;letter-spacing:.02em}
  .done{text-align:center}
  .done .score{font-size:1.5rem;font-weight:800;color:var(--accent);margin:14px 0}
  .headrow{position:sticky;top:0;z-index:9;background:var(--bg);display:flex;align-items:center;
    justify-content:space-between;gap:16px;flex-wrap:wrap;padding:6px 0 12px;margin-bottom:18px;
    border-bottom:1px solid var(--line)}
  .titles{min-width:0}
  .titles .sub{margin:2px 0 0}
  .topbar{position:static;display:none;align-items:center;gap:10px;flex-wrap:wrap}
  .topbar.show{display:flex}
  .topbar .pills{gap:6px}
  .topbar .pills button{padding:3px 11px;font-size:.8rem}
  .tbstat{color:var(--muted);font-size:.85rem;font-weight:600;white-space:nowrap}
  .tbstat b{color:var(--ink)}
  .pbar{width:120px;height:6px;background:var(--border-soft);border-radius:99px;overflow:hidden}
  .pbar i{display:block;height:100%;width:0;background:var(--accent2);border-radius:99px;transition:width .2s}
  .hint{color:var(--muted);font-size:.95rem}
</style>
</head>
<body>
<div class="wrap">
  <nav class="pagenav">
    <a href="../index.html">← 返回动词专练</a>
    <span class="spacer"></span>
    <a href="../units/index.html">词卡目录</a>
    <a href="../../index.html">门户首页</a>
  </nav>
  <div class="headrow" id="headrow">
    <div class="titles">
      <h1>动词变形练习</h1>
      <p class="sub">三种交互并存，练习中可随时切换（标题右侧工具条）。筛题按形态与动词类别。</p>
    </div>
    <div class="topbar" id="topbar">
      <div class="pills" id="modepills2">
        <button data-mode="a">A 输入</button>
        <button data-mode="b">B 选择</button>
        <button data-mode="c">C 自揭</button>
      </div>
      <span class="tbstat" id="tbstat"></span>
      <div class="pbar"><i id="pfill"></i></div>
      <button class="ghost" id="editsetup" style="padding:3px 11px;font-size:.8rem;margin-left:auto">修改设置</button>
    </div>
  </div>

  <div class="panel" id="setup">
    <div class="lbl">模式（练习中可随时切换）</div>
    <div class="pills" id="modepills">
      <button data-mode="a">A 输入式填空</button>
      <button data-mode="b">B 选择式四选一</button>
      <button data-mode="c">C 自我揭示</button>
    </div>
    <div class="lbl">形态范围</div>
    <div class="pills" id="formpills"></div>
    <div class="lbl">动词类别</div>
    <div class="pills" id="classpills"></div>
    <div class="startr">
      <button class="act" id="startbtn">开始练习</button>
      <span class="count" id="count"></span>
    </div>
  </div>
  <div id="app"><p class="hint">选好模式与范围后，点「开始练习」。</p></div>
</div>
<script type="application/json" id="conj-data">
${json}</script>
<script>
(function(){
  var DATA = JSON.parse(document.getElementById('conj-data').textContent);
  var FORMS = DATA.forms;
  var CLS = {1:'一类（五段）', 2:'二类（一段）', 3:'三类（サ变）'};
  var VERBS = DATA.verbs.map(function(v){
    return { d:v.word, r:v.reading, cls:v.class, a:FORMS.map(function(f){ return v.forms[f]; }) };
  });

  var app = document.getElementById('app');
  var topbar = document.getElementById('topbar');
  var setup = document.getElementById('setup');
  var editsetup = document.getElementById('editsetup');
  var state = null;
  var mode = 'a';
  var formSel = -1;
  var classSel = 0;

  function norm(s){ return (s||'').replace(/[\\s\\u3000]+/g,''); }
  function shuffle(arr){
    for(var i=arr.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=arr[i]; arr[i]=arr[j]; arr[j]=t; }
    return arr;
  }
  function pickSome(arr, n, notIn){
    var pool = arr.filter(function(x){ return notIn.indexOf(x)<0; });
    shuffle(pool);
    return pool.slice(0, n);
  }

  function buildItems(){
    var items = [];
    VERBS.forEach(function(v){
      if(classSel && v.cls !== classSel) return;
      var idxs = (formSel < 0) ? FORMS.map(function(_,k){return k;}) : [formSel];
      idxs.forEach(function(k){ items.push({ v:v, k:k, answer:v.a[k] }); });
    });
    return shuffle(items);
  }
  function itemTotal(){ var n=0; VERBS.forEach(function(v){ if(!classSel || v.cls===classSel) n += (formSel<0?FORMS.length:1); }); return n; }

  function start(){
    state = { items:buildItems(), i:0, results:[] };
    render();
  }
  function backToSetup(){ state = null; render(); }
  function rightN(){ return state.results.filter(function(r){return r==='right';}).length; }

  function syncTopbar(){
    topbar.className = 'topbar show';
    ['modepills','modepills2'].forEach(function(id){
      Array.prototype.forEach.call(document.querySelectorAll('#'+id+' button'), function(b){
        b.className = (b.getAttribute('data-mode')===mode) ? 'on' : '';
      });
    });
    if(state){
      document.getElementById('tbstat').innerHTML =
        '<b>' + Math.min(state.i+1, state.items.length) + '</b>/' + state.items.length +
        ' · 对 <b>' + rightN() + '</b>';
      document.getElementById('pfill').style.width =
        (state.items.length ? (state.i/state.items.length*100) : 100) + '%';
    }
  }

  function render(){
    setup.style.display = state ? 'none' : '';
    if(!state){
      topbar.className = 'topbar';
      app.innerHTML = '<p class="hint">设置已更新，点「开始练习」应用新设置。</p>';
      return;
    }
    if(state.i >= state.items.length){
      topbar.className = 'topbar show';
      document.getElementById('tbstat').innerHTML = '完成 · 对 <b>' + rightN() + '</b>/' + state.items.length;
      document.getElementById('pfill').style.width = '100%';
      app.innerHTML = '<div class="card done"><div>做完了。</div>' +
        '<div class="score">答对 ' + rightN() + ' / ' + state.items.length + '</div>' +
        '<button class="act" id="again">再来一轮（重新洗牌）</button></div>';
      document.getElementById('again').onclick = start;
      return;
    }
    syncTopbar();
    var it = state.items[state.i];
    var body = (mode==='a') ? inputBody() : (mode==='b') ? choiceBody(it) : revealBody();
    app.innerHTML =
      '<div class="status"><span>第 <b>' + (state.i+1) + '</b>/' + state.items.length + ' 题</span>' +
      '<span>答对 <b>' + rightN() + '</b> · 未对 <b>' + (state.i - rightN()) + '</b></span>' +
      '<span>模式 ' + mode.toUpperCase() + '</span></div>' +
      '<div class="card">' + promptHtml(it) + body + '</div>';
    wire(it);
  }

  function promptHtml(it){
    return '<div class="prompt"><div class="cls">' + CLS[it.v.cls] + '动词</div>' +
      '<div class="dict">' + it.v.d + '<span class="rd">' + it.v.r + '</span></div>' +
      '<div class="form">→ <em>' + FORMS[it.k] + '</em> ？</div></div>';
  }

  /* ---- A 输入式 ---- */
  function inputBody(){
    return '<div class="row"><input type="text" id="ans" placeholder="输入变形后的形态" autocomplete="off">' +
      '<button class="act" id="judge">判定</button></div>' +
      '<div class="fb" id="fb"></div>' +
      '<div class="row" id="after" style="display:none">' +
      '<button class="ghost" id="see">看答案（计入未对）</button>' +
      '<button class="act" id="next">下一题 →</button></div>';
  }
  function wireInput(it){
    var input = document.getElementById('ans');
    function judge(){
      if(state.results[state.i]) return;
      var fb = document.getElementById('fb');
      if(norm(input.value) === norm(it.answer)){
        state.results[state.i] = 'right';
        fb.className = 'fb ok'; fb.textContent = '✓ 正确';
        finish();
      }else{
        fb.className = 'fb bad'; fb.textContent = '✗ 不对，再试一次（或看答案）';
        document.getElementById('after').style.display = 'flex';
        document.getElementById('next').style.display = 'none';
      }
    }
    document.getElementById('judge').onclick = judge;
    input.addEventListener('keydown', function(e){ if(e.key === 'Enter') judge(); });
    document.getElementById('see').onclick = function(){
      state.results[state.i] = 'wrong';
      var fb = document.getElementById('fb');
      fb.className = 'fb ans'; fb.textContent = '答案：' + it.answer;
      finish();
    };
    document.getElementById('next').onclick = nextItem;
    input.focus();
  }
  function finish(){
    document.getElementById('after').style.display = 'flex';
    document.getElementById('see').style.display = 'none';
    document.getElementById('next').style.display = '';
    var input = document.getElementById('ans');
    if(input) input.disabled = true;
    syncTopbar();
  }
  function nextItem(){ state.i++; render(); }

  /* ---- B 选择式 ---- */
  function makeChoices(it){
    // 干扰项：1 个同词异形态（考形态辨别）+ 2 个同形态异词（考动词接续），全部是真实日语
    var sameVerbOther = it.v.a.filter(function(_,k){ return k!==it.k; });
    var sameFormOther = VERBS.filter(function(v){ return v!==it.v; }).map(function(v){ return v.a[it.k]; });
    var ds = pickSome(sameVerbOther, 1, [it.answer]).concat(pickSome(sameFormOther, 2, [it.answer]));
    return shuffle([it.answer].concat(ds.slice(0,3)));
  }
  function choiceBody(it){
    var btns = makeChoices(it).map(function(c){ return '<button data-c="' + c + '">' + c + '</button>'; }).join('');
    return '<div class="choices">' + btns + '</div>' +
      '<div class="fb" id="fb"></div>' +
      '<div class="row" id="after" style="display:none"><button class="act" id="next">下一题 →</button></div>';
  }
  function wireChoice(it){
    Array.prototype.forEach.call(document.querySelectorAll('.choices button'), function(b){
      b.onclick = function(){
        if(state.results[state.i]) return;
        var fb = document.getElementById('fb');
        if(b.getAttribute('data-c') === it.answer){
          state.results[state.i] = 'right';
          b.className = 'right';
          fb.className = 'fb ok'; fb.textContent = '✓ 正确';
        }else{
          state.results[state.i] = 'wrong';
          b.className = 'wrong';
          Array.prototype.forEach.call(document.querySelectorAll('.choices button'), function(o){
            if(o.getAttribute('data-c') === it.answer) o.className = 'right';
          });
          fb.className = 'fb bad'; fb.textContent = '✗ 正确是「' + it.answer + '」';
        }
        Array.prototype.forEach.call(document.querySelectorAll('.choices button'), function(o){ o.disabled = true; });
        document.getElementById('after').style.display = 'flex';
        syncTopbar();
      };
    });
    document.getElementById('next').onclick = nextItem;
  }

  /* ---- C 自我揭示 ---- */
  function revealBody(){
    return '<div class="row"><button class="act" id="flip">想好了 · 翻开答案</button></div>' +
      '<div class="answer-reveal" id="rev" style="display:none"></div>' +
      '<div class="row" id="after" style="display:none">' +
      '<button class="act" id="yes">记对了</button>' +
      '<button class="ghost" id="no">记错了</button>' +
      '<span style="color:var(--muted);font-size:.85rem">自评后进入下一题</span></div>';
  }
  function wireReveal(it){
    document.getElementById('flip').onclick = function(){
      this.style.display = 'none';
      var rev = document.getElementById('rev');
      rev.textContent = it.answer; rev.style.display = 'block';
      document.getElementById('after').style.display = 'flex';
    };
    document.getElementById('yes').onclick = function(){ state.results[state.i] = 'right'; nextItem(); };
    document.getElementById('no').onclick  = function(){ state.results[state.i] = 'wrong'; nextItem(); };
  }

  function wire(it){
    if(mode==='a') wireInput(it);
    else if(mode==='b') wireChoice(it);
    else wireReveal(it);
  }

  function switchMode(m){
    if(m === mode) return;
    mode = m;
    if(state && state.i < state.items.length) state.results[state.i] = null;
    render();
  }

  function buildPanel(){
    var fp = document.getElementById('formpills');
    var html = '<button data-f="-1" class="on">全部</button>';
    FORMS.forEach(function(f,k){ html += '<button data-f="' + k + '">' + f + '</button>'; });
    fp.innerHTML = html;
    Array.prototype.forEach.call(fp.querySelectorAll('button'), function(b){
      b.onclick = function(){
        Array.prototype.forEach.call(fp.querySelectorAll('button'), function(o){ o.className=''; });
        b.className = 'on';
        formSel = parseInt(b.getAttribute('data-f'), 10);
        state = null; updateCount(); render();
      };
    });

    var cp = document.getElementById('classpills');
    var cnames = ['全部','一类（五段）','二类（一段）','三类（サ变）'];
    cp.innerHTML = cnames.map(function(c,k){ return '<button data-c="'+k+'"'+(k===0?' class="on"':'')+'>'+c+'</button>'; }).join('');
    Array.prototype.forEach.call(cp.querySelectorAll('button'), function(b){
      b.onclick = function(){
        Array.prototype.forEach.call(cp.querySelectorAll('button'), function(o){ o.className=''; });
        b.className = 'on';
        classSel = parseInt(b.getAttribute('data-c'), 10);
        state = null; updateCount(); render();
      };
    });

    ['modepills','modepills2'].forEach(function(id){
      Array.prototype.forEach.call(document.querySelectorAll('#'+id+' button'), function(b){
        b.onclick = function(){ switchMode(b.getAttribute('data-mode')); };
      });
    });
    document.getElementById('modepills').querySelector('button[data-mode="a"]').className = 'on';

    document.getElementById('startbtn').onclick = start;
    editsetup.onclick = backToSetup;
    updateCount();
  }
  function updateCount(){
    document.getElementById('count').textContent = '当前设置共 ' + itemTotal() + ' 题';
  }

  buildPanel();
})();
</script>
</body>
</html>
`;
}

/* ============================================================
   入口
   ============================================================ */

function allRows(){ return unitsRows(); }

function doCheck(){
  const rows = allRows();
  let fail = 0, cards = 0;
  rows.forEach(r => {
    const bad = checkUnit(r.dir);
    cards += r.cards;
    if(bad.length){ fail++; console.log('✗ ' + r.dir); bad.forEach(b => console.log('    - ' + b)); }
    else {
      const d = readUnit(r.dir);
      const notes = [];
      if(d.audio === false) notes.push('audio:false');
      if(d.examples === false) notes.push('examples:false');
      console.log('✓ ' + r.dir + '  ' + r.cards + ' 卡' + (notes.length ? ' · ' + notes.join(' · ') : ''));
    }
  });
  const dirBad = checkDirPage(rows);
  if(dirBad.length){ fail++; console.log('✗ 目录页 units/index.html'); dirBad.forEach(b => console.log('    - ' + b)); }
  else console.log('✓ 目录页 units/index.html  UNITS ' + rows.length + ' 单元 / ' + cards + ' 卡');
  const conjBad = checkConj();
  if(conjBad.length){ fail++; console.log('✗ 变形练习'); conjBad.forEach(b => console.log('    - ' + b)); }
  else {
    const d = JSON.parse(readText(CONJ_DATA));
    console.log('✓ 变形练习  ' + d.verbs.length + ' 词 × ' + d.forms.length + ' 形态（规则校验通过）');
  }
  console.log(fail ? '\n' + fail + ' 处问题。' : '\n全部通过：' + rows.length + ' 单元 / ' + cards + ' 卡 + 变形练习。');
  process.exit(fail ? 1 : 0);
}

function doWrite(only){
  const rows = allRows();
  const targets = only ? rows.filter(r => r.dir === only) : rows;
  if(only && !targets.length){ console.error('找不到单元：' + only + '（units/ 下没有该 data.json？）'); process.exit(1); }
  targets.forEach(r => {
    const d = readUnit(r.dir);
    const before = readText(path.join(UNIT_ROOT, r.dir, 'data.json'));
    const pageBefore = fs.existsSync(path.join(UNIT_ROOT, r.dir, 'index.html')) ? readText(path.join(UNIT_ROOT, r.dir, 'index.html')) : '';
    const json = serializeUnit(d), page = renderUnitPage(d);
    if(json !== before) fs.writeFileSync(path.join(UNIT_ROOT, r.dir, 'data.json'), json, 'utf8');
    if(page !== pageBefore) fs.writeFileSync(path.join(UNIT_ROOT, r.dir, 'index.html'), page, 'utf8');
    console.log('· ' + r.dir + '  ' + r.cards + ' 卡' + (json === before && page === pageBefore ? '（无改动）' : '（已写）'));
  });
  if(only) return;
  const html = readText(DIR_PAGE);
  const next = html.replace(UNITS_RE, unitsBlock(rows));
  if(next !== html){ fs.writeFileSync(DIR_PAGE, next, 'utf8'); console.log('· 目录页 UNITS 已重写（' + rows.length + ' 单元）'); }
  else console.log('· 目录页 UNITS 无改动');
  // 变形练习页
  const cd = JSON.parse(readText(CONJ_DATA));
  const cj = serializeConj(cd), cp = renderConjPage(cd);
  const cjBefore = readText(CONJ_DATA);
  const cpBefore = fs.existsSync(CONJ_PAGE) ? readText(CONJ_PAGE) : '';
  if(cj !== cjBefore) fs.writeFileSync(CONJ_DATA, cj, 'utf8');
  if(cp !== cpBefore) fs.writeFileSync(CONJ_PAGE, cp, 'utf8');
  console.log('· 变形练习  ' + cd.verbs.length + ' 词 × ' + cd.forms.length + ' 形态' + (cj === cjBefore && cp === cpBefore ? '（无改动）' : '（已写）'));
}

if(require.main === module){
  const argv = process.argv.slice(2);
  const mode = argv[0];
  if(mode === 'check') doCheck();
  else if(mode === 'write') doWrite(argv[1]);
  else {
    console.log('用法：');
    console.log('  node verb/gen.js check          只校验，不改文件');
    console.log('  node verb/gen.js write          全部单元 + 变形练习页 + 目录页 UNITS');
    console.log('  node verb/gen.js write <unit>   只处理一个词卡单元');
  }
}

// convert.js 复用序列化器：让转换产出从第一字节起就是规范格式（write 零 diff）
module.exports = { serializeUnit };
