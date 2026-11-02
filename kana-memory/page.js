/* ============================================================================
   假名翻牌 · DOM 接线层（挂全局 KanaApp）
   这一层只做接线：建牌、绑事件、把逻辑层的事件翻成 DOM 与对外事件、计步计时、
   渲染计数、到点回翻。规则本身全在 game.js（KanaCore）里，这里不做判定。
   对外：
     KanaApp.on(name, fn) / KanaApp.emit(name, payload)
     KanaApp.registerTier({ id, label, hint, labels?, build(rng) -> pairs })
                             labels 是牌面副标签 { a, b }，缺省 { a:'KANA', b:'ROMAJI' }
     KanaApp.setTier(id)      重建一局，并把档位写进 localStorage
     KanaApp.getState()       -> { tier, moves, matched, total, ms, running, round }
   事件：round:start / tile:open / tile:match / tile:miss / round:end / tier:change
   牌面：<button class="k-tile" data-index data-key data-state="down|open|done">，
        内部 .k-face.k-back / .k-face.k-front；样式钩子只有 data-state 与 .is-miss。
   02/03/04 通过上面这些钩子与 index.html 的插槽接入，不改本文件。
   ============================================================================ */
(function (root) {
'use strict';

var Core = root.KanaCore;
var document = root.document;

var MISS_MS = 620;      // 配错停留：够看清两张的位置，又不至于打断节奏
var CLOCK_MS = 250;     // 用时显示刷新间隔
var TIER_KEY = 'jlpt-kana-tier';
/* 牌面副标签（a 面 / b 面）；档位定义可用 labels 覆盖，入门档就用这个缺省 */
var TAG_LABELS = { a: 'KANA', b: 'ROMAJI' };

/* 入门档的假名池：单假名，罗马字一律由 Romaji.readings(kana)[0] 派生（全站唯一口径）。
   刻意不收「を」——readings('を') 按字母序返回 ['o','wo']，首个写法与「お」撞车，
   同一局里会出现两张都写着 o 却不同 key 的牌，配对就变得没有唯一解。
   也不收拗音：'きゃ' 这类两字符假名在 5 列 × 4 行的窄牌面上字号会挤。 */
var KANA_POOL = ('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ' +
  'まみむめもやゆよらりるれろわんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ').split('');

var el = {};                  // 页面插槽，boot 时一次取齐
var tiers = {};               // id -> { id, label, hint, build }
var tierIds = [];
var tier = null;
var round = null;
var tileEls = [];             // 与 round.tiles 同序的 DOM 节点
var listeners = {};

var startedAt = 0;
var frozenMs = 0;             // 一局结束后的用时（不再走）
var running = false;
var clockId = 0;
var missTimer = 0;

/* ---------------------------------------------------------------- 事件 */
function on(name, fn) {
  (listeners[name] = listeners[name] || []).push(fn);
}

function emit(name, payload) {
  var fs = listeners[name];
  if (!fs) return;
  for (var i = 0; i < fs.length; i++) fs[i](payload);
}

/* ---------------------------------------------------------------- 档位 */
function registerTier(def) {
  if (!def || !def.id || tiers[def.id]) return;
  tiers[def.id] = def;
  tierIds.push(def.id);
  renderTiers();
}

function renderTiers() {
  el.tiers.textContent = '';
  for (var i = 0; i < tierIds.length; i++) {
    var def = tiers[tierIds[i]];
    var btn = document.createElement('button');
    btn.className = 'k-tier';
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-tier', def.id);
    btn.setAttribute('aria-pressed', def.id === tier ? 'true' : 'false');
    btn.appendChild(span('k-tier-name', def.label));
    btn.appendChild(span('k-tier-hint', def.hint));
    bindTierButton(btn, def.id);
    el.tiers.appendChild(btn);
  }
}

/* 单独一个函数是为了让闭包拿到当次循环的 id（var 循环里直接写会全指到最后一个） */
function bindTierButton(btn, id) {
  btn.addEventListener('click', function () { setTier(id); });
}

function setTier(id) {
  if (!tiers[id]) return;
  tier = id;
  try { root.localStorage.setItem(TIER_KEY, id); } catch { /* 隐私模式写不进去也照玩 */ }
  startRound();
  renderTiers();
  emit('tier:change', { tier: id });
}

/* ---------------------------------------------------------------- 一局 */
function startRound() {
  dropMissTimer();
  stopClock();
  running = false;
  startedAt = 0;
  frozenMs = 0;
  round = Core.createRound(tiers[tier].build(Math.random));
  renderBoard();
  renderCounters();
  hideResult();
  announce('新的一局，共 ' + round.size + ' 张牌');
  emit('round:start', { tier: tier, size: round.size });
}

function span(className, text) {
  var node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function renderBoard() {
  el.board.textContent = '';
  tileEls = [];
  var labels = (tiers[tier] && tiers[tier].labels) || TAG_LABELS;
  for (var i = 0; i < round.tiles.length; i++) {
    var tile = round.tiles[i];
    var btn = document.createElement('button');
    btn.className = 'k-tile';
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-index', String(i));
    btn.setAttribute('data-key', tile.key);
    btn.setAttribute('data-state', tile.state);
    btn.setAttribute('aria-label', tileLabel(i, tile));
    btn.appendChild(span('k-face k-back', 'かな'));
    var front = span('k-face k-front' + (tile.side === 'b' ? ' k-romaji' : ''), '');
    front.appendChild(span('k-word', tile.face));
    front.appendChild(span('k-tag', labels[tile.side] || TAG_LABELS[tile.side]));
    btn.appendChild(front);
    bindTile(btn, i);
    el.board.appendChild(btn);
    tileEls.push(btn);
  }
}

function bindTile(btn, index) {
  btn.addEventListener('click', function () { openTile(index); });
}

function tileLabel(index, tile) {
  var where = '第 ' + (index + 1) + ' 张';
  if (tile.state === 'down') return where + '，未翻开';
  if (tile.state === 'done') return where + '，已配对';
  return where + '，已翻开';
}

/* 把逻辑层的 state 刷到牌面上（唯一写 data-state 的地方） */
function paint(indices) {
  for (var k = 0; k < indices.length; k++) {
    var i = indices[k];
    var node = tileEls[i];
    var tile = round.tiles[i];
    if (!node || !tile) continue;
    node.setAttribute('data-state', tile.state);
    node.setAttribute('aria-label', tileLabel(i, tile));
    node.classList.toggle('is-miss', false);
  }
}

function openTile(index) {
  var res = Core.flip(round, index);
  if (res.kind === 'ignore') return;      // 已配对 / 已翻开 / 配错后还没翻回去

  if (res.kind === 'open') {
    startClock();
    paint(res.tiles);
    emit('tile:open', { index: index, tile: round.tiles[index] });
    announce(tileLabel(index, round.tiles[index]));
    return;
  }

  paint(res.tiles);
  renderCounters();

  if (res.kind === 'match') {
    emit('tile:match', { tiles: res.tiles.slice() });
    announce('配对成功，已配对 ' + round.matched + ' / ' + round.total + '，第 ' + round.moves + ' 步');
    if (round.matched === round.total) finishRound();
    return;
  }

  /* miss：两张先停在正面并抖一下，620ms 后放回背面 */
  for (var k = 0; k < res.tiles.length; k++) {
    if (tileEls[res.tiles[k]]) tileEls[res.tiles[k]].classList.add('is-miss');
  }
  emit('tile:miss', { tiles: res.tiles.slice() });
  announce('没配上，' + round.moves + ' 步');
  var snapshot = round;
  missTimer = root.setTimeout(function () {
    missTimer = 0;
    if (snapshot !== round) return;       // 这期间换了档 / 重开：别拿旧牌去刷新的牌墙
    Core.settle(round);
    paint(res.tiles);
  }, MISS_MS);
}

function dropMissTimer() {
  if (!missTimer) return;
  root.clearTimeout(missTimer);
  missTimer = 0;
}

function finishRound() {
  running = false;
  stopClock();
  frozenMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  renderTime();
  showResult();
  emit('round:end', { moves: round.moves, ms: frozenMs, tier: tier });
  announce('全部配对，' + round.moves + ' 步，用时 ' + fmtMs(frozenMs));
}

/* ---------------------------------------------------------------- 计时 */
function startClock() {
  if (running) return;
  running = true;
  startedAt = Date.now();
  stopClock();
  clockId = root.setInterval(renderTime, CLOCK_MS);
}

function stopClock() {
  if (!clockId) return;
  root.clearInterval(clockId);
  clockId = 0;
}

function elapsedMs() {
  return running ? Math.max(0, Date.now() - startedAt) : frozenMs;
}

function fmtMs(ms) {
  var total = Math.floor(ms / 1000);
  var mm = Math.floor(total / 60);
  var ss = total % 60;
  return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
}

/* ---------------------------------------------------------------- 渲染 */
function renderCounters() {
  el.pairs.textContent = round.matched + ' / ' + round.total;
  el.moves.textContent = String(round.moves);
  renderTime();
}

function renderTime() {
  el.time.textContent = fmtMs(elapsedMs());
}

function showResult() {
  el.resultLine.textContent = '本局 ' + round.moves + ' 步 · 用时 ' + fmtMs(frozenMs);
  el.result.removeAttribute('hidden');
}

function hideResult() {
  el.result.setAttribute('hidden', '');
}

function announce(text) {
  el.live.textContent = text;
}

/* ---------------------------------------------------------------- 启动 */
function beginnerTier() {
  return {
    id: 'beginner',
    label: '入门',
    hint: '假名 ↔ 罗马字',
    build: function (rng) {
      var picked = Core.shuffle(KANA_POOL, rng).slice(0, 10);
      var pairs = [];
      for (var i = 0; i < picked.length; i++) {
        var kana = picked[i];
        pairs.push({
          key: kana,
          a: kana,
          b: root.Romaji.readings(kana)[0],
          kind: 'kana-romaji'
        });
      }
      return pairs;
    }
  };
}

function boot() {
  el.board = document.getElementById('k-board');
  el.pairs = document.getElementById('k-pairs');
  el.moves = document.getElementById('k-moves');
  el.time = document.getElementById('k-time');
  el.tiers = document.getElementById('k-tiers');
  el.result = document.getElementById('k-result');
  el.resultLine = document.getElementById('k-result-line');
  el.live = document.getElementById('k-live');

  registerTier(beginnerTier());
  /* 后续票的档位脚本（tiers.js）在 page.js 之前加载，那时 KanaApp 还不存在，
     它们只能把定义压进 root.KanaTierDefs。必须在读记忆档位之前排空：否则
     saved 的档位不在 tiers 里，setTier 会回落 beginner 并把记忆覆盖掉。 */
  var pending = root.KanaTierDefs || [];
  for (var t = 0; t < pending.length; t++) registerTier(pending[t]);
  pending.length = 0;

  var saved = null;
  try { saved = root.localStorage.getItem(TIER_KEY); } catch { saved = null; }
  setTier(saved && tiers[saved] ? saved : tierIds[0]);
}

function getState() {
  return {
    tier: tier,
    moves: round ? round.moves : 0,
    matched: round ? round.matched : 0,
    total: round ? round.total : 0,
    ms: elapsedMs(),
    running: running,
    round: round
  };
}

root.KanaApp = {
  on: on,
  emit: emit,
  registerTier: registerTier,
  setTier: setTier,
  getState: getState
};

boot();

})(typeof window !== 'undefined' ? window : globalThis);
