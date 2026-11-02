/* 假名翻牌（kana-memory/）· 一局能玩（入门档 假名 ↔ 罗马字）
   跑法：node tools/tests/test_memory.js

   驱动的是真页面 kana-memory/index.html：真 HTML、真 page.js、真 game.js，
   在 node 里用 tools/tests/dom.js 的 DOM 桩跑起来，配一个**可手动推进的假定时器**
   （配错后那 620ms 不等真时间）。接缝选在 DOM 这一层而不是只测 game.js：
   这个模块的风险不在洗牌与比对（十行代码），而在接线 —— 同 key 判定、
   data-state 的互斥、配错后定时回翻、计步时机、换档重建牌墙。

   钉住的对外可观察行为：
     ① 开局 20 张全背面、步数 0、计时未起跑、结算条隐藏
     ② 配对成功：两张 done、配对 +1、步数 +1、不可再点
     ③ 配错：两张 open、步数 +1，假定时器推进 620ms 后回 down
     ④ 同一张重复点：不计步、不改状态
     ⑤ 洗牌是排列（每对恰两张、无重复无遗漏）—— 样张 B 曾在这里错过
     ⑥ 全部配对后出现结算条，显示本局步数与用时
     ⑦ 入门档的罗马字一律由 Romaji.readings(kana)[0] 派生（不另写映射表）
     ⑧ 后续票要用的钩子：KanaApp 的事件与插槽都在
   不断言：动画时长、音效波形、具体配色（那些走人工 file:// 目检）。
*/
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./dom.js');

const ROOT = path.resolve(__dirname, '../..');
const PAGE = 'kana-memory/index.html';
const DIR = path.join(ROOT, 'kana-memory');
const SRC = {
  html: path.join(DIR, 'index.html'),
  css: path.join(DIR, 'kana.css'),
  game: path.join(DIR, 'game.js'),
  page: path.join(DIR, 'page.js'),
};

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}
function section(t) { console.log('\n— ' + t); }

/* ---------------------------------------------------------------- 假定时器 */
/* 只实现 setTimeout / clearTimeout；setInterval 留给 dom.js 的惰性桩
   （页面的用时显示靠它刷新，测试里靠 round:end / getState().ms 断言，不靠跳秒）。 */
function fakeTimer() {
  let now = 0;
  let seq = 0;
  const queue = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      queue.set(id, { fn: fn, at: now + (ms || 0) });
      return id;
    },
    clearTimeout(id) { queue.delete(id); },
    /* 把「现在」推进 ms 毫秒，按到点顺序执行期间排上的所有定时器 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of queue) {
          if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        }
        if (!next) break;
        queue.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
    pending() { return queue.size; },
  };
}

/* 打开页面：跑 index.html 里按顺序声明的每一个 <script>（src 的相对路径照解析） */
function loadPage(opts) {
  opts = opts || {};
  const html = fs.readFileSync(SRC.html, 'utf8');
  const timer = fakeTimer();
  const sb = H.makeSandbox({ html: html, setTimeout: timer.setTimeout, pathname: '/' + PAGE });
  /* dom.js 固定用真 clearTimeout；这里换成同一个假队列，免得「取消掉的」定时器还在排着 */
  sb.clearTimeout = timer.clearTimeout;
  for (const k of Object.keys(opts.store || {})) sb.__store.set(k, opts.store[k]);

  const dir = path.posix.dirname('/' + PAGE);
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = /\ssrc="([^"]+)"/.exec(m[1]);
    if (src) {
      const rel = path.posix.normalize(dir + '/' + src[1]).replace(/^\//, '');
      H.runFile(sb, path.join(ROOT, ...rel.split('/')));
    } else if (m[2].trim()) {
      H.run(sb, m[2], PAGE);
    }
  }
  return { sb: sb, doc: sb.__doc, timer: timer, store: sb.__store };
}

/* ---------------------------------------------------------------- 读页面小工具 */
const tiles = (doc) => doc.body.querySelectorAll('.k-tile');
const text = (doc, id) => String(doc.getElementById(id).textContent);
const stateOf = (el) => el.getAttribute('data-state');
const resultHidden = (doc) => doc.getElementById('k-result').hasAttribute('hidden');

function indicesOfKey(doc, key) {
  const out = [];
  tiles(doc).forEach((t, i) => { if (t.getAttribute('data-key') === key) out.push(i); });
  return out;
}
/* 任意两张「不同 key 且都还没翻」的牌（配错用） */
function twoDifferentKeys(doc) {
  const list = tiles(doc);
  for (let i = 0; i < list.length; i++) {
    if (stateOf(list[i]) !== 'down') continue;
    for (let j = i + 1; j < list.length; j++) {
      if (stateOf(list[j]) !== 'down') continue;
      if (list[i].getAttribute('data-key') !== list[j].getAttribute('data-key')) return [i, j];
    }
  }
  throw new Error('牌墙上找不到两张不同 key 且未翻开的牌');
}

/* 去掉注释后的源码：静态契约看的是代码，不是注释里写的「不许引什么」 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
function firstKey(doc) { return tiles(doc)[0].getAttribute('data-key'); }

/* ================================ 1. 开局 ================================ */
section('开局：20 张全背面，计数归零');
{
  const { sb, doc, store } = loadPage();
  const list = tiles(doc);
  eq(list.length, 20, '开局恰好 20 张牌');
  ok(list.every((t) => stateOf(t) === 'down'), '开局全部未翻开');
  eq(text(doc, 'k-moves'), '0', '步数显示 0');
  eq(text(doc, 'k-pairs'), '0 / 10', '已配对显示 0 / 10');
  eq(text(doc, 'k-time'), '00:00', '用时显示 00:00');
  ok(resultHidden(doc), '结算条默认隐藏');

  const st = sb.KanaApp.getState();
  eq(st.moves, 0, 'getState().moves 是 0');
  eq(st.matched, 0, 'getState().matched 是 0');
  eq(st.total, 10, 'getState().total 是 10');
  eq(st.running, false, 'getState().running 是 false（第一次翻牌才起跑）');
  eq(st.tier, 'beginner', '默认档位是 beginner');
  eq(st.round.size, 20, '一局 size 是 20');

  eq(store.get('jlpt-kana-tier'), 'beginner', '档位写进 localStorage 的 jlpt-kana-tier');

  /* 牌面：每张都有背面与正面两个 .k-face */
  ok(list.every((t) => t.getAttribute('type') === 'button'), '牌是 <button type="button">（键盘可达）');
  ok(list.every((t) => t.querySelector('.k-face.k-back') && t.querySelector('.k-face.k-front')),
    '每张牌都有 .k-face.k-back 与 .k-face.k-front');
  ok(list.every((t) => /\d/.test(t.getAttribute('aria-label'))), '每张牌都有含序号的 aria-label');

  /* #k-sound 本票只渲染不接线 */
  const sound = doc.getElementById('k-sound');
  ok(!!sound, '#k-sound 插槽已渲染');
  sound.click();
  eq(sound.getAttribute('aria-pressed'), 'true', '#k-sound 本票是 inert（点了不改状态）');
}

/* ============================ 2. 配对成功 ============================ */
section('配对成功：两张 done、配对 +1、步数 +1、不可再点');
{
  const { sb, doc } = loadPage();
  const key = firstKey(doc);
  const [a, b] = indicesOfKey(doc, key);
  const list = tiles(doc);

  list[a].click();
  eq(stateOf(list[a]), 'open', '第一张翻开后是 open');
  eq(text(doc, 'k-moves'), '0', '翻第一张不计步');
  ok(sb.KanaApp.getState().running, '第一张翻开即开始计时');

  list[b].click();
  eq(stateOf(list[a]), 'done', '同对第一张变成 done');
  eq(stateOf(list[b]), 'done', '同对第二张变成 done');
  eq(text(doc, 'k-pairs'), '1 / 10', '已配对变成 1 / 10');
  eq(text(doc, 'k-moves'), '1', '步数变成 1');
  eq(sb.KanaApp.getState().matched, 1, 'getState().matched 是 1');

  /* 已配对的牌不可再点 */
  list[a].click();
  list[b].click();
  eq(text(doc, 'k-moves'), '1', '再点已配对的牌不计步');
  eq(stateOf(list[a]), 'done', '已配对的牌仍是 done');
}

/* ============================ 3. 配错回翻 ============================ */
section('配错：两张 open、步数 +1，620ms 后回 down');
{
  const { sb, doc, timer } = loadPage();
  const [a, b] = twoDifferentKeys(doc);
  const list = tiles(doc);

  list[a].click();
  list[b].click();
  eq(stateOf(list[a]), 'open', '配错的第一张仍是 open');
  eq(stateOf(list[b]), 'open', '配错的第二张仍是 open');
  eq(text(doc, 'k-moves'), '1', '配错算一步');
  eq(sb.KanaApp.getState().matched, 0, '配错不加配对数');
  ok(list[a].classList.contains('is-miss') && list[b].classList.contains('is-miss'),
    '配错的两张带上抖动钩子 .is-miss');
  ok(timer.pending() >= 1, '配错后排了一个回翻定时器');

  /* 回翻之前点第三张：本轮已翻满两张，什么都不该变 */
  const third = [0, 1, 2].find((i) => i !== a && i !== b);
  list[third].click();
  eq(stateOf(list[third]), 'down', '回翻前点第三张不生效');
  eq(text(doc, 'k-moves'), '1', '回翻前点第三张不计步');

  timer.advance(619);
  eq(stateOf(list[a]), 'open', '619ms 时还看得见（不是立刻翻回）');
  timer.advance(1);
  eq(stateOf(list[a]), 'down', '620ms 后第一张回 down');
  eq(stateOf(list[b]), 'down', '620ms 后第二张回 down');
  ok(!list[a].classList.contains('is-miss'), '回翻后摘掉抖动钩子');
  eq(text(doc, 'k-moves'), '1', '回翻不改步数');
  eq(sb.KanaApp.getState().moves, 1, 'getState().moves 仍是 1');

  /* 回翻后这两张可以再翻 */
  list[a].click();
  eq(stateOf(list[a]), 'open', '回翻后同一张还能再翻');
}

/* ======================== 4. 同一张重复点不计步 ======================== */
section('同一张重复点：不计步、不改状态');
{
  const { sb, doc, timer } = loadPage();
  const list = tiles(doc);
  list[0].click();
  list[0].click();
  list[0].click();
  eq(stateOf(list[0]), 'open', '连点三次仍是 open');
  eq(text(doc, 'k-moves'), '0', '连点同一张不计步');
  eq(timer.pending(), 0, '连点同一张不排定时器');
  eq(sb.KanaApp.getState().moves, 0, 'getState().moves 仍是 0');
}

/* =========================== 5. 洗牌是排列 =========================== */
section('洗牌：每对恰两张、无重复无遗漏');
{
  const { sb, doc } = loadPage();
  const counts = new Map();
  tiles(doc).forEach((t) => {
    const k = t.getAttribute('data-key');
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  eq(counts.size, 10, '牌墙里恰好 10 个不同的 key');
  ok([...counts.values()].every((n) => n === 2), '每个 key 恰好两张');

  /* 牌墙里 10 对 key 与 round.pairs 的 key 集合完全一致（无遗漏、无多余） */
  const round = sb.KanaApp.getState().round;
  const want = round.pairs.map((p) => p.key).sort().join(',');
  const got = [...counts.keys()].sort().join(',');
  eq(got, want, '牌的 key 与这一局的牌对一一对应');

  /* 每对各自一张假名面、一张罗马字面；罗马字必须由 Romaji.readings()[0] 派生 */
  const bad = round.pairs.filter((p) => p.b !== sb.Romaji.readings(p.a)[0]);
  eq(bad.length, 0, '罗马字都等于 Romaji.readings(假名)[0]');
  eq(new Set(round.pairs.map((p) => p.b)).size, 10, '一局里 10 个罗马字互不相同（不会出现两张同字面的牌）');

  /* 纯逻辑层：shuffle 是排列，且不改入参 */
  const pool = Array.from({ length: 20 }, (_, i) => i);
  let seed = 20251103;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = sb.KanaCore.shuffle(pool, rng);
  eq(out.length, 20, 'shuffle 出来还是 20 个元素');
  eq([...out].sort((x, y) => x - y).join(','), pool.join(','), 'shuffle 结果是排列（排序后与入参一致）');
  ok(new Set(out).size === 20, 'shuffle 结果无重复');
  eq(pool.join(','), Array.from({ length: 20 }, (_, i) => i).join(','), 'shuffle 不改入参');

  /* createRound：20 张、全 down、计数归零 */
  const r = sb.KanaCore.createRound(round.pairs);
  eq(r.tiles.length, 20, 'createRound 生成 20 张');
  eq(r.size, 20, 'size 是 20');
  eq(r.total, 10, 'total 是 10');
  ok(r.tiles.every((t) => t.state === 'down'), 'createRound 生成的牌全 down');
  ok(r.tiles.every((t) => typeof t.key === 'string' && typeof t.face === 'string' && (t.side === 'a' || t.side === 'b')),
    '每张牌都有 key / face / side');
}

/* ====================== 6. 全部配对后的结算条 ====================== */
section('全部配对：结算条出现，显示步数与用时');
{
  const { sb, doc, timer } = loadPage();
  const round = sb.KanaApp.getState().round;
  const keys = [...new Set(round.pairs.map((p) => p.key))];
  eq(keys.length, 10, '一局 10 对');

  keys.forEach((key) => {
    const [a, b] = indicesOfKey(doc, key);
    tiles(doc)[a].click();
    tiles(doc)[b].click();
  });
  timer.advance(1200);   // 本局没有配错，推进一下只为证明计时是「停在最后一对」而非还在跑

  const list = tiles(doc);
  eq(list.filter((t) => stateOf(t) === 'done').length, 20, '20 张全部 done');
  eq(text(doc, 'k-pairs'), '10 / 10', '已配对 10 / 10');
  eq(text(doc, 'k-moves'), '10', '全对是 10 步');
  ok(!resultHidden(doc), '结算条出现（不再 hidden）');

  const line = text(doc, 'k-result-line');
  ok(line.indexOf('10 步') >= 0, '结算条写明本局步数（实际：' + line + '）');
  ok(/\d\d:\d\d/.test(line), '结算条写明用时 mm:ss（实际：' + line + '）');

  const st = sb.KanaApp.getState();
  eq(st.running, false, '全部配对后计时停住');
  const msAfter = st.ms;
  timer.advance(5000);
  eq(sb.KanaApp.getState().ms, msAfter, '停住的用时不会再涨');
}

/* ===================== 7. 事件与插槽（后续票的接缝） ===================== */
section('事件：02/03/04 依赖的钩子都在');
{
  const { sb, doc, timer } = loadPage();
  const seen = [];
  ['round:start', 'tile:open', 'tile:match', 'tile:miss', 'round:end', 'tier:change']
    .forEach((name) => sb.KanaApp.on(name, (p) => seen.push({ name: name, p: p })));

  sb.KanaApp.setTier('beginner');            // 重建一局，事件从这之后开始记
  const start = seen.find((e) => e.name === 'round:start');
  ok(!!start, 'setTier 发出 round:start');
  eq(start && start.p.tier, 'beginner', 'round:start 带 tier');
  eq(start && start.p.size, 20, 'round:start 带 size');
  ok(seen.some((e) => e.name === 'tier:change' && e.p.tier === 'beginner'), 'setTier 发出 tier:change');

  const key = firstKey(doc);
  const [a, b] = indicesOfKey(doc, key);
  tiles(doc)[a].click();
  const opened = seen.find((e) => e.name === 'tile:open');
  ok(!!opened, '翻开第一张发出 tile:open');
  eq(opened && opened.p.index, a, 'tile:open 带 index');
  ok(!!(opened && opened.p.tile && typeof opened.p.tile.key === 'string'), 'tile:open 带 tile');

  tiles(doc)[b].click();
  const matched = seen.find((e) => e.name === 'tile:match');
  ok(!!matched, '配对成功发出 tile:match');
  eq(matched && matched.p.tiles.join(','), [a, b].join(','), 'tile:match 带两张的下标');

  /* 再翻一对错的 → tile:miss；最后一路配完 → round:end */
  const [c, d] = twoDifferentKeys(doc);
  tiles(doc)[c].click();
  tiles(doc)[d].click();
  ok(seen.some((e) => e.name === 'tile:miss'), '配错发出 tile:miss');
  timer.advance(620);        // 让配错的那两张翻回去，后面才点得动

  const round = sb.KanaApp.getState().round;
  [...new Set(round.pairs.map((p) => p.key))].forEach((k) => {
    const [i, j] = indicesOfKey(doc, k);
    tiles(doc)[i].click();
    tiles(doc)[j].click();
  });
  const ended = seen.find((e) => e.name === 'round:end');
  ok(!!ended, '全部配对发出 round:end');
  ok(!!(ended && typeof ended.p.moves === 'number' && typeof ended.p.ms === 'number' && ended.p.tier === 'beginner'),
    'round:end 带 moves / ms / tier');

  /* 插槽齐全（02/03/04 要往里填东西） */
  for (const id of ['k-board', 'k-pairs', 'k-moves', 'k-time', 'k-best', 'k-tiers', 'k-result', 'k-sound', 'k-live']) {
    ok(!!doc.getElementById(id), '插槽存在：#' + id);
  }
  const live = doc.getElementById('k-live');
  eq(live.getAttribute('role'), 'status', '#k-live 是 role=status');
  eq(live.getAttribute('aria-live'), 'polite', '#k-live 是 aria-live=polite');
  ok(!!doc.getElementById('k-tiers').querySelector('button.k-tier[data-tier="beginner"]'),
    '入门档按钮由 registerTier 渲染成 button.k-tier[data-tier=beginner]');
}

/* ============================ 8. 静态契约 ============================ */
section('静态契约：5 列 × 4 行、独立样式、无取数、LF');
{
  const html = stripComments(fs.readFileSync(SRC.html, 'utf8'));
  const css = fs.readFileSync(SRC.css, 'utf8');
  const game = stripComments(fs.readFileSync(SRC.game, 'utf8'));
  const page = stripComments(fs.readFileSync(SRC.page, 'utf8'));
  const all = [{ f: 'index.html', s: html }, { f: 'kana.css', s: css }, { f: 'game.js', s: game }, { f: 'page.js', s: page }];

  ok(/grid-template-columns\s*:\s*repeat\(5\s*,\s*1fr\)/.test(css), '牌墙是 5 列（20 张 → 4 行）');
  ok(/aspect-ratio\s*:\s*1\s*\/\s*1\.18/.test(css), '牌是 aspect-ratio 1/1.18（照样张 B）');
  ok(/\.k-tile\[data-state="done"\]/.test(css), '配对成功只靠 data-state="done" 上色');
  ok(/\.k-tile\.is-miss/.test(css), '配错抖动只靠 .is-miss 这个钩子');

  ok(html.indexOf('assets/style.css') < 0, '不引 ../assets/style.css');
  ok(html.indexOf('theme.js') < 0, '不引 ../assets/theme.js');
  ok(html.indexOf('progress.js') < 0, '不接 progress.js');
  ok(html.indexOf('kana.css') >= 0, '引自己的 kana.css');

  for (const f of all) {
    ok(f.s.indexOf(String.fromCharCode(13)) < 0, f.f + ' 是 LF 行尾');
    ok(!/\b(fetch|XMLHttpRequest)\s*\(/.test(f.s), f.f + ' 没有 fetch / XHR');
  }

  /* 脚本顺序：romaji.js → game.js → page.js（02/03/04 往中间插） */
  const iRomaji = html.indexOf('../typing/romaji.js');
  const iGame = html.indexOf('src="game.js"');
  const iPage = html.indexOf('src="page.js"');
  ok(iRomaji >= 0 && iGame > iRomaji && iPage > iGame, '脚本顺序是 romaji.js → game.js → page.js');
  /* 03 已落地：score.js 到期翻面，只要求排在 tiers.js 之后、page.js 之前 */
  const iScore = html.indexOf('src="score.js"');
  ok(iScore < 0 || (iScore > html.indexOf('src="tiers.js"') && iScore < iPage), '若引了 score.js，它排在 tiers.js 之后、page.js 之前');
  const iTiers = html.indexOf('src="tiers.js"');
  const iFeel = html.indexOf('src="feel.js"');
  ok(iTiers < 0 || iTiers < iPage, '若引了 tiers.js，它排在 page.js 之前');
  ok(iFeel < 0 || iFeel < iPage, '若引了 feel.js，它排在 page.js 之前');

  /* 纯逻辑层不碰 DOM：game.js 里不许出现 document / localStorage */
  ok(!/\bdocument\b/.test(game), 'game.js 不碰 document');
  ok(!/localStorage/.test(game), 'game.js 不碰 localStorage');
  ok(!/progress\.js|RE_UNIT/.test(page) && !/progress\.js|RE_UNIT/.test(game),
    '不接 progress.js（不碰它的 RE_UNIT 白名单）');
  ok(/Romaji\.readings/.test(page), '入门档的罗马字来自 Romaji.readings（不另建映射表）');
}

/* ================================ 收尾 ================================ */
console.log('');
if (fails.length) {
  console.log('FAIL（' + fails.length + '）');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('✓ 全部通过 (' + pass + ')');
