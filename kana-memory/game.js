/* ============================================================================
   假名翻牌 · 纯逻辑层（无 DOM，不读 localStorage，不管计时）
   对外 API（全局 KanaCore，供 page.js 与测试调用）：
     KanaCore.shuffle(list, rng)   -> 新数组；Fisher–Yates，rng() 返回 [0,1)
     KanaCore.createRound(pairs)   -> 一局的状态对象
     KanaCore.flip(round, index)   -> 事件 { kind, tiles }
     KanaCore.settle(round)        -> 把翻错的牌放回 down
   手感与动画一律不在这一层；这一层只回答「翻了两张，它们是不是一对」。
   用法：file:// 下以 <script src="game.js"> 直接引入，无依赖、无构建。
   ============================================================================ */
(function (root) {
'use strict';

/* ------------------------------------------------------------
   ① shuffle：返回新数组，不改入参。
   样张 B 曾经用「0–9 索引去洗 20 张牌」，洗完出现重复与遗漏；
   所以这一层的测试必须断言「洗牌结果是排列」，而不是只数量对得上。
   ------------------------------------------------------------ */
function shuffle(list, rng) {
  var rand = typeof rng === 'function' ? rng : Math.random;
  var a = list.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/* ------------------------------------------------------------
   ② createRound：每对两张（side 'a' 与 'b'），20 张交错洗成一张牌墙。
   对外字段固定为 { pairs, tiles, moves, matched, total, size }；
   「哪两张正翻着」不另存字段，由 tiles 的 state 现算（20 张的扫描不值一提，
   省掉一份与 tiles 冗余、可能不同步的状态）。
   ------------------------------------------------------------ */
function createRound(pairs) {
  var tiles = [];
  for (var i = 0; i < pairs.length; i++) {
    var p = pairs[i];
    tiles.push({ key: p.key, face: p.a, side: 'a', state: 'down' });
    tiles.push({ key: p.key, face: p.b, side: 'b', state: 'down' });
  }
  return {
    pairs: pairs.slice(),
    tiles: shuffle(tiles, Math.random),
    moves: 0,
    matched: 0,
    total: pairs.length,
    size: pairs.length * 2
  };
}

function openIndices(round) {
  var out = [];
  for (var i = 0; i < round.tiles.length; i++) {
    if (round.tiles[i].state === 'open') out.push(i);
  }
  return out;
}

/* ------------------------------------------------------------
   ③ flip：翻一张牌，返回四种事件之一。
   ignore —— 已配对 / 已翻开 / 本轮已翻满两张（配错后的 0.6 秒里）：**一个字段都不改**
   open   —— 翻开了本轮的第一张
   match  —— 与已翻开那张同 key：两张 done，matched +1，moves +1
   miss   —— 不同 key：两张仍 open（由页面在 ~620ms 后调 settle），moves +1
   步数只在「翻满两张」时 +1，翻第一张不计。
   ------------------------------------------------------------ */
function flip(round, tileIndex) {
  var tile = round.tiles[tileIndex];
  if (!tile || tile.state !== 'down') return { kind: 'ignore', tiles: [tileIndex] };

  var open = openIndices(round);
  if (open.length >= 2) return { kind: 'ignore', tiles: [tileIndex] };

  tile.state = 'open';
  if (open.length === 0) return { kind: 'open', tiles: [tileIndex] };

  var first = open[0];
  var prev = round.tiles[first];
  round.moves += 1;

  if (prev.key === tile.key) {
    prev.state = 'done';
    tile.state = 'done';
    round.matched += 1;
    return { kind: 'match', tiles: [first, tileIndex] };
  }
  return { kind: 'miss', tiles: [first, tileIndex] };
}

/* ------------------------------------------------------------
   ④ settle：配错的两张放回背面（页面等 620ms 再调，让玩家看清位置）。
   只碰 state === 'open' 的牌，已配对的不受影响。
   ------------------------------------------------------------ */
function settle(round) {
  for (var i = 0; i < round.tiles.length; i++) {
    if (round.tiles[i].state === 'open') round.tiles[i].state = 'down';
  }
}

root.KanaCore = {
  shuffle: shuffle,
  createRound: createRound,
  flip: flip,
  settle: settle
};

})(typeof window !== 'undefined' ? window : globalThis);
