/* ---------------------------------------------------------------------------
   英语打字 · 词池（运行时由词表现算，不落新数据文件）

   词源与词表、听写同一份：en/data/vocab.js 的 window.EN_VOCAB（3,766 词 / 77 单元）。
   四档的划分与词表一致：1k / 2k / 3k / 4k。
   4k 档额外混入固定搭配（en/typing/phrases.js，由 tools/en-typing.mjs 从站内阅读正文挖出）。

   词条形状（内核只认这四个字段）：
     w = 卡片大字显示的写法（词组带空格，如 "at once"）
     k = 期望输入串（词组去掉空格，如 "atonce"；内核 match / readings 都用它）
     m = 中文释义首行（词组没有中文释义，留空）
     p = 词性。留空：词表的 tr 首行已自带「n.」「adj.」前缀，再拼一次就重复了。
   --------------------------------------------------------------------------- */
(function () {
  'use strict';
  var V = (typeof window !== 'undefined' && window.EN_VOCAB) || null;
  if (!V || !V.words) return;

  /* 只保留能敲出来的词形：内核只接受 a–z 与连字符，撇号词（n't / o'clock）无法输入。 */
  var TYPEABLE = /^[a-z][a-z-]*$/;

  function firstLine(s) {
    return String(s == null ? '' : s).split(/\\n|\n/)[0].trim();
  }

  var pools = { '1k': [], '2k': [], '3k': [], '4k': [] };
  var dropped = [];
  for (var i = 0; i < V.words.length; i++) {
    var w = V.words[i];
    var pool = pools[w.band];
    if (!pool) continue;
    if (!TYPEABLE.test(w.w)) { dropped.push(w.w); continue; }
    pool.push({ w: w.w, k: w.w, m: firstLine(w.tr), p: '' });
  }

  var phrases = (typeof window !== 'undefined' && window.EN_TYPING_PHRASES) || [];
  var usedPhrases = 0;
  for (var j = 0; j < phrases.length; j++) {
    var it = phrases[j];
    if (!it || !/^[a-z]+$/.test(it.k || '') || !it.w) continue;
    pools['4k'].push({ w: String(it.w), k: String(it.k), m: '', p: '' });
    usedPhrases++;
  }

  window.TYPING_WORDS_1K = pools['1k'];
  window.TYPING_WORDS_2K = pools['2k'];
  window.TYPING_WORDS_3K = pools['3k'];
  window.TYPING_WORDS_4K = pools['4k'];

  /* 供页面与测试核对（门槛数字写死在 HTML 里，对不上就会被测试抓住）。 */
  window.EN_TYPING_META = {
    counts: {
      '1k': pools['1k'].length,
      '2k': pools['2k'].length,
      '3k': pools['3k'].length,
      '4k': pools['4k'].length
    },
    phrases: usedPhrases,
    dropped: dropped
  };
})();
