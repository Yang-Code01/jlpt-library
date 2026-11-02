/* 假名翻牌（kana-memory/）· 手感与可达性（音效 / 键盘 / 朗读 / 减少动效）
   跑法：node tools/tests/test_memory_feel.js

   驱动的是真页面 kana-memory/index.html：真 HTML、真 page.js、真 game.js、真 feel.js，
   在 node 里用 tools/tests/dom.js 的 DOM 桩 + 可手动推进的假定时器跑起来。
   04 的风险同样不是算法，而是接线：键盘焦点落在谁身上、开关状态记没记住、
   关掉音效之后 AudioContext 还会不会被创建、同一个 aria-live 会不会被写两遍。

   钉住的对外可观察行为：
     ① Tab 不被拦截；Enter / Space 翻开当前焦点的那张牌并计入状态
     ② 焦点在音效按钮上时 Enter 不被抢走（交给浏览器原生激活）
     ③ R 重开本档：牌墙重建、计数归零、档位键不变、播报计数器归位
     ④ 音效开关：aria-pressed 与文字一起翻面、写进 jlpt-kana-sound、刷新后读回
     ⑤ 关掉音效后 AudioContext 一次都不创建（不只是不发声）
     ⑥ 配对数与步数经 #k-live 播报，且只念一遍
     ⑦ 配错 .is-miss 出现，620ms 后摘掉
     ⑧ 每张牌的 aria-label 区分未翻开 / 已翻开 / 已配对
     ⑨ prefers-reduced-motion: reduce 下所有位移与翻转动效归零
   不断言：波形的具体采样值、动效观感（那些走人工 file:// 目检）。
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
  feel: path.join(DIR, 'feel.js'),
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
/* 与 test_memory.js 同款：只实现 setTimeout / clearTimeout，可手动推进
   （配错后那 620ms 不等真时间）。 */
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

/* ---------------------------------------------------------------- WebAudio 桩 */
/* 只记账：被创建了几个 AudioContext、起了几个振荡器。
   「关掉音效后不再发声」的断言就落在 contexts 恒为 0 上 —— 比断言音量更接近事实：
   代码路径根本没走到创建 AudioContext 那一步。 */
function makeAudioStub(log) {
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
  });
  function AudioContextStub() {
    log.contexts++;
    this.state = 'running';
    this.currentTime = 0;
    this.destination = { name: 'destination' };
    this.resume = () => { log.resumes++; this.state = 'running'; return Promise.resolve(); };
    this.close = () => {};
    this.createOscillator = () => {
      log.oscillators++;
      return { type: 'sine', frequency: param(), connect() {}, start() { log.starts++; }, stop() {} };
    };
    this.createGain = () => { log.gains++; return { gain: param(), connect() {} }; };
  }
  return AudioContextStub;
}

/* 打开页面：跑 index.html 里按顺序声明的每一个 <script>，最后发一次 DOMContentLoaded
   （feel.js 的接线挂在这个事件上：脚本顺序在 page.js 之前，加载那一刻 KanaApp 还不存在）。 */
function loadPage(opts) {
  opts = opts || {};
  const html = fs.readFileSync(SRC.html, 'utf8');
  const timer = fakeTimer();
  const sb = H.makeSandbox({ html: html, setTimeout: timer.setTimeout, pathname: '/' + PAGE });
  sb.clearTimeout = timer.clearTimeout;

  const log = { contexts: 0, oscillators: 0, gains: 0, starts: 0, resumes: 0 };
  sb.AudioContext = makeAudioStub(log);
  const reduce = !!opts.reduceMotion;
  sb.matchMedia = (q) => ({
    media: String(q),
    matches: reduce && /prefers-reduced-motion/.test(String(q)),
    addEventListener() {},
  });
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
  sb.__doc.fire('DOMContentLoaded');
  return { sb: sb, doc: sb.__doc, timer: timer, store: sb.__store, log: log };
}

/* ---------------------------------------------------------------- 读页面小工具 */
const tiles = (doc) => doc.body.querySelectorAll('.k-tile');
const text = (doc, id) => String(doc.getElementById(id).textContent);
const stateOf = (el) => el.getAttribute('data-state');
const liveText = (doc) => String(doc.getElementById('k-live').textContent);

function firstKey(doc) { return tiles(doc)[0].getAttribute('data-key'); }

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

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ============================ 1. 键盘 ============================ */
section('键盘：Tab 交给浏览器，Enter / Space 翻当前焦点的牌');
{
  const { sb, doc } = loadPage();
  const key = firstKey(doc);
  const [a, b] = indicesOfKey(doc, key);
  const list = tiles(doc);

  let prevented = false;
  doc.fire('keydown', { key: 'Tab', target: list[a], preventDefault() { prevented = true; } });
  ok(!prevented, 'Tab 不被拦截（焦点移动交给浏览器）');
  eq(stateOf(list[a]), 'down', 'Tab 不翻牌');

  doc.fire('keydown', { key: 'Enter', target: list[a], preventDefault() { prevented = true; } });
  ok(prevented, 'Enter 被拦截（否则按钮的原生激活会让牌翻两次）');
  eq(stateOf(list[a]), 'open', 'Enter 翻开当前焦点的牌');
  eq(sb.KanaApp.getState().moves, 0, '翻第一张不计步');
  eq(sb.KanaApp.getState().matched, 0, '翻第一张不加配对数');

  prevented = false;
  doc.fire('keydown', { key: ' ', target: list[b], preventDefault() { prevented = true; } });
  ok(prevented, 'Space 同样被拦截');
  eq(stateOf(list[a]), 'done', 'Space 翻开配对的第二张');
  eq(stateOf(list[b]), 'done', '第二张也进入已配对');
  eq(sb.KanaApp.getState().matched, 1, '键盘翻牌计入状态：配对数 1');
  eq(sb.KanaApp.getState().moves, 1, '键盘翻牌计入状态：步数 1');
  eq(text(doc, 'k-moves'), '1', '步数显示跟着变');

  /* 焦点不在牌上：不许抢走按钮的原生激活 */
  const sound = doc.getElementById('k-sound');
  prevented = false;
  doc.fire('keydown', { key: 'Enter', target: sound, preventDefault() { prevented = true; } });
  ok(!prevented, '焦点在音效按钮上时 Enter 不被拦截');
  eq(text(doc, 'k-moves'), '1', '焦点在音效按钮上时 Enter 不改牌局');
}

/* ============================ 2. R 重开 ============================ */
section('R：重开本档，计数归零、牌墙重建');
{
  const { sb, doc, store } = loadPage();
  const [a, b] = twoDifferentKeys(doc);
  tiles(doc)[a].click();
  tiles(doc)[b].click();
  eq(text(doc, 'k-moves'), '1', '重开前已经走了一步');

  doc.fire('keydown', { key: 'r' });

  const list = tiles(doc);
  eq(list.length, 20, '重开后仍是 20 张牌');
  ok(list.every((t) => stateOf(t) === 'down'), '重开后牌全部回到背面');
  eq(text(doc, 'k-moves'), '0', 'R 重开后步数归零');
  eq(text(doc, 'k-pairs'), '0 / 10', 'R 重开后配对数归零');
  eq(sb.KanaApp.getState().matched, 0, 'getState().matched 归零');
  eq(sb.KanaApp.getState().running, false, '重开后计时没起跑');
  eq(store.get('jlpt-kana-tier'), 'beginner', 'R 重开不改档位（仍是 beginner）');

  const said = liveText(doc);
  ok(said.indexOf('已配对 0 / 10') >= 0, '重开后播报计数归位（实际：' + said + '）');
  ok(said.indexOf('步数 0') >= 0, '重开后的播报里带步数 0');

  /* 大写 R 与滚动无关，也重开 */
  tiles(doc)[0].click();
  doc.fire('keydown', { key: 'R' });
  eq(text(doc, 'k-moves'), '0', '大写 R 一样重开');
}

/* ============================ 3. 音效开关 ============================ */
section('音效：默认开、可关、关了就不再创建 AudioContext');
{
  const { sb, doc, timer, store, log } = loadPage();
  const sound = doc.getElementById('k-sound');
  eq(sound.getAttribute('aria-pressed'), 'true', '默认是开（aria-pressed=true）');
  eq(text(doc, 'k-sound'), '音效 开', '默认按钮写着「音效 开」');
  eq(log.contexts, 0, '还没发声前不创建 AudioContext（懒创建）');

  sound.click();
  eq(sound.getAttribute('aria-pressed'), 'false', '点一下 aria-pressed 变 false');
  eq(text(doc, 'k-sound'), '音效 关', '按钮文字变「音效 关」');
  eq(store.get('jlpt-kana-sound'), 'off', '开关状态写进 localStorage 的 jlpt-kana-sound');
  eq(log.contexts, 0, '关掉的过程中没有创建 AudioContext');
  ok(liveText(doc).indexOf('音效已关闭') >= 0, '关掉后 #k-live 播报（实际：' + liveText(doc) + '）');

  /* 关着翻两张：这张床上一声都不该响 */
  const list = tiles(doc);
  const [a, b] = twoDifferentKeys(doc);
  list[a].click();
  list[b].click();
  ok(sb.KanaApp.getState().moves >= 1, '关着音效照样能玩（步数照常记）');
  eq(log.contexts, 0, '关掉后翻牌、配错都不创建 AudioContext');
  eq(log.oscillators, 0, '关掉后一个振荡器都没起');
  eq(log.starts, 0, '关掉后没有任何声音被启动');

  /* 打开：才有 AudioContext，并给一声确认 */
  sound.click();
  eq(sound.getAttribute('aria-pressed'), 'true', '再点一下回到开');
  eq(store.get('jlpt-kana-sound'), 'on', 'localStorage 里变回 on');
  eq(log.contexts, 1, '打开音效时才创建 AudioContext（且只创建一次）');
  ok(log.starts > 0, '打开音效时给一声确认音');
  ok(liveText(doc).indexOf('音效已开启') >= 0, '打开后 #k-live 播报「音效已开启」（实际：' + liveText(doc) + '）');

  /* 前面那次配错还占着牌桌（game.js 在等回翻），先让它翻回去再翻新的一张 */
  timer.advance(620);
  const before = log.starts;
  const down = tiles(doc).findIndex((t) => stateOf(t) === 'down');
  tiles(doc)[down].click();
  ok(log.starts > before, '打开后翻牌有声音启动');
}

/* ====================== 4. 开关状态被记住 ====================== */
section('音效开关记得住：刷新后仍是关');
{
  const { doc, log, store } = loadPage({ store: { 'jlpt-kana-sound': 'off' } });
  const sound = doc.getElementById('k-sound');
  eq(sound.getAttribute('aria-pressed'), 'false', '记住的「关」在开局就生效');
  eq(text(doc, 'k-sound'), '音效 关', '按钮文字也是关');
  eq(store.get('jlpt-kana-sound'), 'off', '没被改写');

  tiles(doc)[0].click();
  eq(log.contexts, 0, '记住的「关」状态下翻牌也不创建 AudioContext');

  const on = loadPage({ store: { 'jlpt-kana-sound': 'on' } });
  eq(on.doc.getElementById('k-sound').getAttribute('aria-pressed'), 'true', '记住的「开」在开局就生效');
}

/* ========================= 5. aria-live 播报 ========================= */
section('朗读：配对数与步数经 #k-live 播报，且只念一遍');
{
  const { doc } = loadPage();
  const live = doc.getElementById('k-live');
  eq(live.getAttribute('role'), 'status', '#k-live 是 role=status');
  eq(live.getAttribute('aria-live'), 'polite', '#k-live 是 aria-live=polite');

  const [a, b] = indicesOfKey(doc, firstKey(doc));
  tiles(doc)[a].click();
  tiles(doc)[b].click();
  const matched = String(live.textContent);
  ok(matched.indexOf('已配对 1 / 10') >= 0, '配对后播报配对数（实际：' + matched + '）');
  ok(matched.indexOf('第 1 步') >= 0, '配对后播报步数');
  eq(matched.split('已配对 1 / 10').length, 2, '同一个 live region 只写一遍（page.js 与 feel.js 不抢着念）');

  const [c, d] = twoDifferentKeys(doc);
  tiles(doc)[c].click();
  tiles(doc)[d].click();
  const missed = String(live.textContent);
  ok(missed.indexOf('没配上') >= 0, '配错后播报（实际：' + missed + '）');
  ok(missed.indexOf('2 步') >= 0, '配错后播报累计步数');
}

/* ======================= 6. 配错抖动类 ======================= */
section('配错：.is-miss 出现，620ms 后摘掉');
{
  const { doc, timer } = loadPage();
  const [a, b] = twoDifferentKeys(doc);
  const list = tiles(doc);
  list[a].click();
  list[b].click();
  ok(list[a].classList.contains('is-miss') && list[b].classList.contains('is-miss'),
    '配错的两张立刻带上 .is-miss');
  eq(stateOf(list[a]), 'open', '配错期间两张还看得见正面');
  ok(timer.pending() >= 1, '配错后排了回翻定时器');

  timer.advance(620);
  ok(!list[a].classList.contains('is-miss'), '620ms 后摘掉第一张的 .is-miss');
  ok(!list[b].classList.contains('is-miss'), '620ms 后摘掉第二张的 .is-miss');
  eq(stateOf(list[a]), 'down', '回翻到背面');
}

/* ====================== 7. aria-label 三态 ====================== */
section('aria-label 区分未翻开 / 已翻开 / 已配对');
{
  const { doc } = loadPage();
  const list = tiles(doc);
  eq(list[0].getAttribute('type'), 'button', '牌是 <button type="button">');
  ok(list[0].getAttribute('aria-label').indexOf('未翻开') >= 0, '开局每张都是「未翻开」');

  const [a, b] = indicesOfKey(doc, firstKey(doc));
  list[a].click();
  ok(list[a].getAttribute('aria-label').indexOf('已翻开') >= 0,
    '翻开后 aria-label 说「已翻开」（实际：' + list[a].getAttribute('aria-label') + '）');
  list[b].click();
  ok(list[a].getAttribute('aria-label').indexOf('已配对') >= 0, '配对后说「已配对」');
  ok(list[b].getAttribute('aria-label').indexOf('已配对') >= 0, '两张都说「已配对」');
}

/* ======================= 8. 减少动效 ======================= */
section('减少动效：位移与翻转时长全部归零');
{
  const css = fs.readFileSync(SRC.css, 'utf8');

  const reduce = loadPage({ reduceMotion: true });
  eq(reduce.doc.documentElement.getAttribute('data-motion'), 'reduce',
    '系统要求减少动效时 <html data-motion="reduce">');
  const normal = loadPage();
  eq(normal.doc.documentElement.getAttribute('data-motion'), null,
    '没要求时不加 data-motion');

  ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css),
    'kana.css 有 prefers-reduced-motion 媒体查询');
  const at = css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const block = css.slice(at, at + 240);
  ok(/--dur:\s*0s/.test(block), '媒体查询里把 --dur 归零');
  ok(/--dur-slow:\s*0s/.test(block), '媒体查询里把 --dur-slow 归零');
  ok(/--shake:\s*0s/.test(block), '媒体查询里把配错抖动 --shake 归零');
  ok(/--lift:\s*0px/.test(block), '媒体查询里把悬停抬起 --lift 归零');
  ok(/:root\[data-motion="reduce"\]\{[^}]*--dur:\s*0s/.test(css),
    '同一个开关也认 [data-motion="reduce"]（系统设置被改掉时跟上）');
  ok(/transition:\s*transform\s+var\(--dur\)/.test(css), '牌的位移过渡走 --dur 令牌');
  ok(/animation:k-swing\s+var\(--shake\)/.test(css), '配错抖动时长走 --shake 令牌');
  ok(/translateY\(var\(--lift\)\)/.test(css), '悬停抬起走 --lift 令牌');
  ok(/animation:k-card-in\s+var\(--dur-slow\)/.test(css), '牌面滑入时长走 --dur-slow 令牌');
}

/* ========================== 9. 静态契约 ========================== */
section('静态契约：脚本顺序、不越界、无音频文件、LF');
{
  const html = stripComments(fs.readFileSync(SRC.html, 'utf8'));
  const feel = stripComments(fs.readFileSync(SRC.feel, 'utf8'));

  const iGame = html.indexOf('src="game.js"');
  const iFeel = html.indexOf('src="feel.js"');
  const iPage = html.indexOf('src="page.js"');
  ok(iFeel > iGame && iPage > iFeel, '脚本顺序是 game.js → feel.js → page.js');
  ok(html.indexOf('assets/style.css') < 0, '不引 ../assets/style.css');
  ok(html.indexOf('theme.js') < 0, '不引 ../assets/theme.js');
  ok(html.indexOf('progress.js') < 0, '不接 progress.js');

  ok(feel.indexOf('data-state') < 0, 'feel.js 不写 data-state（牌面状态只归 page.js 的 paint()）');
  ok(!/classList\.(add|toggle)\(/.test(feel), 'feel.js 不往牌上加状态类（.is-miss 由 page.js 管）');
  ok(!/\b(fetch|XMLHttpRequest)\s*\(/.test(feel), 'feel.js 没有 fetch / XHR');
  ok(!/\.(mp3|ogg|wav|m4a|aac)\b/i.test(feel), '音效是运行时合成的，不引音频文件');
  ok(feel.indexOf('AudioContext') >= 0, '音效走 WebAudio');
  ok(feel.indexOf(String.fromCharCode(13)) < 0, 'feel.js 是 LF 行尾');
  ok(html.indexOf(String.fromCharCode(13)) < 0, 'index.html 是 LF 行尾');
}

/* ================================ 收尾 ================================ */
console.log('');
if (fails.length) {
  console.log('FAIL（' + fails.length + '）');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('✓ 全部通过 (' + pass + ')');
