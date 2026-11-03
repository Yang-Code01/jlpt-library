/* 假名翻牌（kana-memory/）· 高手档（日语词 ↔ 中文释义）+ 每档最高分 + 结算条
   跑法：node tools/tests/test_memory_score.js

   驱动的是真页面 kana-memory/index.html（真 HTML、真 page.js、真 tiers.js、真
   score.js、真词表 typing/data/{n5,n4}.js），DOM 桩与假定时器同 test_memory.js。
   票 03 的风险同样不在算法，而在接线与「记分」：
     · 高手档的牌面冲突面最大（同释义不同词、释义与某个写法字面相同），
       一局 20 张必须字面互不相同，否则这一局没有唯一解；
     · score.js 排在 page.js 之前，档位走 KanaTierDefs、事件与插槽要等 load；
     · 最高分要按档位分键、只在真的更好时覆盖；
     · 结算条多出的两块（纪录那一句 + 两个按钮）靠 page.js 的 round:end 接。

   钉住的对外可观察行为：
     ① 三档按注册顺序排列（入门 → 进阶 → 高手），点击切档、档位记忆含 expert
     ② 高手档牌池全部来自 TYPING_WORDS_N5 / N4：a =「读音（附汉字写法）」、b = 释义
     ③ 一局 10 对 / 20 张、每对恰两张，且 20 张字面互不相同（多跑几十局）
     ④ 牌面长度上界（最长 14 个字）—— 给票 04 的 CSS 留一个可核对的数
     ⑤ 每档最高分各写各的键；步数更多的一局不覆盖；同步数比用时；坏值当没有纪录
     ⑥ 结算条要写本局步数 / 用时 / 是否新纪录，并含「再来一局」「换一档」
     ⑦ 结算条出现后牌面不可再翻
     ⑧ 词表缺失时高手档退化成空池，页面不崩
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
  tiers: path.join(DIR, 'tiers.js'),
  score: path.join(DIR, 'score.js'),
  dataN5: path.join(ROOT, 'typing/data/n5.js'),
  dataN4: path.join(ROOT, 'typing/data/n4.js'),
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

/* 打开页面：按 index.html 里声明的顺序跑每一个 <script>
   opts.store —— 预置的 localStorage（模拟「上次关页面时的选择 / 纪录」）
   opts.drop  —— 要跳过的脚本（子串匹配；用来模拟词表缺失）
   opts.noLoad —— 不触发 window 的 load 事件（用来看 score.js 的接线时机） */
function loadPage(opts) {
  opts = opts || {};
  const html = fs.readFileSync(SRC.html, 'utf8');
  const timer = fakeTimer();
  const sb = H.makeSandbox({ html: html, setTimeout: timer.setTimeout, pathname: '/' + PAGE });
  sb.clearTimeout = timer.clearTimeout;
  for (const k of Object.keys(opts.store || {})) sb.__store.set(k, opts.store[k]);

  const dir = path.posix.dirname('/' + PAGE);
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = /\ssrc="([^"]+)"/.exec(m[1]);
    if (src) {
      if ((opts.drop || []).some((d) => src[1].indexOf(d) >= 0)) continue;
      const rel = path.posix.normalize(dir + '/' + src[1]).replace(/^\//, '');
      H.runFile(sb, path.join(ROOT, ...rel.split('/')));
    } else if (m[2].trim()) {
      H.run(sb, m[2], PAGE);
    }
  }
  /* 真浏览器里 load 在所有 <script> 之后；score.js 就是在这一刻接上 KanaApp 的 */
  if (!opts.noLoad) sb.__winFire('load');
  return { sb: sb, doc: sb.__doc, timer: timer, store: sb.__store };
}

/* ---------------------------------------------------------------- 读页面小工具 */
const tiles = (doc) => doc.body.querySelectorAll('.k-tile');
const text = (doc, id) => String(doc.getElementById(id).textContent);
const stateOf = (el) => el.getAttribute('data-state');
const pairs = (sb) => sb.KanaApp.getState().round.pairs;
const faces = (doc) => tiles(doc).map((t) => t.querySelector('.k-word').textContent);
const tags = (doc) => tiles(doc).map((t) => t.querySelector('.k-tag').textContent);
const tierButtons = (doc) => doc.getElementById('k-tiers').querySelectorAll('button.k-tier');
const resultHidden = (doc) => doc.getElementById('k-result').hasAttribute('hidden');

function indicesOfKey(doc, key) {
  const out = [];
  tiles(doc).forEach((t, i) => { if (t.getAttribute('data-key') === key) out.push(i); });
  return out;
}

function clickTier(doc, id) {
  const btn = tierButtons(doc).find((b) => b.getAttribute('data-tier') === id);
  if (btn) btn.click();
  return !!btn;
}

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* 高手档的候选词（与 score.js 的归一化同一口径：w 取第一个写法、纯假名词不挂括号）。
   用来核对「牌池里的每一对都真的来自词表」，而不是把数据抄进测试。 */
function expertPool(sb) {
  const out = [];
  for (const list of [sb.TYPING_WORDS_N5, sb.TYPING_WORDS_N4]) {
    for (const e of list || []) {
      const w = String(e.w).split(';')[0].trim();
      const k = String(e.k).trim();
      const m = String(e.m).trim();
      if (!w || !k || !m) continue;
      out.push({ w: w, k: k, m: m, word: w === k ? k : k + '（' + w + '）' });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 打一局 */
/* 只实现「把这一局配完」：全对就是 total 步；先配错几次再配完就是 total + 配错次数 步。
   clock 是喂给页面的假 Date（页面用 Date.now() 算用时）。 */
function clockAt(t) { return { t: t || 1000000 }; }

function playPerfect(sb, doc, clock, ms) {
  const keys = [...new Set(pairs(sb).map((p) => p.key))];
  keys.forEach((key, i) => {
    if (i === keys.length - 1) clock.t += ms;     // 只在最后一对之前推进 → 用时正好 ms
    const [a, b] = indicesOfKey(doc, key);
    tiles(doc)[a].click();
    tiles(doc)[b].click();
  });
}

function twoDownDifferent(sb, doc) {
  const list = tiles(doc);
  const state = sb.KanaApp.getState().round.tiles;
  for (let i = 0; i < list.length; i++) {
    if (state[i].state !== 'down') continue;
    for (let j = i + 1; j < list.length; j++) {
      if (state[j].state === 'down' && state[i].key !== state[j].key) return [i, j];
    }
  }
  return null;
}

function playMessy(sb, doc, timer, clock, ms, misses) {
  for (let n = 0; n < misses; n++) {
    const ij = twoDownDifferent(sb, doc);
    tiles(doc)[ij[0]].click();
    tiles(doc)[ij[1]].click();
    timer.advance(620);                            // 让配错的两张翻回去
  }
  playPerfect(sb, doc, clock, ms);
}

function readBest(sb, tier) {
  const raw = sb.localStorage.getItem('jlpt-kana-best:' + tier);
  return raw ? JSON.parse(raw) : null;
}

/* ================== 1. 三档：注册顺序、切换、记忆 ================== */
section('三档：入门 → 进阶 → 高手，点得动、记得住');
{
  const { sb, doc } = loadPage();
  const ids = tierButtons(doc).map((b) => b.getAttribute('data-tier'));
  eq(ids.join(','), 'beginner,mid,expert', '三档按注册顺序排列（先注册先渲染）');
  eq(sb.KanaApp.getState().tier, 'beginner', '默认仍是入门档');

  ok(clickTier(doc, 'expert'), '高手档按钮在');
  eq(sb.KanaApp.getState().tier, 'expert', '点「高手」后当前档位是 expert');
  eq(sb.localStorage.getItem('jlpt-kana-tier'), 'expert', '档位写进 jlpt-kana-tier');
  eq(tierButtons(doc).find((b) => b.getAttribute('data-tier') === 'expert').getAttribute('aria-pressed'),
    'true', '高手按钮 aria-pressed=true');
  eq(tierButtons(doc).find((b) => b.getAttribute('data-tier') === 'mid').getAttribute('aria-pressed'),
    'false', '进阶按钮的选中态撤销');
  eq(tiles(doc).length, 20, '高手档一局也是 20 张');
  eq(text(doc, 'k-pairs'), '0 / 10', '高手档一局 10 对');
  ok(new Set(tags(doc)).size === 2 && new Set(tags(doc)).has('中文'),
    '高手档副标签是 ことば / 中文（实际：' + [...new Set(tags(doc))].join(',') + '）');

  /* 三档来回点：每次都是重建一局、计数归零 */
  for (const id of ['beginner', 'mid', 'expert', 'mid', 'beginner']) {
    clickTier(doc, id);
    eq(sb.KanaApp.getState().tier, id, '切到 ' + id + ' 后当前档位是它');
    eq(sb.KanaApp.getState().moves, 0, '切到 ' + id + ' 后步数归零');
    eq(tiles(doc).length, 20, '切到 ' + id + ' 后牌墙 20 张');
    ok(resultHidden(doc), '切到 ' + id + ' 后结算条收起');
    eq(tierButtons(doc).find((b) => b.getAttribute('data-tier') === id).getAttribute('aria-pressed'),
      'true', id + ' 按钮是选中态');
  }

  /* 记忆：带 expert 打开页面直接是高手档 */
  const saved = loadPage({ store: { 'jlpt-kana-tier': 'expert' } });
  eq(saved.sb.KanaApp.getState().tier, 'expert', '记忆里的 expert 在 boot 里生效');
  eq(tiles(saved.doc).length, 20, '记忆生效后牌墙照建');
  eq(saved.sb.localStorage.getItem('jlpt-kana-tier'), 'expert', '记忆没被回落覆盖成 beginner');
  eq(saved.sb.KanaTierDefs.length, 0, 'boot 排空 KanaTierDefs（tiers.js + score.js 两个定义）');
}

/* ============ 2. 牌池：全部来自词表，a = 读音（附汉字）↔ b = 释义 ============ */
section('牌池：全部来自 TYPING_WORDS_N5 / N4，a = 读音（附汉字写法）、b = 中文释义');
{
  const { sb } = loadPage();
  sb.KanaApp.setTier('expert');

  const pool = expertPool(sb);
  const byWord = new Map();
  for (const e of pool) {
    if (!byWord.has(e.word)) byWord.set(e.word, []);
    byWord.get(e.word).push(e);
  }
  ok(pool.length >= 500, '候选词够多（实际 ' + pool.length + ' 条）');

  /* 冲突面的证据：重复释义 + 释义与某个写法字面相同 —— 占位集合必须记 b 面 */
  const meaningCount = new Map();
  pool.forEach((e) => meaningCount.set(e.m, (meaningCount.get(e.m) || 0) + 1));
  const dupMeanings = [...meaningCount.entries()].filter(([, n]) => n > 1);
  ok(dupMeanings.length > 0, '词表里确实有重复释义（实际 ' + dupMeanings.length + ' 组，如「九」）');
  const mIsW = pool.filter((e) => e.m === e.w).length;
  ok(mIsW > 0, '有 ' + mIsW + ' 条词的释义与某个词的写法字面相同（如 家庭 = 家庭）');

  let checked = 0;
  const bad = [];
  for (let round = 0; round < 40; round++) {
    sb.KanaApp.setTier('expert');
    for (const p of pairs(sb)) {
      checked++;
      const hit = (byWord.get(p.a) || []).find((e) => e.m === p.b && e.w === p.key);
      if (!hit) bad.push(p.a + '↔' + p.b);
      if (p.kind !== 'kana-meaning') bad.push('kind ' + p.kind);
      if (!/[\u3040-\u30ff]/.test(p.a)) bad.push('a 面没有读音 ' + p.a);
      if (/[\u3040-\u30ff]/.test(p.b)) bad.push('b 面混进假名 ' + p.b);
      if (!/[\u4e00-\u9fff]/.test(p.b)) bad.push('b 面不是中文释义 ' + p.b);
    }
  }
  eq(bad.length, 0, '40 局 ' + checked + ' 对全部对得上词表（反例：' + bad.slice(0, 3).join(' / ') + '）');

  /* 纯假名词不挂空括号（「おまわりさん（おまわりさん）」） */
  const pureKana = pool.filter((e) => e.w === e.k).slice(0, 1)[0];
  ok(!!pureKana && pureKana.word === pureKana.k, '纯假名词的 a 面只写读音，不挂空括号');

  /* 汉字写法确实进了 a 面（有汉字的词：a = 读音（汉字）） */
  const withKanji = pool.filter((e) => /[\u4e00-\u9fff]/.test(e.w)).slice(0, 1)[0];
  ok(!!withKanji && withKanji.word.indexOf(withKanji.w) > 0 && withKanji.word.indexOf(withKanji.k) === 0,
    '有汉字写法的词：a 面是「读音（汉字）」（实际：' + (withKanji && withKanji.word) + '）');
}

/* ============ 3. 一局 10 对 20 张，字面互不相同（多跑几十局） ============ */
section('一局：10 对 20 张、每对恰两张，20 张字面互不相同');
{
  const { sb, doc } = loadPage();
  sb.KanaApp.setTier('expert');

  const counts = new Map();
  tiles(doc).forEach((t) => {
    const k = t.getAttribute('data-key');
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  eq(counts.size, 10, '牌墙里恰好 10 个不同的 key');
  ok([...counts.values()].every((n) => n === 2), '每个 key 恰好两张');
  eq([...counts.keys()].sort().join('|'), pairs(sb).map((p) => p.key).sort().join('|'),
    '牌的 key 与这一局的牌对一一对应（无重复无遗漏）');

  const perKey = new Map();
  for (const p of pairs(sb)) perKey.set(p.key, [p.a, p.b]);
  const sidesOk = [...counts.keys()].every((key) => {
    const got = indicesOfKey(doc, key).map((i) => tiles(doc)[i].querySelector('.k-word').textContent);
    const want = perKey.get(key);
    return got.length === 2 && want.every((f) => got.indexOf(f) >= 0);
  });
  ok(sidesOk, '每个 key 的两张牌分别写着这一对的两个面');

  let dupRounds = 0;
  let dupKeys = 0;
  for (let round = 0; round < 60; round++) {
    sb.KanaApp.setTier('expert');
    const all = faces(doc);
    if (new Set(all).size !== 20) dupRounds++;
    const keys = tiles(doc).map((t) => t.getAttribute('data-key'));
    if (new Set(keys).size !== 10) dupKeys++;
  }
  eq(dupRounds, 0, '60 局里没有一局出现字面重复的牌');
  eq(dupKeys, 0, '60 局里没有一局出现重复的 key');
}

/* ==================== 4. 牌面长度（给票 04 的 CSS 一个数） ==================== */
section('牌面长度：最长的 a 面 / b 面有多长（窄屏溢出的口径）');
{
  const { sb } = loadPage();
  const pool = expertPool(sb);
  const longestA = pool.reduce((m, e) => Math.max(m, e.word.length), 0);
  const longestB = pool.reduce((m, e) => Math.max(m, e.m.length), 0);
  console.log('  实测：a 面最长 ' + longestA + ' 个字、b 面最长 ' + longestB + ' 个字');

  ok(longestA <= 14, 'a 面最长不超过 14 个字（实测 ' + longestA + '）');
  ok(longestB <= 13, 'b 面最长不超过 13 个字（实测 ' + longestB + '）');
  ok(pool.some((e) => e.word.length >= 12), '池里确实有 ≥12 字的 a 面（窄屏那条路有真样本）');
  ok(pool.every((e) => !/[\s\u3000]/.test(e.word) && !/[\s\u3000]/.test(e.m)),
    '牌面里没有空白字符（不会被折成看不懂的两段）');
}

/* ================== 5. 最高分：分档、只在更好时覆盖 ================== */
section('最高分：每档一个键、步数少者胜、同步数比用时、更差的局不覆盖');
{
  const { sb, doc, timer } = loadPage();
  const clock = clockAt(1000000);
  sb.Date = { now: () => clock.t };            // 页面用 Date.now() 算用时

  ok(readBest(sb, 'beginner') === null, '开局没有任何纪录');
  eq(text(doc, 'k-best'), '—', '没有纪录时 #k-best 显示 —');

  /* A：入门档全对，10 步 / 45 秒 → 写入入门档的键 */
  playPerfect(sb, doc, clock, 45000);
  const a = readBest(sb, 'beginner');
  ok(!!a, '打完一局写进了 jlpt-kana-best:beginner');
  eq(a && a.moves, 10, '纪录步数是 10（全对 = 10 步）');
  eq(a && a.ms, 45000, '纪录用时是 45000ms');
  eq(text(doc, 'k-best'), '10 步 · 00:45', '#k-best 显示本档最佳');
  ok(readBest(sb, 'mid') === null && readBest(sb, 'expert') === null, '打入门档不写别的档的键');

  /* B：同一档再打一局 12 步 / 30 秒（步数更多、更快）→ 不覆盖 */
  doc.getElementById('k-again').click();
  playMessy(sb, doc, timer, clock, 30000, 2);
  eq(sb.KanaApp.getState().moves, 12, '配错两次的这一局是 12 步');
  const b = readBest(sb, 'beginner');
  eq(b && b.moves, 10, '步数更多的一局没有覆盖纪录（仍是 10 步）');
  eq(b && b.ms, 45000, '纪录用时也没动（仍是 45000ms）');
  eq(text(doc, 'k-best'), '10 步 · 00:45', '#k-best 没被更差的一局改掉');
  ok(text(doc, 'k-result-record').indexOf('新纪录') < 0, '更差的局不提示「新纪录」');
  ok(text(doc, 'k-result-record').indexOf('本档最佳') >= 0, '更差的局只报本档最佳');

  /* C：同步数、更快（10 步 / 20 秒）→ 覆盖（同步数比用时） */
  doc.getElementById('k-again').click();
  playPerfect(sb, doc, clock, 20000);
  const c = readBest(sb, 'beginner');
  eq(c && c.moves, 10, '同步数更快的一局仍然 10 步');
  eq(c && c.ms, 20000, '同步数比用时：纪录换成 20000ms');
  ok(text(doc, 'k-result-record').indexOf('新纪录') >= 0, '刷新纪录时提示「新纪录」');

  /* D：换到高手档再打 → 写高手档的键，入门档的不动 */
  clickTier(doc, 'expert');
  eq(text(doc, 'k-best'), '—', '高手档还没有纪录：显示 —');
  playPerfect(sb, doc, clock, 30000);
  const d = readBest(sb, 'expert');
  eq(d && d.moves, 10, '高手档记的是高手档这一局（10 步）');
  eq(d && d.ms, 30000, '高手档纪录用时 30000ms');
  eq(text(doc, 'k-best'), '10 步 · 00:30', '高手档 #k-best 显示高手档的纪录');
  const dAgain = readBest(sb, 'beginner');
  eq(dAgain && dAgain.moves, 10, '入门档的纪录还在');
  eq(dAgain && dAgain.ms, 20000, '入门档的用时没被高手档覆盖');

  /* E：刷新后纪录还在；坏值当没有纪录 */
  const reload = loadPage({ store: { 'jlpt-kana-tier': 'expert', 'jlpt-kana-best:expert': JSON.stringify({ moves: 9, ms: 30000 }) } });
  eq(text(reload.doc, 'k-best'), '9 步 · 00:30', '刷新后 #k-best 读回记忆里的纪录');
  eq(reload.sb.KanaApp.getState().tier, 'expert', '刷新后还在高手档');

  const junk = loadPage({ store: { 'jlpt-kana-best:beginner': 'not json' } });
  eq(text(junk.doc, 'k-best'), '—', '纪录写坏了当没有纪录，不抛错');
  junk.sb.KanaApp.setTier('beginner');
  eq(text(junk.doc, 'k-best'), '—', '写坏的纪录换档也不会炸');
}

/* ==================== 6. 结算条：文本与两个按钮 ==================== */
section('结算条：本局步数 / 用时 / 是否新纪录 + 再来一局 / 换一档');
{
  const { sb, doc, timer } = loadPage();
  const clock = clockAt(500000);
  sb.Date = { now: () => clock.t };

  ok(resultHidden(doc), '开局结算条是收起的');
  playPerfect(sb, doc, clock, 62000);

  ok(!resultHidden(doc), '全部配对后结算条出现');
  const box = doc.getElementById('k-result');
  const line = text(doc, 'k-result-line');
  ok(line.indexOf('10 步') >= 0, '结算条写明本局步数（实际：' + line + '）');
  ok(/\d\d:\d\d/.test(line), '结算条写明用时 mm:ss（实际：' + line + '）');
  ok(text(doc, 'k-result-record').indexOf('新纪录') >= 0, '第一次通关提示「新纪录」');
  eq(text(doc, 'k-best'), '10 步 · 01:02', '通关后 #k-best 立刻更新');

  const again = doc.getElementById('k-again');
  const swap = doc.getElementById('k-switch');
  ok(!!again && !!swap, '结算条里有「再来一局」「换一档」两个按钮');
  eq(again && again.textContent, '再来一局', '按钮文案是「再来一局」');
  eq(swap && swap.textContent, '换一档', '按钮文案是「换一档」');
  ok(!!again && !!swap && box.contains(again) && box.contains(swap), '两个按钮都在结算条里');

  /* 结算条出现后牌面不可再翻 */
  const before = sb.KanaApp.getState();
  tiles(doc)[0].click();
  tiles(doc)[1].click();
  eq(sb.KanaApp.getState().moves, before.moves, '结算条出现后再点牌不计步');
  eq(sb.KanaApp.getState().matched, before.matched, '结算条出现后再点牌不改配对数');
  ok(tiles(doc).every((t) => stateOf(t) === 'done'), '20 张仍是 done（没有被翻回去）');

  /* 再来一局：留在本档、计数归零、纪录不动 */
  again.click();
  eq(sb.KanaApp.getState().tier, 'beginner', '「再来一局」留在本档');
  eq(sb.KanaApp.getState().moves, 0, '「再来一局」步数归零');
  eq(sb.KanaApp.getState().matched, 0, '「再来一局」配对数归零');
  eq(sb.KanaApp.getState().running, false, '「再来一局」计时停着（下一次翻牌才起跑）');
  eq(text(doc, 'k-pairs'), '0 / 10', '「再来一局」显示 0 / 10');
  eq(tiles(doc).length, 20, '「再来一局」牌墙仍是 20 张');
  ok(resultHidden(doc), '「再来一局」把结算条收回');
  eq(text(doc, 'k-best'), '10 步 · 01:02', '「再来一局」不动本档最佳');

  /* 换一档：按 #k-tiers 的顺序走到下一档，绕回入门 */
  playPerfect(sb, doc, clock, 1000);
  swap.click();
  eq(sb.KanaApp.getState().tier, 'mid', '「换一档」从入门切到进阶');
  eq(tiles(doc).length, 20, '换档后牌墙 20 张');
  ok(resultHidden(doc), '换档后结算条收起');

  playPerfect(sb, doc, clock, 1000);
  swap.click();
  eq(sb.KanaApp.getState().tier, 'expert', '「换一档」从进阶切到高手');

  playPerfect(sb, doc, clock, 1000);
  swap.click();
  eq(sb.KanaApp.getState().tier, 'beginner', '「换一档」从高手绕回入门');
  eq(text(doc, 'k-best'), '10 步 · 00:01', '换档后 #k-best 换成本档的纪录（入门的下一局 1 秒）');
}

/* ============ 7. 接线时机：档位在 load 之前注册、事件在 load 之后接 ============ */
section('接线时机：page.js 之前加载，档位走 KanaTierDefs、事件等 load');
{
  const early = loadPage({ noLoad: true });
  eq(early.sb.KanaApp.getState().tier, 'beginner', '不触发 load 时页面照常起来');
  ok(tierButtons(early.doc).some((b) => b.getAttribute('data-tier') === 'expert'),
    '高手档在 load 之前就注册好了（KanaTierDefs 契约，同 tiers.js）');
  eq(text(early.doc, 'k-best'), '—', 'load 之前 score.js 还没接上 #k-best');
  ok(early.doc.getElementById('k-result').querySelector('.k-result-actions') === null,
    'load 之前结算条还没长出按钮');

  const clock = clockAt(1000);
  early.sb.Date = { now: () => clock.t };
  early.sb.KanaApp.setTier('expert');
  playPerfect(early.sb, early.doc, clock, 5000);
  ok(readBest(early.sb, 'expert') === null, '没接上之前不记分（也不会抛错）');

  /* 同一页面在 load 之后接上：按钮与记分都到位 */
  early.sb.__winFire('load');
  eq(text(early.doc, 'k-best'), '—', '接上后先显示当前档的纪录（还没有纪录）');
  ok(early.doc.getElementById('k-result').querySelector('.k-result-actions') !== null,
    '接上后结算条长出按钮');
  early.sb.KanaApp.setTier('expert');
  playPerfect(early.sb, early.doc, clock, 5000);
  ok(!!readBest(early.sb, 'expert'), '接上之后开始记分');
}

/* ==================== 8. 词表缺失：空池、不崩 ==================== */
section('词表缺失：高手档退化成空池，页面不崩');
{
  const { sb, doc } = loadPage({ drop: ['typing/data/'] });
  eq(typeof sb.TYPING_WORDS_N5, 'undefined', '前提：这两个词表没加载');
  ok(tierButtons(doc).some((b) => b.getAttribute('data-tier') === 'expert'),
    '高手档按钮仍渲染（档位定义不依赖词表）');
  sb.KanaApp.setTier('expert');
  eq(sb.KanaApp.getState().total, 0, '词表缺失时高手档是空池（0 对）');
  eq(tiles(doc).length, 0, '空池就是一堵空牌墙，不抛错');
  sb.KanaApp.setTier('beginner');
  eq(tiles(doc).length, 20, '还能换回入门档继续玩');
}

/* ============================== 9. 静态契约 ============================== */
section('静态契约：脚本顺序、不碰音效/键盘、不重绘牌墙、LF');
{
  const html = fs.readFileSync(SRC.html, 'utf8');
  const bare = stripComments(html);
  const score = stripComments(fs.readFileSync(SRC.score, 'utf8'));
  const tiers = stripComments(fs.readFileSync(SRC.tiers, 'utf8'));

  const iTiers = html.indexOf('src="tiers.js"');
  const iScore = html.indexOf('src="score.js"');
  const iPage = html.indexOf('src="page.js"');
  ok(iScore >= 0, 'index.html 引了 score.js');
  ok(iTiers >= 0 && iScore > iTiers && iPage > iScore, '脚本顺序 tiers.js → score.js → page.js');

  ok(bare.indexOf('assets/style.css') < 0 && bare.indexOf('assets/theme.js') < 0 && bare.indexOf('progress.js') < 0,
    'index.html 仍不引共享资源 / 不接 progress.js');
  ok(/<link[^>]*href="kana\.css"/.test(bare), 'index.html 只引 kana.css');
  ok(!/progress\.js|RE_UNIT/.test(score), 'score.js 不接 progress.js');

  ok(/KanaTierDefs/.test(score), '高手档走 KanaTierDefs 注册契约（page.js 之前加载）');
  ok(/TYPING_WORDS_N5/.test(score) && /TYPING_WORDS_N4/.test(score),
    '牌池读的是 window.TYPING_WORDS_N5 / N4');
  for (const name of ['round:start', 'round:end', 'tier:change']) {
    ok(score.indexOf("'" + name + "'") >= 0, '用已有的钩子 ' + name);
  }
  ok(!/data-state|renderBoard|renderTiers/.test(score), 'score.js 不自己写 data-state / 重绘牌墙');
  ok(!/\b(Audio|keydown|k-sound)\b/.test(score), 'score.js 不碰音效与键盘（票 04 的事）');
  ok(!/\b(fetch|XMLHttpRequest)\s*\(/.test(score), 'score.js 没有 fetch / XHR');

  /* 不复制数据：文件里不该出现词条的正文（抽 6 条释义、6 条读音来查） */
  const n5 = fs.readFileSync(SRC.dataN5, 'utf8');
  const meanings = (n5.match(/"m":"[^"]+"/g) || []).slice(0, 6).map((s) => s.slice(5, -1));
  const readings = (n5.match(/"k":"[^"]+"/g) || []).slice(0, 6).map((s) => s.slice(5, -1));
  ok(meanings.length === 6 && readings.length === 6, '前提：词表里有可抽查的释义与读音');
  const copied = [...meanings, ...readings].filter((s) => score.indexOf('"' + s + '"') >= 0);
  eq(copied.length, 0, 'score.js 里没有复制的词条数据（抽查 ' + (meanings.length + readings.length) + ' 条）');

  for (const f of [{ f: 'score.js', s: score }, { f: 'index.html', s: html }, { f: 'tiers.js', s: tiers }]) {
    ok(f.s.indexOf(String.fromCharCode(13)) < 0, f.f + ' 是 LF 行尾');
  }
}

/* ================================ 收尾 ================================ */
console.log('');
if (fails.length) {
  console.log('FAIL（' + fails.length + '）');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('✓ 全部通过 (' + pass + ')');
