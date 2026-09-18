// 动词专练 · 源材料转换器（ticket 01）
//
// 唯一输入：仓库外 ../source/N2动词.md（不入库，见 .scratch/verb-module/map.md）
// 产出（幂等）：
//   verb/units/<bucket>/data.json   按辞书形结尾分桶的词卡唯一真源
//   .scratch/verb-module/cleaning-report.md   清洗账目（合并/修正/手清/待人审/分桶表）
//
// 序列化直接复用 verb/gen.js 的 serializeUnit，故产出从第一字节起就是规范格式：
// 转换后跑 `node verb/gen.js write` 应为零 diff。
//
//   node verb/convert.js

const fs = require('fs');
const path = require('path');

const { serializeUnit } = require('./gen.js');

const ROOT = __dirname;
const SRC = path.join(ROOT, '..', '..', 'source', 'N2动词.md');
const OUT = path.join(ROOT, 'units');
const REPORT = path.join(ROOT, '..', '.scratch', 'verb-module', 'cleaning-report.md');

/* ============================================================
   1. 分桶定义（推荐 C：11 桶）
   ============================================================ */
const BUCKETS = [
  { slug:'u',           title:'〜う',                   rule:'て形 → って', catReading:'う',          meaning:null },
  { slug:'ku',          title:'〜く',                   rule:'て形 → いて', catReading:'く',          meaning:'書く・聞く・咲く・歩く …（例外：行く→って）' },
  { slug:'gu',          title:'〜ぐ',                   rule:'て形 → いで', catReading:'ぐ',          meaning:null },
  { slug:'su',          title:'〜す',                   rule:'て形 → して', catReading:'す',          meaning:null },
  { slug:'tsu',         title:'〜つ',                   rule:'て形 → って', catReading:'つ',          meaning:null },
  { slug:'mu-bu-nu',    title:'〜む・ぶ・ぬ',            rule:'て形 → んで', catReading:'む・ぶ・ぬ',   meaning:null },
  { slug:'ru-godan',    title:'〜る（五段）',            rule:'て形 → って', catReading:'る',          meaning:null },
  { slug:'ru-godan-ie', title:'〜いる・える（五段特例）',  rule:'て形 → って', catReading:'いる・える',   meaning:'帰る・切る・知る・走る・滑る …（看着像一段，其实是五段）' },
  { slug:'eru',         title:'〜える（一段）',          rule:'て形 → て',   catReading:'える',        meaning:null },
  { slug:'iru',         title:'〜いる（一段）',          rule:'て形 → て',   catReading:'いる',        meaning:null },
  { slug:'suru',        title:'〜する',                 rule:'て形 → して', catReading:'する',        meaning:null },
];

/* ---- 五段 / 一段判定 ----
   〜る 且倒数第二拍在 い/え 行的动词：默认一段，除非在下面两张清单里
   （源材料自己用「特别注意：下面这些词都是五段动词」标过这批词） */
const GODAN_IE_PAIRS = [   // 假名同而一段/五段两分的词，必须连汉字一起判
  'いる|要る', 'いる|炒る', 'きる|切る', 'しめる|湿る', 'かえる|帰る', 'かえる|返る',
];
const GODAN_IE_KANA = [    // 假名本身无一段同名词，可按假名判
  'ける','しる','ちる','てる','へる','かぎる','かじる','くぎる','しげる','すべる',
  'ちぎる','にぎる','ねじる','ひねる','はいる','はしる','まいる','まじる','ののしる',
  'ひにくる','しゃべる','さえぎる','おそれいる','きにいる','おいしげる','よみがえる',
  'ひっくりかえる','うちきる','うらぎる','かみきる','しめきる','のりきる','はりきる',
  'よこぎる','おもいきる',
];

const VOWEL = {};
'あかがさざただなはばぱまやらわゃぁ'.split('').forEach(c => VOWEL[c] = 'a');
'いきぎしじちぢにひびぴみりぃ'.split('').forEach(c => VOWEL[c] = 'i');
'うくぐすずつづぬふぶぷむゆるゅぅっ'.split('').forEach(c => VOWEL[c] = 'u');
'えけげせぜてでねへべぺめれぇ'.split('').forEach(c => VOWEL[c] = 'e');
'おこごそぞとどのほぼぽもよろをょぉ'.split('').forEach(c => VOWEL[c] = 'o');

function bucketOf(kana, normWord){
  // サ变复合动词：假名与汉字都以「する」结尾。
  // 只看假名会把 擦る（こする）・刷る（する）这类五段动词误收进来——它们是 る 结尾的五段。
  if(kana.endsWith('する') && normWord.endsWith('する')) return 'suru';
  const last = kana.slice(-1);
  const byLast = {'う':'u','く':'ku','ぐ':'gu','す':'su','つ':'tsu'};
  if(byLast[last]) return byLast[last];
  if(last === 'ぬ' || last === 'ぶ' || last === 'む') return 'mu-bu-nu';
  if(last === 'る'){
    const row = VOWEL[kana.slice(-2, -1)];
    if(row === 'i' || row === 'e'){
      const isGodan = GODAN_IE_PAIRS.includes(kana + '|' + normWord) || GODAN_IE_KANA.includes(kana);
      if(isGodan) return 'ru-godan-ie';
      return row === 'e' ? 'eru' : 'iru';
    }
    return 'ru-godan';
  }
  return null;
}

/* ============================================================
   2. 清洗表
   ============================================================ */

// 假名错字（源材料笔误，读完原表后逐条核对）
const FIX_KANA = { 'ふけめる':'ふくめる', 'がす':'ころがす' };
// 汉字写法错
const FIX_WORD = { '旅たつ':'旅立つ' };
// 释义尾部衍字
const FIX_MEANING = {
  'こぼす|零す': '洒，泼，流泪；发牢骚',
  'うつす|移す': '移动，搬家；转移；传染',
};
// 源释义为空，补一条（待人审）
const FILL_MEANING = { 'つつしむ|慎む': '谨慎，节制' };
// 汉字栏为空、但明显与另一条同词的，合并进带汉字的那条
const MERGE_MAP = { 'あがる|あがる':'あがる|上がる', 'かかる|かかる':'かかる|罹る' };

// 〜じる・ずる 那一段：表格粘连（假名/汉字/释义挤在一格），手工清出
const OVERRIDES = {
  'おうじる':   { word:'応じる', kana:'おうじる',   meaning:'回应，满足，响应（号召）；适应' },
  'かんじる':   { word:'感じる', kana:'かんじる',   meaning:'感觉，感到，觉得' },
  'しょうじる': { word:'生じる', kana:'しょうじる', meaning:'产生，发生' },
  'しんじる':   { word:'信じる', kana:'しんじる',   meaning:'相信，确信' },
  'ぞんじる':   { word:'存じる', kana:'ぞんじる',   meaning:'「思う」「知る」的谦让语' },
  'つうじる':   { word:'通じる', kana:'つうじる',   meaning:'通；通往；精通，通晓；理解，懂得，领会（自）；在整个区域或期间；通过者' },
  'ろんじる':   { word:'論じる', kana:'ろんじる',   meaning:'论述，讨论，议论' },
  'めいじる':   { word:'命じる', kana:'めいじる',   meaning:'命令；任命，委派；命名' },
};

// 待人审：源材料本身存疑，数据照录但在报告里单列
const REVIEW = [
  'つつしむ（慎む）：源释义为空，已补「谨慎，节制」——待人审',
  'くずつく：源假名疑为「ぐずつく」（标准形），本次照录源材料',
  'ちからづく（力づく）：源释义「恢复体力；来劲、起劲」与常见义「凭借武力／强行」不符，照录待审',
  'つうじる（通じる）：释义尾部「通过者」疑为衍文，照录待审',
  '行く：源表同时有 ゆく 与 いく 两条（同汉字异读），均保留，待人审确认',
  'ずれる：源汉字栏「滑れる」非常用写法，照录待审',
];

/* ============================================================
   3. 解析
   ============================================================ */

const KANA_RE = /^[\u3041-\u3096\u30fc]+$/;   // 纯平假名（含 ー）

function normWord(word){
  return word.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').split('・')[0];
}

const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split(/\r?\n/);

const stats = { rows:0, halves:0, entries:0, skipped:0, overrides:0, merged:0, fixed:0 };
const skippedRows = [];
const fixedRows = [];
const mergedRows = [];
const overrideRows = [];
const anomalies = [];

const byKey = new Map();   // 合并后的词条 key -> entry
const order = [];          // 插入顺序

function put(kana, word, meaning, note){
  const key = kana + '|' + (MERGE_MAP[kana + '|' + word] ? MERGE_MAP[kana + '|' + word].split('|')[1] : word);
  const realKey = MERGE_MAP[kana + '|' + word] || key;
  if(byKey.has(realKey)){
    const e = byKey.get(realKey);
    if(meaning && !e.meaning.includes(meaning)){
      e.meaning = e.meaning ? e.meaning + '；' + meaning : meaning;
      stats.merged++;
      mergedRows.push(`${kana}｜${word}  ← 合并「${meaning}」（同一词条重复出现在源表）`);
    }
    return;
  }
  const entry = { kana:kana, word:word, meaning:meaning };
  byKey.set(realKey, entry);
  order.push(entry);
  if(note) entry._note = note;
}

lines.forEach((line, i) => {
  const t = line.trim();
  if(!t.startsWith('|')) return;                       // 节标题 / 空行 / 竖排释义续行
  if(t.includes('内部资料') || t.includes('允许外泄')) return;
  const cells = t.split('|').slice(1, -1).map(s => s.trim());
  if(!cells.length) return;
  if(cells.every(c => /^[-—=\s]+$/.test(c))) return;   // 分隔行
  stats.rows++;

  const halves = cells.length >= 6 ? [cells.slice(0,3), cells.slice(3,6)]
               : cells.length === 3 ? [cells.slice(0,3)]
               : null;
  if(!halves){ anomalies.push(`第 ${i+1} 行列数异常（${cells.length} 格）：${t.slice(0,60)}`); return; }

  halves.forEach(h => {
    const [kanaRaw, wordRaw, meanRaw] = h;
    if(!kanaRaw && !wordRaw && !meanRaw) return;
    stats.halves++;

    // 〜じる・ずる 块：假名格里带「・」
    if(kanaRaw.includes('·') || kanaRaw.includes('・')){
      const prefix = kanaRaw.split(/[·・]/)[0];
      const ov = OVERRIDES[prefix];
      if(ov){
        put(ov.kana, ov.word, ov.meaning);
        stats.entries++; stats.overrides++;
        overrideRows.push(`${ov.kana}｜${ov.word}｜${ov.meaning}（源表格粘连，手工清出）`);
      } else {
        anomalies.push(`第 ${i+1} 行带「・」的假名未登记在 OVERRIDES：${kanaRaw}`);
      }
      return;
    }
    if(!KANA_RE.test(kanaRaw)){                        // 「特别注意：…」这类非词条
      stats.skipped++;
      skippedRows.push(`第 ${i+1} 行：${kanaRaw}`);
      return;
    }

    let kana = FIX_KANA[kanaRaw] || kanaRaw;
    let word = FIX_WORD[wordRaw] || wordRaw || kana;
    let meaning = meanRaw || '';
    if(kana !== kanaRaw){ stats.fixed++; fixedRows.push(`假名 ${kanaRaw} → ${kana}（${word}）`); }
    if(word !== wordRaw){ stats.fixed++; fixedRows.push(`汉字 ${wordRaw} → ${word}`); }
    const fmKey = kanaRaw + '|' + wordRaw;
    if(FIX_MEANING[fmKey]){ stats.fixed++; fixedRows.push(`释义 ${fmKey}：截去衍字 → ${FIX_MEANING[fmKey]}`); meaning = FIX_MEANING[fmKey]; }
    if(!meaning && FILL_MEANING[kana + '|' + word]){ stats.fixed++; fixedRows.push(`释义为空，补齐 ${kana}｜${word} → ${FILL_MEANING[kana + '|' + word]}`); meaning = FILL_MEANING[kana + '|' + word]; }
    if(!meaning) anomalies.push(`第 ${i+1} 行释义为空且无补齐规则：${kana}｜${word}`);

    put(kana, word, meaning);
    stats.entries++;
  });
});

/* ============================================================
   4. 分桶 + 排序 + 出卡
   ============================================================ */

const buckets = {};
BUCKETS.forEach(b => buckets[b.slug] = []);
const speakRows = [];
const bucketMiss = [];

order.forEach(e => {
  const nw = normWord(e.word);
  const slug = bucketOf(e.kana, nw);
  if(!slug){ bucketMiss.push(`${e.kana}｜${e.word}`); return; }
  if(nw !== e.word) speakRows.push(`${e.kana}｜${e.word} → speak_word=" ${nw} "（含（…）或・，TTS 只读第一形态）`);
  buckets[slug].push({ kana:e.kana, word:e.word, meaning:e.meaning, speak:nw !== e.word ? nw : null });
});

function cmpKana(a, b){
  if(a.kana !== b.kana) return a.kana < b.kana ? -1 : 1;
  return a.word < b.word ? -1 : 1;
}

const counts = [];
BUCKETS.forEach(b => {
  const list = buckets[b.slug].slice().sort(cmpKana);
  const cards = list.map((e, i) => {
    const c = { id:'1-' + (i + 1), word:e.word, kana:e.kana, pos:'動詞',
                meaning_cn:e.meaning, example_jp:'', example_jp_ruby:'', example_cn:'' };
    if(e.speak) c.speak_word = e.speak;
    return c;
  });
  const meaning = b.meaning || (list.slice(0,4).map(e => e.word).join('・') + ' …');
  const data = {
    title: b.title,
    reading: b.rule,
    meaning_cn: meaning,
    audio: false,
    examples: false,
    categories: [{ name:b.title, reading:b.catReading, cards:cards }],
  };
  const dir = path.join(OUT, b.slug);
  fs.mkdirSync(dir, { recursive:true });
  fs.writeFileSync(path.join(dir, 'data.json'), serializeUnit(data), 'utf8');
  counts.push({ slug:b.slug, title:b.title, n:cards.length, rule:b.rule });
});

/* ============================================================
   5. 断言
   ============================================================ */

// 抽样断言：[假名, 汉字(可选，用于同假名异词), 预期桶]
const SPOT = [
  ['しゃべる', null, 'ru-godan-ie'], ['いる', '要る', 'ru-godan-ie'], ['かえる', '帰る', 'ru-godan-ie'],
  ['はしる', null, 'ru-godan-ie'], ['へる', null, 'ru-godan-ie'],
  ['たべる', null, 'eru'], ['かんじる', null, 'iru'], ['みる', null, 'iru'], ['いる', '居る', 'iru'],
  ['いく', null, 'ku'], ['およぐ', null, 'gu'], ['まつ', null, 'tsu'], ['しぬ', null, 'mu-bu-nu'],
  ['あいする', null, 'suru'], ['うる', null, 'ru-godan'], ['つくる', null, 'ru-godan'],
];
const spotBad = [];
SPOT.forEach(([kana, word, slug]) => {
  const e = order.find(o => o.kana === kana && (!word || o.word === word));
  const got = e ? bucketOf(e.kana, normWord(e.word)) : null;
  if(got !== slug) spotBad.push(`${kana}${word ? '｜' + word : ''} 应在 ${slug}，实际 ${got || '（源表无此词）'}`);
});

const emptyBuckets = counts.filter(c => c.n === 0).map(c => c.slug);
const total = counts.reduce((n, c) => n + c.n, 0);

/* ============================================================
   6. 报告
   ============================================================ */

const ieList = order.filter(e => bucketOf(e.kana, normWord(e.word)) === 'ru-godan-ie')
                    .sort(cmpKana).map(e => `  - ${e.kana}｜${e.word}｜${e.meaning}`);
const ieRowList = order.filter(e => {
  const row = VOWEL[e.kana.slice(-2, -1)];
  return e.kana.endsWith('る') && (row === 'i' || row === 'e');
}).sort(cmpKana).map(e => {
  const slug = bucketOf(e.kana, normWord(e.word));
  const cls = slug === 'ru-godan-ie' ? '五段' : '一段';
  return `| ${e.kana} | ${e.word} | ${cls} | ${slug} |`;
});

const report = `# N2动词.md → verb/units/ 转换清洗报告

由 \`node verb/convert.js\` 自动生成（幂等，可重跑）。源：\`../source/N2动词.md\`（仓库外，不入库）。

## 账目

- 表格行数 ${stats.rows}，拆分出词条格 ${stats.halves}
- 收下词条 ${stats.entries}（其中手清 ${stats.overrides}、修正 ${stats.fixed}）
- 合并重复 ${stats.merged}
- 丢弃非词条格 ${stats.skipped}
- 最终落库 **${total} 词 / ${counts.length} 单元**

| 单元 | 词数 | て形规则 |
| --- | --- | --- |
${counts.map(c => `| ${c.slug}（${c.title}） | ${c.n} | ${c.rule} |`).join('\n')}

## 一、合并的重复（同假名＋同汉字才并；同假名异汉字保留为不同词条）

${mergedRows.length ? mergedRows.map(s => '- ' + s).join('\n') : '-（无）'}

## 二、修正（源材料笔误）

${fixedRows.length ? fixedRows.map(s => '- ' + s).join('\n') : '-（无）'}

## 三、手清块：〜じる・ずる 那一段（表格粘连，逐条手工清出）

${overrideRows.map(s => '- ' + s).join('\n')}

## 四、speak_word（display ≠ 朗读，TTS 只读第一形态）

${speakRows.map(s => '- ' + s).join('\n')}

## 五、丢弃的非词条格

${skippedRows.map(s => '- ' + s).join('\n')}

## 六、五段特例桶（看着像一段、て形却是 って）

共 ${ieList.length} 词：

${ieList.join('\n')}

## 七、待审清单（数据照录源材料，不阻塞，请你过一眼）

${REVIEW.map(s => '- ' + s).join('\n')}

## 八、い/え 行 〜る 动词分类全表（抽检用）

| 假名 | 汉字 | 判定 | 单元 |
| --- | --- | --- | --- |
${ieRowList.join('\n')}

## 九、断言结果

- 抽样分桶：${spotBad.length ? '✗ ' + spotBad.join('；') : '✓ 15 个抽样词全部落在预期桶'}
- 空桶：${emptyBuckets.length ? '✗ ' + emptyBuckets.join(', ') : '✓ 11 个桶均有词'}
- 分桶失败：${bucketMiss.length ? '✗ ' + bucketMiss.join(', ') : '✓ 无'}
- 列数异常行：${anomalies.length ? anomalies.join('；') : '✓ 无'}
- 释义为空且无补齐规则：${anomalies.filter(a => a.includes('释义为空')).length ? '✗ 见上' : '✓ 无'}
`;

fs.writeFileSync(REPORT, report, 'utf8');

console.log(`落库 ${total} 词 / ${counts.length} 单元`);
counts.forEach(c => console.log(`  ${c.slug.padEnd(12)} ${String(c.n).padStart(4)} 词   ${c.title} · ${c.rule}`));
console.log(`合并 ${stats.merged} · 手清 ${stats.overrides} · 修正 ${stats.fixed} · 丢弃 ${stats.skipped}`);
if(spotBad.length){ console.log('✗ 抽样分桶不符：'); spotBad.forEach(s => console.log('   ' + s)); }
if(bucketMiss.length){ console.log('✗ 分桶失败：' + bucketMiss.join(', ')); }
if(emptyBuckets.length){ console.log('✗ 空桶：' + emptyBuckets.join(', ')); }
if(anomalies.length){ console.log('⚠ 异常：'); anomalies.forEach(a => console.log('   ' + a)); }
console.log('报告：.scratch/verb-module/cleaning-report.md');
process.exit(spotBad.length || bucketMiss.length || emptyBuckets.length ? 1 : 0);
