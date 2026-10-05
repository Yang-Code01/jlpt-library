/* ---------------------------------------------------------------------------
   英语打字 · 4k 档固定搭配（生成物，请勿手改）

   生成：node tools/en-typing.mjs gen      校验：node tools/en-typing.mjs check
   语料：站内 30 篇阅读正文（en/reading/<档>/NN.html，Project Gutenberg 公有领域）
   口径：二元组 · 两侧词都在词表前 2000 名 · 非双功能词 · 不含限定词 ·
         出现 ≥4 次且 PMI ≥3.3，按次数降序取前 120 条
   统计：语料 30 篇 / 46,191 次分词 /
         候选 227 条（过门槛后按次数截取）
   c = 在语料里出现的次数（仅用于复核与排序，运行时不使用）
   --------------------------------------------------------------------------- */
window.EN_TYPING_PHRASES = [
  { w: "young man", k: "youngman", c: 24 },
  { w: "so much", k: "somuch", c: 21 },
  { w: "at once", k: "atonce", c: 17 },
  { w: "sort of", k: "sortof", c: 14 },
  { w: "old man", k: "oldman", c: 8 },
  { w: "according to", k: "accordingto", c: 7 },
  { w: "at least", k: "atleast", c: 7 },
  { w: "come back", k: "comeback", c: 7 },
  { w: "too much", k: "toomuch", c: 7 },
  { w: "as soon as", k: "assoonas", c: 6 },
  { w: "at home", k: "athome", c: 6 },
  { w: "at last", k: "atlast", c: 6 },
  { w: "in order", k: "inorder", c: 6 },
  { w: "instead of", k: "insteadof", c: 6 },
  { w: "much more", k: "muchmore", c: 6 },
  { w: "once more", k: "oncemore", c: 6 },
  { w: "point out", k: "pointout", c: 6 },
  { w: "be sure", k: "besure", c: 5 },
  { w: "better than", k: "betterthan", c: 5 },
  { w: "even if", k: "evenif", c: 5 },
  { w: "listen to", k: "listento", c: 5 },
  { w: "look at", k: "lookat", c: 5 },
  { w: "or rather", k: "orrather", c: 5 },
  { w: "very much", k: "verymuch", c: 5 },
  { w: "yes sir", k: "yessir", c: 5 },
  { w: "be able to", k: "beableto", c: 4 },
  { w: "couple of", k: "coupleof", c: 4 },
  { w: "first time", k: "firsttime", c: 4 },
  { w: "how much", k: "howmuch", c: 4 },
  { w: "in front", k: "infront", c: 4 },
  { w: "most likely", k: "mostlikely", c: 4 },
  { w: "on account", k: "onaccount", c: 4 },
  { w: "ought to", k: "oughtto", c: 4 },
  { w: "set out", k: "setout", c: 4 },
  { w: "so often", k: "sooften", c: 4 },
  { w: "try to", k: "tryto", c: 4 },
  { w: "willing to", k: "willingto", c: 4 },
];
