/* ============================================================================
   假名翻牌 · 高手档（日语词 ↔ 中文释义）+ 每档最高分 + 结算条
   这一层只做三件事，玩法与计时全在 game.js / page.js 里：
     ① 注册高手档：牌对是「读音（附汉字写法）」↔「中文释义」
     ② 每档最高分：localStorage 里一个档位一个键（jlpt-kana-best:<tier>），
        步数少者胜、同步数比用时；只有真的刷新纪录才提示
     ③ 结算条：补上「是否新纪录」与「再来一局」「换一档」两个按钮

   数据只读取 typing/data/{n5,n4}.js 暴露的 window.TYPING_WORDS_N5 / _N4
   （{w,k,m,p}），不复制数据、不 fetch、无生成步骤 —— 同 tiers.js。

   加载时机：本文件排在 page.js 之前，那一刻 window.KanaApp 还不存在。
   档位定义沿用票 02 定稿的注册契约（压进 window.KanaTierDefs，由 page.js 的
   boot() 在读取记忆档位之前排空）；事件钩子与 #k-best / #k-result 的填充只能等
   page.js 起来之后接，所以走 window 的 load 事件（那时 boot 早已跑完）。
   ============================================================================ */
(function (root) {
'use strict';

var PAIR_COUNT = 10;     // 一局 10 对 / 20 张，与 page.js 的固定牌墙一致
var BEST_KEY_PREFIX = 'jlpt-kana-best:';   // 键内含档位：三档各有各的纪录
var pool = null;         // 懒建的候选词池（同一页只建一次）

var App = null;          // boot 后的 KanaApp，init 时取
var els = {};            // 本层用到的插槽（#k-best、#k-result 与自建的两块）
var wired = false;

/* ------------------------------------------------------------ 高手档牌池 */

/* 词池：w 归到「第一个写法」（"伯父; 叔父さん" → "伯父"）。
   牌面 a = 「读音（附汉字写法）」；纯假名词（w === k）没有汉字写法，
   括号会变成 "おまわりさん（おまわりさん）" 这种空转，所以只写读音。
   牌面 b = 中文释义 m。 */
function wordPool() {
  if (pool) return pool;
  var lists = [root.TYPING_WORDS_N5, root.TYPING_WORDS_N4];
  var out = [];
  for (var i = 0; i < lists.length; i++) {
    var list = lists[i];
    if (!list || !list.length) continue;
    for (var j = 0; j < list.length; j++) {
      var entry = list[j];
      if (!entry || !entry.w || !entry.k || !entry.m) continue;
      var w = String(entry.w).split(';')[0].trim();
      var k = String(entry.k).trim();
      var m = String(entry.m).trim();
      if (!w || !k || !m) continue;
      out.push({ w: w, word: w === k ? k : k + '（' + w + '）', meaning: m });
    }
  }
  pool = out;
  return pool;
}

/* 抽一局：洗过词池后贪心取 10 对，**key 与两面的字面都不许在本局里重复**。
   这一档的冲突面比进阶档更大：
     · m 有 11 个重复值（「九」「晚饭」「词典」各有两条词），两张写着同样释义的
       牌会让这一局没有唯一解；
     · 有 100 条词的 m 与某个词的 w 字面相同（家庭 = 家庭），而 key 取 w；
     · a 面 / b 面本身也可能互撞（key 只是 pairing 用的 id，不是牌面）。
   所以占位集合里同时记 key、a 面、b 面三样。 */
function build(rng) {
  var order = root.KanaCore.shuffle(wordPool(), rng);
  var used = Object.create(null);        // 字面 / key -> true
  var pairs = [];
  for (var i = 0; i < order.length && pairs.length < PAIR_COUNT; i++) {
    var entry = order[i];
    if (used[entry.w] || used[entry.word] || used[entry.meaning]) continue;
    used[entry.w] = true;
    used[entry.word] = true;
    used[entry.meaning] = true;
    pairs.push({ key: entry.w, a: entry.word, b: entry.meaning, kind: 'kana-meaning' });
  }
  return pairs;
}

/* 副标签：a 面是日本语这一侧（读音 + 汉字写法），标 ことば；b 面是中文释义，标 中文。
   与进阶档的 漢字語 / 読み 同一条思路：标签说的是「这一面是什么」，
   入门档那种 KANA / ROMAJI 的字母写法只适合字母面。 */
var expertTier = {
  id: 'expert',
  label: '高手',
  hint: '日语词 ↔ 中文释义',
  labels: { a: 'ことば', b: '中文' },
  build: build
};

/* ------------------------------------------------------------ 最高分 */

function bestKey(tier) {
  return BEST_KEY_PREFIX + tier;
}

/* 记忆里的纪录：{ moves, ms }；没记过、写坏了、被改成怪值都当「还没有纪录」 */
function readBest(tier) {
  var raw;
  try { raw = root.localStorage.getItem(bestKey(tier)); } catch { return null; }
  if (!raw) return null;
  var best;
  try { best = JSON.parse(raw); } catch { return null; }
  if (!best || typeof best.moves !== 'number' || typeof best.ms !== 'number') return null;
  return { moves: best.moves, ms: best.ms };
}

function writeBest(tier, moves, ms) {
  try {
    root.localStorage.setItem(bestKey(tier), JSON.stringify({ moves: moves, ms: ms }));
  } catch { /* 隐私模式写不进去：本局照样结算，只是记不住 */ }
}

/* 步数少者胜；同步数比用时。没有旧纪录时任何一局都是新纪录。 */
function isBetter(next, best) {
  if (!best) return true;
  if (next.moves !== best.moves) return next.moves < best.moves;
  return next.ms < best.ms;
}

/* 与 page.js 的 fmtMs 同一口径（那个是私有的，两边都得各自写一行） */
function fmtMs(ms) {
  var total = Math.floor(ms / 1000);
  var mm = Math.floor(total / 60);
  var ss = total % 60;
  return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
}

function bestText(best) {
  return best ? best.moves + ' 步 · ' + fmtMs(best.ms) : '—';
}

/* ------------------------------------------------------------ 结算条 */

function ensureResultParts() {
  var doc = root.document;
  if (!doc || els.again) return;

  var line = doc.createElement('p');
  line.className = 'k-result-record';
  line.id = 'k-result-record';
  els.record = line;
  els.result.appendChild(line);

  var actions = doc.createElement('div');
  actions.className = 'k-result-actions';
  els.again = button(doc, 'k-again', '再来一局');
  els.switchTier = button(doc, 'k-switch', '换一档');
  actions.appendChild(els.again);
  actions.appendChild(els.switchTier);
  els.result.appendChild(actions);
}

function button(doc, id, label) {
  var btn = doc.createElement('button');
  btn.className = 'k-btn';
  btn.id = id;
  btn.setAttribute('type', 'button');
  btn.textContent = label;
  return btn;
}

/* 档位顺序以 #k-tiers 里渲染出来的按钮为准（page.js 没把 tierIds 暴露出来，
   而「换一档」只需要知道下一个是谁） */
function tierOrder() {
  var doc = root.document;
  var box = doc.getElementById('k-tiers');
  if (!box) return [];
  var buttons = box.querySelectorAll('button.k-tier');
  var out = [];
  for (var i = 0; i < buttons.length; i++) out.push(buttons[i].getAttribute('data-tier'));
  return out;
}

function restart() {
  if (App) App.setTier(App.getState().tier);     // 同一档再来一局：page.js 会重建 + 归零
}

function nextTier() {
  var order = tierOrder();
  if (!order.length || !App) return;
  var cur = App.getState().tier;
  var at = order.indexOf(cur);
  App.setTier(order[(at + 1) % order.length]);
}

/* ------------------------------------------------------------ 接线 */

function renderBest() {
  if (!App || !els.best) return;
  els.best.textContent = bestText(readBest(App.getState().tier));
}

function onRoundStart() {
  renderBest();
  if (els.record) els.record.textContent = '';    // 上一局的纪录提示不留给这一局
}

function onRoundEnd(payload) {
  var best = readBest(payload.tier);
  var fresh = isBetter(payload, best);
  if (fresh) {
    writeBest(payload.tier, payload.moves, payload.ms);
    best = { moves: payload.moves, ms: payload.ms };
  }
  renderBest();
  /* 步骤与用时由 page.js 写在 #k-result-line 上，这里只补纪录那一句：
     只有真的刷新纪录才出现「新纪录」三个字，没破纪录就只报本档最佳。 */
  if (els.record) {
    els.record.textContent = fresh
      ? '新纪录 · 本档最佳 ' + bestText(best)
      : '本档最佳 ' + bestText(best);
  }
}

function init() {
  if (wired || !root.KanaApp) return;
  wired = true;
  App = root.KanaApp;
  els.best = root.document.getElementById('k-best');
  els.result = root.document.getElementById('k-result');
  if (els.result) ensureResultParts();
  if (els.again) els.again.addEventListener('click', restart);
  if (els.switchTier) els.switchTier.addEventListener('click', nextTier);
  App.on('round:start', onRoundStart);
  App.on('round:end', onRoundEnd);
  App.on('tier:change', renderBest);
  renderBest();
}

/* 同 tiers.js 的注册契约：本文件早于 page.js 加载，此刻 window.KanaApp 还不存在，
   所以把档位定义压进 window.KanaTierDefs，由 page.js 的 boot() 在读取记忆档位之前
   排空；事件与插槽的接线等 load（那时 boot 已把牌墙建好）。 */
(root.KanaTierDefs = root.KanaTierDefs || []).push(expertTier);
if (typeof root.addEventListener === 'function') root.addEventListener('load', init);

})(typeof window !== 'undefined' ? window : globalThis);
