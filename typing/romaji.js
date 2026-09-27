/* ============================================================
   打字练习 · 假名 → 罗马字判定引擎
   口径：宽松（见 .scratch/typing-module/PRD.md §2.1 / §4）
   - 清音 / 浊音 / 半浊音 / 拗音：一个假名可有多种合法拼法
   - ん = n 或 nn；っ = 双写下一假名首辅音；长音 ー = -
   对外 API（全局 Romaji，供 typing.js 调用）：
     Romaji.readings(kana) -> string[]   该假名词全部完整写法（去重 + 稳定排序）
     Romaji.match(kana, typed)          逐字符判定
       -> { status: 'ok' | 'complete' | 'wrong', expects: string[] }
   用法：file:// 下以 <script src="romaji.js"> 直接引入；
        Node 测试时 require 本文件后读 globalThis.Romaji。
   无依赖、无构建、无 ES module。
   ============================================================ */
(function (root) {
'use strict';

/* ------------------------------------------------------------
   ① 假名 → 合法罗马字候选表
   值统一规范为数组；未列多写法的用单元素数组简写。
   底稿参考 n5/basics/01-gojuon.html、02-dakuon-youon.html，
   但以本表为准（PRD §4：以代码内维护为准）。
   ------------------------------------------------------------ */
var KANA = {
  /* ===== 清音（五十音） ===== */
  'あ': ['a'], 'い': ['i'], 'う': ['u'], 'え': ['e'], 'お': ['o'],
  'か': ['ka'], 'き': ['ki'], 'く': ['ku'], 'け': ['ke'], 'こ': ['ko'],
  'さ': ['sa'], 'し': ['shi', 'si'], 'す': ['su'], 'せ': ['se'], 'そ': ['so'],
  'た': ['ta'], 'ち': ['chi', 'ti'], 'つ': ['tsu', 'tu'], 'て': ['te'], 'と': ['to'],
  'な': ['na'], 'に': ['ni'], 'ぬ': ['nu'], 'ね': ['ne'], 'の': ['no'],
  'は': ['ha'], 'ひ': ['hi'], 'ふ': ['fu', 'hu'], 'へ': ['he'], 'ほ': ['ho'],
  'ま': ['ma'], 'み': ['mi'], 'む': ['mu'], 'め': ['me'], 'も': ['mo'],
  'や': ['ya'], 'ゆ': ['yu'], 'よ': ['yo'],
  'ら': ['ra'], 'り': ['ri'], 'る': ['ru'], 'れ': ['re'], 'ろ': ['ro'],
  'わ': ['wa'], 'を': ['wo', 'o'],
  'ん': ['n', 'nn'],

  /* ===== 浊音 ===== */
  'が': ['ga'], 'ぎ': ['gi'], 'ぐ': ['gu'], 'げ': ['ge'], 'ご': ['go'],
  'ざ': ['za'], 'じ': ['ji', 'zi'], 'ず': ['zu'], 'ぜ': ['ze'], 'ぞ': ['zo'],
  'だ': ['da'], 'ぢ': ['di', 'ji'], 'づ': ['du', 'zu'], 'で': ['de'], 'ど': ['do'],
  'ば': ['ba'], 'び': ['bi'], 'ぶ': ['bu'], 'べ': ['be'], 'ぼ': ['bo'],

  /* ===== 半浊音 ===== */
  'ぱ': ['pa'], 'ぴ': ['pi'], 'ぷ': ['pu'], 'ぺ': ['pe'], 'ぽ': ['po'],

  /* ===== 拗音（两字符一个音） ===== */
  'きゃ': ['kya'], 'きゅ': ['kyu'], 'きょ': ['kyo'],
  'しゃ': ['sha', 'sya'], 'しゅ': ['shu', 'syu'], 'しょ': ['sho', 'syo'],
  'ちゃ': ['cha', 'cya', 'tya'], 'ちゅ': ['chu', 'cyu', 'tyu'], 'ちょ': ['cho', 'cyo', 'tyo'],
  'にゃ': ['nya'], 'にゅ': ['nyu'], 'にょ': ['nyo'],
  'ひゃ': ['hya'], 'ひゅ': ['hyu'], 'ひょ': ['hyo'],
  'みゃ': ['mya'], 'みゅ': ['myu'], 'みょ': ['myo'],
  'りゃ': ['rya'], 'りゅ': ['ryu'], 'りょ': ['ryo'],
  'ぎゃ': ['gya'], 'ぎゅ': ['gyu'], 'ぎょ': ['gyo'],
  'じゃ': ['ja', 'zya', 'jya'], 'じゅ': ['ju', 'zyu', 'jyu'], 'じょ': ['jo', 'zyo', 'jyo'],
  'ぢゃ': ['dya', 'ja'], 'ぢゅ': ['dyu', 'ju'], 'ぢょ': ['dyo', 'jo'],
  'びゃ': ['bya'], 'びゅ': ['byu'], 'びょ': ['byo'],
  'ぴゃ': ['pya'], 'ぴゅ': ['pyu'], 'ぴょ': ['pyo'],

  /* ===== 小写元音 / 外来语常见组合（补充，宽松接受） ===== */
  'ぁ': ['a'], 'ぃ': ['i'], 'ぅ': ['u'], 'ぇ': ['e'], 'ぉ': ['o'], 'ゎ': ['wa'],
  'ふぁ': ['fa'], 'ふぃ': ['fi'], 'ふぇ': ['fe'], 'ふぉ': ['fo'],
  'てぃ': ['ti'], 'でぃ': ['di'],
  'うぃ': ['wi'], 'うぇ': ['we'], 'うぉ': ['wo', 'o'],
  'きぇ': ['kye'], 'しぇ': ['she', 'sye'], 'ちぇ': ['che', 'cye', 'tye'],
  'じぇ': ['je', 'zye', 'jye'],
  'つぁ': ['tsa'], 'つぃ': ['tsi'], 'つぇ': ['tse'], 'つぉ': ['tso'],
  'とぅ': ['tu'], 'どぅ': ['du'],
  'ゔ': ['vu']
};

/* 促音 っ 单独成词尾时（罕见）：接受 xtu / ltu 系列，避免无法输入 */
var SOKUON_ALONE = ['xtu', 'ltu', 'xtsu', 'ltsu'];

/* 长音 ー */
var CHOON = ['-'];

/* 把候选值统一成数组 */
function toArr(v) { return Array.isArray(v) ? v : [v]; }

/* 两集合做笛卡尔拼接：['ga'] × ['kko'] -> ['gakko'] */
function cross(a, b) {
  var out = [];
  for (var i = 0; i < a.length; i++) {
    for (var j = 0; j < b.length; j++) out.push(a[i] + b[j]);
  }
  return out;
}

/* 去重 + 稳定排序（确定性输出） */
function uniqSort(list) {
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    if (!seen[list[i]]) { seen[list[i]] = 1; out.push(list[i]); }
  }
  return out.sort();
}

/* ------------------------------------------------------------
   ② 分词：把假名串切成「拗音整体 / 促音 / 长音 / 单假名」令牌
   两字符的拗音或外来语音优先整体识别。
   ------------------------------------------------------------ */
function tokenize(kana) {
  var tokens = [], i = 0, n = kana.length;
  while (i < n) {
    var ch = kana.charAt(i);
    if (ch === 'っ') { tokens.push('っ'); i++; continue; }
    if (ch === 'ー') { tokens.push('ー'); i++; continue; }
    if (i + 1 < n) {
      var two = kana.slice(i, i + 2);
      if (KANA[two]) { tokens.push(two); i += 2; continue; }
    }
    tokens.push(ch); i++;
  }
  return tokens;
}

/* ------------------------------------------------------------
   ③ 促音 っ 的候选：双写下一个假名的首辅音
   がっこう -> っ+こ 得 'kko'；まっちゃ -> っ+ちゃ 得 'ccha'
   另补 Hepburn 习惯的 tch 形（match 用的 'matcha'）。
   ------------------------------------------------------------ */
function sokuonCands(nextTok) {
  var read = toArr(KANA[nextTok]);
  var out = [];
  for (var i = 0; i < read.length; i++) {
    var r = read[i];
    out.push(r.charAt(0) + r); // 双写首辅音：ko -> kko
  }
  /* ち 行：Hepburn 促音写作 tch（まっちゃ = matcha） */
  if (nextTok === 'ち' || nextTok === 'ちゃ' || nextTok === 'ちゅ' || nextTok === 'ちょ') {
    for (var j = 0; j < read.length; j++) {
      if (read[j].charAt(0) === 'c') out.push('t' + read[j]); // cha -> tcha
    }
  }
  return out;
}

/* ------------------------------------------------------------
   ④ readings(kana)：逐令牌取候选 → 笛卡尔积 → 去重排序
   促音会「吃掉」下一个令牌（跨假名判定）。
   ------------------------------------------------------------ */
function readings(kana) {
  if (!kana || typeof kana !== 'string') return [];
  var tokens = tokenize(kana);
  var acc = [''];
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i], cands;
    if (tok === 'っ') {
      var next = tokens[i + 1];
      if (next && next !== 'っ' && next !== 'ー' && KANA[next]) {
        cands = sokuonCands(next);
        i++; // 与下一令牌合并，跳过它
      } else {
        cands = SOKUON_ALONE; // 词尾促音：取简并写法
      }
    } else if (tok === 'ー') {
      cands = CHOON;
    } else if (KANA[tok]) {
      cands = toArr(KANA[tok]);
    } else {
      cands = [tok]; // 未收录字符：原样保留（不产生额外合法拼法）
    }
    acc = cross(acc, cands);
  }
  return uniqSort(acc);
}

/* ------------------------------------------------------------
   ⑤ match(kana, typed)：逐字符判定
   - typed 命中某条完整写法 -> 'complete'（优先于前缀，处理 ん=n/nn）
   - 否则是某条完整写法的前缀 -> 'ok'，expects 为下一字符候选集合
   - 否则 -> 'wrong'
   - typed 为空 -> 'ok'，expects 为首字符候选集合
   ------------------------------------------------------------ */
function match(kana, typed) {
  var t = (typeof typed === 'string') ? typed : '';
  var fulls = readings(kana);
  if (!fulls.length) return { status: 'wrong', expects: [] };

  /* 优先完整匹配（例如 ん：'n' 既是完整写法，又是 'nn' 的前缀） */
  for (var i = 0; i < fulls.length; i++) {
    if (fulls[i] === t) return { status: 'complete', expects: [] };
  }

  var expects = {}, isPrefix = false, has = false;
  for (var j = 0; j < fulls.length; j++) {
    if (fulls[j].indexOf(t) === 0) { // startsWith
      isPrefix = true;
      if (t.length < fulls[j].length) {
        var c = fulls[j].charAt(t.length);
        if (!has || !expects[c]) { expects[c] = 1; has = true; }
      }
    }
  }
  if (isPrefix) return { status: 'ok', expects: Object.keys(expects).sort() };
  return { status: 'wrong', expects: [] };
}

/* ------------------------------------------------------------
   ⑥ 挂到全局（兼容浏览器与 Node 测试环境）
   ------------------------------------------------------------ */
root.Romaji = {
  readings: readings,
  match: match
};

})(typeof window !== 'undefined' ? window : globalThis);
