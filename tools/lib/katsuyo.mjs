/* ============================================================================
   日语分词与词形还原（纯函数，零依赖）

   为什么需要它：JMdict 的辞書形是「走る」，青空文庫 正文里是「走った／走れば／走り」。
   没有形态素解析器，就得自己把「走った」认回「走る」。

   试过但**否决**的做法（两个，都实测过）：
   1) 把每个动词的活用形全展开进词表再最长匹配 —— 「凝る」的命令形正好是「これ」，
      于是「これは」被判成「凝る＋は」；「の」被认成「乃」。词表被污染成一片假命中。
   2) 词干 + 通用语尾表 —— 语尾其实**分行**：書く是「書いて」、噛む是「噛んで」，
      用同一张表会把「かった」认成「噛む」。于是「高かった」被切碎。

   现在的做法（三步，取最长者）：
     1) 辞書形直接匹配（漢字单字也认：村・山・火；假名单字只认功能词）；
     2) 词干（辞書形去末字）+ **按该动词行／词性生成的合法语尾**；
     3) 都不成立就按同类字符聚团，标为未収録 —— 不硬拆成单字。

   判据只有这一份：生成器用它切词与判定「哪些词该高亮」，校验用它跑固定用例。
   页面不重复实现 —— 正文每个词在生成时就带上 data-l（辞書形），视图层只照着渲染。

   已知缺口（写进 reading/README.md，不是 bug）：
   · 补助动词（〜ておく／〜てしまう／〜なさそう）与口语缩约（〜ちゃう）不展开；
   · 复合动词、惯用句只取成分，不保证语义切分；
   · 特殊活用（v5aru／v5u-s／v1-s）与文语活用不处理。
   ========================================================================== */

/* ---- 行变：五段动词按语尾换行 ---- */
const A_ROW = { う: 'わ', く: 'か', ぐ: 'が', す: 'さ', つ: 'た', ぬ: 'な', ぶ: 'ば', む: 'ま', る: 'ら' };
const I_ROW = { う: 'い', く: 'き', ぐ: 'ぎ', す: 'し', つ: 'ち', ぬ: 'に', ぶ: 'び', む: 'み', る: 'り' };
const E_ROW = { う: 'え', く: 'け', ぐ: 'げ', す: 'せ', つ: 'て', ぬ: 'ね', ぶ: 'べ', む: 'め', る: 'れ' };
const O_ROW = { う: 'お', く: 'こ', ぐ: 'ご', す: 'そ', つ: 'と', ぬ: 'の', ぶ: 'ぼ', む: 'も', る: 'ろ' };
const TE_ROW = { う: 'って', つ: 'って', る: 'って', く: 'いて', ぐ: 'いで', す: 'して', ぬ: 'んで', ぶ: 'んで', む: 'んで' };

const taOf = (te) => te.slice(0, -1) + (te.endsWith('で') ? 'だ' : 'た');
const uniq = (a) => [...new Set(a)];

/** 五段：语尾按末字所属行生成（走る→ります/らない/って…；書く→きます/かない/いて…） */
function godanTails(last) {
  const a = A_ROW[last], i = I_ROW[last], e = E_ROW[last], o = O_ROW[last], te = TE_ROW[last];
  if (!a) return [];
  return uniq([
    i + 'ます', i + 'ました', i + 'ません', i + 'たい', i + 'ながら',
    a + 'ない', a + 'なかった', a + 'れる', a + 'せる', a + 'ず',
    e + 'ば', e + 'る', o + 'う',
    te, taOf(te), i, e, a,
  ]);
}

const ICHIDAN_TAILS = uniq([
  'ます', 'ました', 'ません', 'たい', 'ながら', 'ない', 'なかった',
  'られる', 'させる', 'れば', 'よう', 'ず', 'て', 'た', 'ろ', 'よ', 'れ',
]);
const SURU_TAILS = uniq(['します', 'しました', 'しない', 'される', 'させる', 'すれば', 'しよう', 'しろ', 'して', 'した', 'し', 'す', 'さ', 'せ']);
const KURU_TAILS = uniq(['ます', 'ました', 'ません', 'て', 'た', 'ない', 'なかった', 'られる', 'させる', 'れば', 'い', 'よう', 'きます', 'きました', 'きて', 'きた', 'こない', 'こられる', 'こさせる', 'くれば', 'こい', 'こよう']);
const ADJ_TAILS = uniq(['かった', 'くない', 'ければ', 'かろう', 'くて', 'さ', 'く']);

const GODAN_TAGS = ['v5u', 'v5w', 'v5k', 'v5g', 'v5s', 'v5t', 'v5n', 'v5b', 'v5m', 'v5r', 'v5k-s', 'v5aru', 'v5u-s', 'v1-s'];

const POS_ZH = {
  n: '名詞', pn: '代名詞', adj: '形容詞', 'adj-i': '形容詞', 'adj-ix': '形容詞', 'adj-na': '形容動詞',
  adv: '副詞', prt: '助詞', conj: '接続詞', int: '感動詞', exp: '慣用句', num: '数詞',
  ctr: '助数詞', pref: '接頭辞', suf: '接尾辞', aux: '助動詞', cop: '指定詞', unc: '未分類',
  v1: '動詞', vk: '動詞', vs: '動詞', 'vs-s': '動詞', 'vs-i': '動詞',
};
for (const t of GODAN_TAGS) POS_ZH[t] = '動詞';

/* JMdict 的标签远不止上面这些（adj-pn=連体詞、vz=サ変ずる、n-suf=接尾辞…）。
   精确表没命中时按前缀兜底，否则这些词的词性会整个变空、连带中文门禁也看不见它们。 */
const POS_FALLBACK = [
  [/^adj-pn$/, '連体詞'], [/^adj-f$/, '連体詞'], [/^adj-na$/, '形容動詞'], [/^adj-i/, '形容詞'], [/^adj/, '形容詞'],
  [/^vz$/, '動詞'], [/^v[1-9]?/, '動詞'], [/^vs/, '動詞'], [/^vk$/, '動詞'], [/^vi$/, '動詞'], [/^vt$/, '動詞'],
  [/^n-adv$/, '副詞'], [/^n-t$/, '名詞'], [/^n-suf$/, '接尾辞'], [/^n-pref$/, '接頭辞'], [/^n/, '名詞'],
  [/^adv/, '副詞'], [/^exp/, '慣用句'], [/^prt/, '助詞'], [/^conj/, '接続詞'], [/^int/, '感動詞'],
  [/^ctr/, '助数詞'], [/^pref/, '接頭辞'], [/^suf/, '接尾辞'], [/^num/, '数詞'], [/^cop/, '指定詞'], [/^aux/, '助動詞'],
];

function posZh(tags) {
  for (const t of tags) if (POS_ZH[t]) return POS_ZH[t];
  for (const t of tags) {
    for (const [re, zh] of POS_FALLBACK) if (re.test(t)) return zh;
  }
  return '';
}

/** 词性标签 → 活用类 */
function classOfTag(tag) {
  if (GODAN_TAGS.includes(tag)) return 'godan';
  if (tag === 'v1') return 'ichidan';
  if (tag === 'vs' || tag === 'vs-s' || tag === 'vs-i') return 'suru';
  if (tag === 'vk') return 'kuru';
  if (tag === 'adj-i' || tag === 'adj-ix') return 'adj';
  return '';
}

/* ------------------------------------------------------------ 词表构建 */

const KANJI = /[\u3400-\u9fff\u3005\u3006]/;
const KANA = /[\u3040-\u30ff\u30fc]/;
const LATIN = /[A-Za-zＡ-Ｚａ-ｚ]/;
const DIGIT = /[0-9０-９]/;

export function classOf(ch) {
  if (KANJI.test(ch)) return 'kanji';
  if (KANA.test(ch)) return 'kana';
  if (LATIN.test(ch)) return 'latin';
  if (DIGIT.test(ch)) return 'digit';
  return 'punct';
}

export function buildLexicon(words) {
  const forms = new Map();   // 辞書形／表記 → 词条
  const stems = new Map();   // 词干（辞書形去末字）→ [词条]
  let maxLen = 1;

  const addForm = (surface, entry) => {
    if (!surface) return;
    const old = forms.get(surface);
    /* 同一个表层形多条候选时按分数取：功能词 > 常见汉字表记 > 常见读音。
       不这么做，「は」会被当成「羽」、「こと」会被当成「琴」。 */
    if (!old || entry.score > old.score) forms.set(surface, entry);
    if (surface.length > maxLen) maxLen = surface.length;
  };

  for (const w of words) {
    const kanaAll = (w.kana || []).map((k) => k.text);
    const kana = kanaAll.slice(0, 1);   // 只认主读音：次读音会把「は」挂到「羽（はね）」上
    const kanji = (w.kanji || []).filter((k) => !(k.tags || []).includes('rK')).map((k) => k.text);
    if (!kana.length) continue;
    const tags = [...new Set((w.sense || []).flatMap((s) => s.partOfSpeech || []))];
    const gloss = (w.sense || [])[0]?.gloss?.[0]?.text || '';
    const cls = classOfTag(tags.find((t) => classOfTag(t)) || '');
    const posLabel = posZh(tags);
    const entry = {
      lemma: kanji[0] || kana[0],
      kana: kana[0],
      pos: posLabel,
      en: gloss.length > 70 ? gloss.slice(0, 68) + '…' : gloss,
      cls,
      tails: [],
      score: (/助詞|助動詞|接続詞|感動詞|指定詞/.test(posLabel) ? 4 : 0) +
        ((w.kanji || [])[0]?.common === true ? 2 : 0) +
        ((w.kana || [])[0]?.common === true ? 1 : 0),
    };
    if (cls === 'godan') entry.tails = godanTails(kana[0].slice(-1));
    if (cls === 'godan' && /行$/.test(kanji[0] || '') && kana[0].endsWith('く')) entry.tails = uniq([...entry.tails, 'って', 'った']);
    else if (cls === 'ichidan') entry.tails = ICHIDAN_TAILS;
    else if (cls === 'suru') entry.tails = SURU_TAILS;
    else if (cls === 'kuru') entry.tails = KURU_TAILS;
    else if (cls === 'adj') entry.tails = ADJ_TAILS;

    for (const s of [...kanji, ...kana]) addForm(s, entry);
    if (cls) {
      for (const s of [...kanji, ...kana]) {
        if (s.length < 2) continue;
        const stem = s.slice(0, -1);
        if (!stems.has(stem)) stems.set(stem, []);
        const arr = stems.get(stem);
        if (!arr.some((x) => x.lemma === entry.lemma && x.kana === entry.kana)) arr.push(entry);
      }
    }
  }
  /* 人工纠偏：同分碰撞里最高频的几个。判据是「读者会以为查错词」而不是「算法不优雅」，
     宁可列一小张表，也不让「きいた」永远显示成「効く」。 */
  const OVERRIDES = [
    ['きいた', '聞く'], ['きいて', '聞く'], ['ききます', '聞く'], ['きこえ', '聞こえる'],
    ['行った', '行く'], ['行って', '行く'], ['行きます', '行く'],
  ];
  for (const [surface, lemma] of OVERRIDES) {
    let hit = null;
    for (const e of forms.values()) {
      if (e.lemma === lemma) { hit = e; break; }
    }
    if (hit) forms.set(surface, hit);
  }

  return { forms, stems, maxLen: Math.min(maxLen, 12) };
}

/* -------------------------------------------------------------- 分词 */

/* 语法成分（輔助動詞・補助用言）。词典里往往查不到或被活用形撞掉，
   单独成一个 token 比乱认回某个动词诚实得多（点击只会显示「文型成分」）。 */
const GRAMMAR = new Map([
  ['います', 'います'], ['いました', 'いました'], ['いません', 'いません'],
  ['ません', 'ません'], ['ませんでした', 'ませんでした'], ['ましょう', 'ましょう'],
  ['でした', 'でした'], ['でしょう', 'でしょう'], ['ています', 'ています'], ['ていました', 'ていました'],
  ['ておく', 'ておく'], ['てしまう', 'てしまう'], ['てください', 'てください'],
  ['ください', 'ください'], ['なさい', 'なさい'], ['ちゃう', 'ちゃう'],
]);

function directAt(text, i, lex) {
  const minLen = classOf(text[i]) === 'kanji' ? 1 : 2;
  const cap = Math.min(lex.maxLen, text.length - i);
  for (let l = cap; l >= minLen; l--) {
    const e = lex.forms.get(text.slice(i, i + l));
    if (e) return { e, len: l };
  }
  return null;
}

/** 语法成分匹配（只认 kana，长的优先） */
function grammarAt(text, i) {
  for (let l = Math.min(6, text.length - i); l >= 2; l--) {
    const w = text.slice(i, i + l);
    const lemma = GRAMMAR.get(w);
    if (lemma) return { entry: { lemma, kana: lemma, pos: '補助動詞', en: '', cls: '', tails: [], score: 5 }, len: l };
  }
  return null;
}

/** 假名表层一律用假名当词条：否则「の」会以「乃」、「こと」会以「琴」的身份出现 */
function displayEntry(surface, entry) {
  if (!entry) return entry;
  if (classOf(surface[0]) !== 'kana' || /[㐀-鿿]/.test(surface)) return entry;
  return { ...entry, lemma: surface, kana: surface };
}

function stemAt(text, i, lex) {
  for (let sl = Math.min(8, text.length - i - 1); sl >= 1; sl--) {
    const cands = lex.stems.get(text.slice(i, i + sl));
    if (!cands) continue;
    const rest = text.slice(i + sl, i + sl + 7);
    let best = null;
    for (const e of cands) {
      for (const tail of e.tails) {
        if (rest.startsWith(tail)) {
          const len = sl + tail.length;
          if (!best || len > best.len || (len === best.len && (e.score || 0) > (best.e.score || 0))) best = { e, len };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * 切成 [{ surface, cls, entry|null, inflected? }]
 */
export function segment(text, lex) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const cls = classOf(ch);

    const direct = directAt(text, i, lex);
    const grammar = cls === 'kana' ? grammarAt(text, i) : null;
    const stem = stemAt(text, i, lex);

    // 取最长；同长时 辞書形直击 > 语法成分 > 词干还原
    const ranked = [
      direct && { e: direct.e, len: direct.len, kind: 'direct', rank: 0 },
      grammar && { e: grammar.entry, len: grammar.len, kind: 'grammar', rank: 1 },
      stem && { e: stem.e, len: stem.len, kind: 'stem', rank: 2 },
    ].filter(Boolean).sort((a, b) => b.len - a.len || a.rank - b.rank);
    const best = ranked[0];

    if (best) {
      const surface = text.slice(i, i + best.len);
      out.push({
        surface,
        cls,
        entry: best.kind === 'stem' ? best.e : displayEntry(surface, best.e),
        inflected: best.kind === 'stem',
      });
      i += best.len;
      continue;
    }

    if (cls === 'kanji' || cls === 'kana') {
      // 单字功能词（助詞・助動詞）单独成词，不并进后面的假名团
      const single = lex.forms.get(ch);
      if (single && /助詞|助動詞|接続詞|感動詞/.test(single.pos)) {
        out.push({ surface: ch, cls, entry: displayEntry(ch, single) });
        i++;
        continue;
      }
      let j = i + 1;
      while (j < text.length && classOf(text[j]) === cls && j - i < 8) {
        if (directAt(text, j, lex) || (cls === 'kana' && grammarAt(text, j)) || stemAt(text, j, lex)) break;
        j++;
      }
      out.push({ surface: text.slice(i, j), cls, entry: null });
      i = j;
      continue;
    }
    out.push({ surface: ch, cls, entry: null });
    i++;
  }
  return out;
}

/** 自检用：把一小段文字切成「表层=辞書形」对（未収録给 null） */
export function resolveAll(text, lex) {
  return segment(text, lex).map((t) => [t.surface, t.entry ? t.entry.lemma : null]);
}

/* ------------------------------------------------- 青空文庫 内联记号解析 */

const RE_RUBY = /｜([^《》\n]+)《([^》\n]+)》|([\u3400-\u9fff\u3005※]+)《([^》\n]+)》/g;
const RE_NOTE = /［＃[^］]*］/g;   // 字下げ・傍点・見出し注記：排版指令，整体丢掉
/* 外字：青空文庫 用「※［＃「埒のつくり＋虎」…］」表示无法录入的字。
   把注記去掉、**留下 ※** —— 直接删掉会在正文里留一个看不见的洞，
   读者会以为是自己漏看了字。 */

/**
 * 把一行正文拆成原子：
 *   { t:'text', s }           普通文字
 *   { t:'ruby', base, rt }    带注音的汉字串（青空文庫 注記 → 页面的 <ruby>）
 * ［＃…］（字下げ・傍点・見出し注記）整体丢弃 —— 它们是排版指令，不是正文。
 */
export function parseInline(line) {
  const s = line.replace(/※［＃[^］]*］/g, '※').replace(RE_NOTE, '');
  const atoms = [];
  let last = 0;
  RE_RUBY.lastIndex = 0;
  let m;
  while ((m = RE_RUBY.exec(s))) {
    if (m.index > last) atoms.push({ t: 'text', s: s.slice(last, m.index) });
    atoms.push({ t: 'ruby', base: m[1] !== undefined ? m[1] : m[3], rt: m[2] !== undefined ? m[2] : m[4] });
    last = m.index + m[0].length;
  }
  if (last < s.length) atoms.push({ t: 'text', s: s.slice(last) });
  return atoms;
}

/** 正文按行切段（青空文庫 一行一段；空行与只有注記的行丢掉） */
export function paragraphsOf(body) {
  return body
    .split('\n')
    .map((l) => l.replace(/^[　\s]+/, '').replace(/\s+$/, ''))
    .filter((l) => l && !/^［＃[^］]*］$/.test(l));
}

/** 一行的「纯文本」：注記剥掉、ruby 只留汉字本体 —— 用来跟页面渲染后的文字对账 */
export function plainOf(line) {
  return parseInline(line).map((a) => (a.t === 'ruby' ? a.base : a.s)).join('');
}
