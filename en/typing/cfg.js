/* ---------------------------------------------------------------------------
   英语打字 · 语言层覆盖对象（必须在 typing/typing.js 之前加载）

   打字内核（typing/typing.js）把语言相关的东西全部提到 window.TYPING_CFG 里，
   不设时逐字保持日语原行为。本文件只做四件事：
     1. 把五个难度档换成词表四档（1k / 2k / 3k / 4k），词池由 words.js 注入；
     2. 把发音语言换成 en-US；
     3. 把「期望输入串」从罗马字换成词本身（match 钩子 + readings）；
     4. 把传送带时长单位从假名数换成字母数。

   词组（4k 档的固定搭配，如 "at once"）用连续输入字母、不按空格：
   match 里直接拿去掉空格的 k 比对，所以玩家敲 "atonce" 即算完成。
   --------------------------------------------------------------------------- */
window.TYPING_CFG = {
  /* 四个档位：词池已由 words.js 注入同名全局，故 src 只用于加载失败时的提示文案。 */
  tiers: {
    '1k': { key: '1k', label: '1k', src: 'words.js', global: 'TYPING_WORDS_1K' },
    '2k': { key: '2k', label: '2k', src: 'words.js', global: 'TYPING_WORDS_2K' },
    '3k': { key: '3k', label: '3k', src: 'words.js', global: 'TYPING_WORDS_3K' },
    '4k': { key: '4k', label: '4k', src: 'words.js', global: 'TYPING_WORDS_4K' }
  },
  defaultTier: '1k',
  srcPrefix: 'en/typing/',

  speechLang: 'en-US',
  voiceMatch: function (lang) { return /^en/i.test(lang || ''); },

  /* 期望输入串：英语就是把单词本身敲一遍（readings 只有一个候选）。 */
  readings: function (word) {
    return (word && word.k) ? [String(word.k)] : [];
  },

  /* 判定一个字符：与 Romaji.match 同形（complete / ok / wrong），但用词形比对。 */
  match: function (word, typed) {
    var full = (word && word.k) ? String(word.k) : '';
    var t = (typeof typed === 'string') ? typed : '';
    if (!full) return { status: 'wrong', expects: [] };
    if (t === full) return { status: 'complete', expects: [] };
    if (full.indexOf(t) === 0) return { status: 'ok', expects: [full.charAt(t.length)] };
    return { status: 'wrong', expects: [] };
  },

  /* 传送带停留时长按字母数算（区间与日语侧同一套常量：见 typing.js 顶部）。 */
  flowLength: function (word) {
    return (word && word.k) ? String(word.k).length : 0;
  }
};
