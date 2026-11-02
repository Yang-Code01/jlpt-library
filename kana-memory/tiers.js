/* ============================================================================
   假名翻牌 · 进阶档（汉字词 ↔ 假名读音）
   数据只读取 typing/data/{n5,n4}.js 暴露的 window.TYPING_WORDS_N5 / _N4
   （{w,k,m,p}，由 index.html 以 <script src> 引）；不复制数据、不 fetch、无生成步骤。

   加载时机：本文件排在 page.js 之前，那一刻 window.KanaApp 还不存在，所以把档位
   定义压进 window.KanaTierDefs，由 page.js 的 boot() 在读取记忆档位之前排空。
   词表缺失（页面没引 data 脚本）时**不抛错**：这一档退化成空池，入门档照玩。
   ============================================================================ */
(function (root) {
'use strict';

var PAIR_COUNT = 10;     // 一局 10 对 / 20 张，与 page.js 的固定牌墙一致
var pool = null;         // 懒建的候选词池（同一页只建一次）

/* 词池：w 归到「第一个写法」（"伯父; 叔父さん" → "伯父"），并剔掉纯假名词
   —— w === k 的词没有「汉字词 ↔ 读音」这层关系。 */
function wordPool() {
  if (pool) return pool;
  var lists = [root.TYPING_WORDS_N5, root.TYPING_WORDS_N4];
  var out = [];
  for (var i = 0; i < lists.length; i++) {
    var list = lists[i];
    if (!list || !list.length) continue;
    for (var j = 0; j < list.length; j++) {
      var entry = list[j];
      if (!entry || !entry.w || !entry.k) continue;
      var w = String(entry.w).split(';')[0].trim();
      var k = String(entry.k).trim();
      if (!w || !k || w === k) continue;
      out.push({ w: w, k: k });
    }
  }
  pool = out;
  return pool;
}

/* 抽一局：洗过词池后贪心取 10 对，**两面的字面都不许在本局里重复**。
   key 唯一并不够：同字不同词（「伯父; 叔父さん」与别的写法归一到同一个 w）、
   同读音不同词（かた / かぜ / は 在词表里各有多条）都会拼出两张字面相同的牌，
   那一局就没有唯一解了。所以占位集合里同时记 w 与 k 两个面。 */
function build(rng) {
  var order = root.KanaCore.shuffle(wordPool(), rng);
  var used = Object.create(null);        // 字面 -> true
  var pairs = [];
  for (var i = 0; i < order.length && pairs.length < PAIR_COUNT; i++) {
    var entry = order[i];
    if (used[entry.w] || used[entry.k]) continue;
    used[entry.w] = true;
    used[entry.k] = true;
    pairs.push({ key: entry.w, a: entry.w, b: entry.k, kind: 'kana-word' });
  }
  return pairs;
}

var midTier = {
  id: 'mid',
  label: '进阶',
  hint: '汉字词 ↔ 读音',
  labels: { a: '漢字語', b: '読み' },
  build: build
};

if (root.KanaApp && typeof root.KanaApp.registerTier === 'function') {
  root.KanaApp.registerTier(midTier);    // page.js 已经先跑过（脚本顺序变了）也能接上
} else {
  (root.KanaTierDefs = root.KanaTierDefs || []).push(midTier);
}

})(typeof window !== 'undefined' ? window : globalThis);
