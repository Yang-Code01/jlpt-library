/* 假名翻牌（kana-memory/）· 进阶档（汉字词 ↔ 假名读音）+ 档位切换
   跑法：node tools/tests/test_memory_tiers.js

   驱动的是真页面 kana-memory/index.html（真 HTML、真 page.js、真 tiers.js、真词表
   typing/data/{n5,n4}.js），DOM 桩与假定时器同 test_memory.js：接缝在 DOM 这一层，
   因为票 02 的风险不在抽词（十几行），而在接线 —— 词表加载顺序、换档后重建牌墙与
   计数归零、计时重起、刷新后档位记忆，以及「同局里不许两张字面相同的牌」。

   钉住的对外可观察行为：
     ① 档位按钮：入门 + 进阶，点「进阶」重建牌墙
     ② 进阶档牌池全部来自 TYPING_WORDS_N5 / N4，且不含 w === k 的纯假名词
     ③ 一局 10 对 / 20 张，每对恰两张（洗牌是排列）
     ④ 20 张牌面字面互不相同（含同读音不同词：かた / かぜ / は 在词表里各有多条）
     ⑤ 换档：步数 / 用时 / 配对数归零，计时不自己跑，下一次翻牌才重新起跑
     ⑥ 刷新后档位仍是 mid（KanaTierDefs 在 boot 里、读记忆之前排空）
     ⑦ 牌面副标签随档位走：进阶 漢字語 / 読み，入门仍是 KANA / ROMAJI
     ⑧ 词表缺失时页面不崩、入门档照玩
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
   opts.store —— 预置的 localStorage（模拟「上次关页面时的选择」）
   opts.drop  —— 要跳过的脚本（子串匹配；用来模拟词表缺失） */
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

function indicesOfKey(doc, key) {
  const out = [];
  tiles(doc).forEach((t, i) => { if (t.getAttribute('data-key') === key) out.push(i); });
  return out;
}

/* 词表里出现过的 (w, k) 全对：w 归「第一个写法」，与 tiers.js 的归一化一致 */
function wordEntries(sb) {
  const out = [];
  for (const list of [sb.TYPING_WORDS_N5, sb.TYPING_WORDS_N4]) {
    for (const e of list || []) {
      out.push({ w: String(e.w).split(';')[0].trim(), k: String(e.k).trim(), raw: e });
    }
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ====================== 1. 进阶档：按钮、重建牌墙 ====================== */
section('换到进阶档：按钮存在、点了重建牌墙、牌面换成汉字词 / 假名');
{
  const { sb, doc } = loadPage();
  const buttons = tierButtons(doc);
  const ids = buttons.map((b) => b.getAttribute('data-tier'));
  ok(ids.indexOf('beginner') >= 0, '入门档按钮在（实际：' + ids.join(',') + '）');
  ok(ids.indexOf('mid') >= 0, '进阶档按钮由 tiers.js 注册进来（实际：' + ids.join(',') + '）');
  ok(ids.indexOf('beginner') < ids.indexOf('mid'), '入门排在进阶之前（先注册先渲染）');
  eq(sb.KanaApp.getState().tier, 'beginner', '默认仍是入门档');

  const beginnerFaces = faces(doc);
  const midBtn = buttons.find((b) => b.getAttribute('data-tier') === 'mid');
  eq(midBtn.getAttribute('aria-pressed'), 'false', '未选中的档位 aria-pressed=false');
  midBtn.click();

  eq(sb.KanaApp.getState().tier, 'mid', '点「进阶」后当前档位是 mid');
  /* renderTiers 会整排重建按钮，点之前拿到的是已经摘下的旧节点，必须重新查 */
  eq(tierButtons(doc).find((b) => b.getAttribute('data-tier') === 'mid').getAttribute('aria-pressed'),
    'true', '进阶按钮 aria-pressed=true');
  eq(tierButtons(doc).find((b) => b.getAttribute('data-tier') === 'beginner').getAttribute('aria-pressed'),
    'false', '入门按钮的选中态撤销');

  eq(tiles(doc).length, 20, '换档后牌墙仍是 20 张');
  const midFaces = faces(doc);
  ok(midFaces.join('|') !== beginnerFaces.join('|'), '牌面确实重建了（不是入门档那一副）');
  ok(beginnerFaces.every((f) => /^([\u3040-\u30ff]+|[a-z]+)$/.test(f)), '入门档牌面是假名 / 罗马字（对照）');
  eq(sb.localStorage.getItem('jlpt-kana-tier'), 'mid', '档位写进 localStorage 的 jlpt-kana-tier');
}

/* ==================== 2. 牌池全部来自词表、不含 w === k ==================== */
section('牌池：全部来自 TYPING_WORDS_N5 / N4，不含纯假名词（w === k）');
{
  const { sb } = loadPage();
  sb.KanaApp.setTier('mid');

  const entries = wordEntries(sb);
  const byW = new Map();
  const pureKana = new Set();
  for (const e of entries) {
    if (e.w === e.k) { pureKana.add(e.raw.w); continue; }
    if (!byW.has(e.w)) byW.set(e.w, new Set());
    byW.get(e.w).add(e.k);
  }
  ok(pureKana.size > 0, '词表里确实有 w === k 的纯假名词（过滤不是空转，实际 ' + pureKana.size + ' 条）');
  ok(byW.size >= 100, '过滤后的候选词池够大（实际 ' + byW.size + ' 条）');

  /* 连续 40 局：每一对的 (a, b) 都必须是词表里的 (w, k)，且 a !== b */
  let checked = 0;
  const bad = [];
  for (let round = 0; round < 40; round++) {
    sb.KanaApp.setTier('mid');
    for (const p of pairs(sb)) {
      checked++;
      const ks = byW.get(p.a);
      if (!ks || !ks.has(p.b)) bad.push(p.a + '↔' + p.b);
      if (p.a === p.b) bad.push('同字面 ' + p.a);
      if (pureKana.has(p.a) || pureKana.has(p.b)) bad.push('纯假名 ' + p.a);
      if (p.kind !== 'kana-word') bad.push('kind ' + p.kind);
    }
  }
  eq(bad.length, 0, '40 局 ' + checked + ' 对全部来自词表且 w !== k（反例：' + bad.slice(0, 3).join(' / ') + '）');

  /* 汉字面是汉字词、读音面是假名（不是把两面装反了） */
  const wrongSide = pairs(sb).filter((p) => !/[\u4e00-\u9fff]/.test(p.a) || !/^[\u3040-\u30ff]+$/.test(p.b));
  eq(wrongSide.length, 0, 'a 面是汉字词、b 面是假名读音');
}

/* ====================== 3. 10 对 20 张，每对恰两张 ====================== */
section('一局：10 对 20 张，每对恰两张（洗牌是排列）');
{
  const { sb, doc } = loadPage();
  sb.KanaApp.setTier('mid');

  eq(tiles(doc).length, 20, '进阶档一局也是 20 张（5 列 × 4 行不变）');
  eq(sb.KanaApp.getState().total, 10, '一局 10 对');
  eq(text(doc, 'k-pairs'), '0 / 10', '已配对显示 0 / 10');
  ok(tiles(doc).every((t) => stateOf(t) === 'down'), '换档后全部未翻开');

  const counts = new Map();
  tiles(doc).forEach((t) => {
    const k = t.getAttribute('data-key');
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  eq(counts.size, 10, '牌墙里恰好 10 个不同的 key');
  ok([...counts.values()].every((n) => n === 2), '每个 key 恰好两张');
  eq([...counts.keys()].sort().join('|'), pairs(sb).map((p) => p.key).sort().join('|'),
    '牌的 key 与这一局的牌对一一对应（无重复无遗漏）');

  /* 每对的 a 面 / b 面各出现一次：a 面与 b 面各自是哪两张 */
  const perKey = new Map();
  for (const p of pairs(sb)) perKey.set(p.key, [p.a, p.b]);
  const sidesOk = [...counts.keys()].every((key) => {
    const got = indicesOfKey(doc, key).map((i) => tiles(doc)[i].querySelector('.k-word').textContent);
    const want = perKey.get(key);
    return got.length === 2 && want.every((f) => got.indexOf(f) >= 0);
  });
  ok(sidesOk, '每个 key 的两张牌分别写着这一对的两个面');
}

/* ======================== 4. 同一局里字面不许重复 ======================== */
section('字面唯一：20 张牌面互不相同（同读音不同词 / 同字不同词都不许撞）');
{
  const { sb, doc } = loadPage();
  sb.KanaApp.setTier('mid');

  /* 词表里有多条共用同一个读音的词：这正是「只靠 key 唯一」会漏掉的地方 */
  const entries = wordEntries(sb).filter((e) => e.w !== e.k);
  const kCount = new Map();
  entries.forEach((e) => kCount.set(e.k, (kCount.get(e.k) || 0) + 1));
  const dupReadings = [...kCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  ok(dupReadings.length > 0, '词表里确实有同读音不同词（实际 ' + dupReadings.length + ' 个读音）');

  let dupRounds = 0;
  let sawDupReading = false;
  for (let round = 0; round < 60; round++) {
    sb.KanaApp.setTier('mid');
    const all = faces(doc);
    if (new Set(all).size !== 20) dupRounds++;
    if (all.some((f) => dupReadings.indexOf(f) >= 0)) sawDupReading = true;
  }
  eq(dupRounds, 0, '60 局里没有一局出现字面重复的牌');
  ok(sawDupReading, '60 局里抽到过「同读音不同词」的读音 —— 它们能进池，只是同局不同时出现');
}

/* ============================ 5. 换档计数归零 ============================ */
section('换档：步数 / 用时 / 配对数归零，计时等下一次翻牌才重新起跑');
{
  const { sb, doc, timer } = loadPage();
  let clock = 1000000;
  sb.Date = { now: () => clock };          // 让「用时」可推进（页面只调 Date.now()）

  /* 先在入门档打两步 */
  const key = tiles(doc)[0].getAttribute('data-key');
  const [a, b] = indicesOfKey(doc, key);
  tiles(doc)[a].click();
  tiles(doc)[b].click();
  clock += 5000;
  eq(sb.KanaApp.getState().moves, 1, '入门档打了一步');
  eq(sb.KanaApp.getState().matched, 1, '入门档配上一对');
  eq(sb.KanaApp.getState().ms, 5000, '入门档用时 5000ms');

  /* 换档 → 全归零 */
  sb.KanaApp.setTier('mid');
  const st = sb.KanaApp.getState();
  eq(st.tier, 'mid', '当前档位是 mid');
  eq(st.moves, 0, '换档后步数归零');
  eq(st.matched, 0, '换档后配对数归零');
  eq(st.ms, 0, '换档后用时归零');
  eq(st.running, false, '换档后计时停着（不自己起跑）');
  eq(text(doc, 'k-moves'), '0', '步数显示 0');
  eq(text(doc, 'k-pairs'), '0 / 10', '已配对显示 0 / 10');
  eq(text(doc, 'k-time'), '00:00', '用时显示 00:00');
  ok(doc.getElementById('k-result').hasAttribute('hidden'), '换档把结算条收回');

  /* 时间流逝但没人翻牌 → 用时不动 */
  clock += 3000;
  timer.advance(3000);
  eq(sb.KanaApp.getState().ms, 0, '没翻牌时用时不会自己累加');
  eq(text(doc, 'k-time'), '00:00', '没翻牌时用时显示仍是 00:00');

  /* 第一次翻牌才重新起跑 */
  tiles(doc)[0].click();
  ok(sb.KanaApp.getState().running, '翻第一张后计时起跑');
  clock += 2000;
  eq(sb.KanaApp.getState().ms, 2000, '起跑后用时从换档那一刻重新算');

  /* 换成同一档（重开）：也是重建 + 归零 */
  sb.KanaApp.setTier('mid');
  eq(sb.KanaApp.getState().moves, 0, '再点当前档位等于重开：步数归零');
  eq(sb.KanaApp.getState().running, false, '再点当前档位等于重开：计时停着');
  eq(tiles(doc).length, 20, '再点当前档位等于重开：牌墙还是 20 张');
}

/* ====================== 6. 档位记忆：刷新后仍是 mid ====================== */
section('档位记忆：刷新后仍是 mid（记忆在 boot 里、注册之后读）');
{
  const { sb, doc } = loadPage({ store: { 'jlpt-kana-tier': 'mid' } });
  eq(sb.KanaApp.getState().tier, 'mid', '带记忆打开页面直接是进阶档');
  eq(text(doc, 'k-pairs'), '0 / 10', '一进来就是一局进阶档 0 / 10');
  eq(tierButtons(doc).find((b) => b.getAttribute('data-tier') === 'mid').getAttribute('aria-pressed'),
    'true', '进阶按钮是选中态');
  ok(doc.getElementById('k-result').hasAttribute('hidden'), '一进来结算条是收起的');

  const entries = wordEntries(sb);
  const byW = new Map();
  entries.filter((e) => e.w !== e.k).forEach((e) => {
    if (!byW.has(e.w)) byW.set(e.w, new Set());
    byW.get(e.w).add(e.k);
  });
  const bad = pairs(sb).filter((p) => !byW.has(p.a) || !byW.get(p.a).has(p.b));
  eq(bad.length, 0, '刷新后的牌墙仍来自词表');

  /* 记忆被保留（没被 boot 的回落覆盖成 beginner） */
  eq(sb.localStorage.getItem('jlpt-kana-tier'), 'mid', 'localStorage 里的档位没被覆盖成 beginner');
  /* 记忆里的档位在换回入门后也跟着改 */
  sb.KanaApp.setTier('beginner');
  eq(sb.localStorage.getItem('jlpt-kana-tier'), 'beginner', '换回入门后记忆跟着改');

  /* 没有记忆时仍然是入门档（回落） */
  const fresh = loadPage();
  eq(fresh.sb.KanaApp.getState().tier, 'beginner', '没有记忆时回落到入门档');
  /* 记忆里是个不存在的档位时也回落，不炸 */
  const junk = loadPage({ store: { 'jlpt-kana-tier': 'nope' } });
  eq(junk.sb.KanaApp.getState().tier, 'beginner', '记忆里是未知档位时回落到入门档');
  eq(tiles(junk.doc).length, 20, '未知档位回落后牌墙照建');

  /* 档位定义的排空契约：tiers.js 只往 KanaTierDefs 里压，boot 排空后长度归零 */
  ok(Array.isArray(sb.KanaTierDefs), 'tiers.js 建了 window.KanaTierDefs');
  eq(sb.KanaTierDefs.length, 0, 'boot 排空 KanaTierDefs（不会每次注册都重来一遍）');
}

/* ========================= 7. 牌面副标签随档位走 ========================= */
section('牌面副标签：进阶 漢字語 / 読み，入门仍是 KANA / ROMAJI');
{
  const { sb, doc } = loadPage();
  const beginnerTags = new Set(tags(doc));
  ok(beginnerTags.has('KANA') && beginnerTags.has('ROMAJI'), '入门档副标签还是 KANA / ROMAJI');

  sb.KanaApp.setTier('mid');
  const midTags = new Set(tags(doc));
  ok(midTags.has('漢字語'), '进阶档汉字面标 漢字語（实际：' + [...midTags].join(',') + '）');
  ok(midTags.has('読み'), '进阶档读音面标 読み');
  ok(!midTags.has('ROMAJI'), '进阶档不再把假名读音标成 ROMAJI');

  sb.KanaApp.setTier('beginner');
  ok(new Set(tags(doc)).has('ROMAJI'), '换回入门档标签跟着换回来');
}

/* ====================== 8. 词表缺失：不崩、入门照玩 ====================== */
section('词表缺失：页面不崩，入门档照玩');
{
  const { sb, doc } = loadPage({ drop: ['typing/data/'] });
  eq(typeof sb.TYPING_WORDS_N5, 'undefined', '前提：这两个词表没加载');
  eq(tiles(doc).length, 20, '词表缺失时入门档仍是 20 张可玩的一局');
  eq(sb.KanaApp.getState().tier, 'beginner', '词表缺失时默认入门档');
  ok(tierButtons(doc).some((b) => b.getAttribute('data-tier') === 'mid'),
    '进阶按钮仍渲染出来（档位定义不依赖词表）');

  sb.KanaApp.setTier('mid');
  eq(sb.KanaApp.getState().total, 0, '词表缺失时进阶档是空池（0 对）');
  eq(tiles(doc).length, 0, '空池就是一堵空牌墙，不抛错');

  sb.KanaApp.setTier('beginner');
  eq(tiles(doc).length, 20, '还能换回入门档继续玩');
}

/* ============================== 9. 静态契约 ============================== */
section('静态契约：脚本顺序、词表只引不复制、tiers.js 不碰 DOM、LF');
{
  const html = stripComments(fs.readFileSync(SRC.html, 'utf8'));
  const tiers = stripComments(fs.readFileSync(SRC.tiers, 'utf8'));

  const iRomaji = html.indexOf('../typing/romaji.js');
  const iGame = html.indexOf('src="game.js"');
  const iN5 = html.indexOf('../typing/data/n5.js');
  const iN4 = html.indexOf('../typing/data/n4.js');
  const iTiers = html.indexOf('src="tiers.js"');
  const iPage = html.indexOf('src="page.js"');
  ok(iRomaji >= 0 && iGame > iRomaji, 'romaji.js 在 game.js 之前');
  ok(iN5 > iGame && iN4 > iN5, '两份词表在 game.js 之后、且 n5 在 n4 前');
  ok(iTiers > iN4 && iPage > iTiers, 'tiers.js 在词表之后、page.js 之前');

  ok(tiers.indexOf('TYPING_WORDS_N5') >= 0 && tiers.indexOf('TYPING_WORDS_N4') >= 0,
    'tiers.js 读的是 window.TYPING_WORDS_N5 / N4');
  ok(!/\b(document|localStorage)\b/.test(tiers), 'tiers.js 不碰 document / localStorage');
  ok(!/\b(fetch|XMLHttpRequest)\s*\(/.test(tiers), 'tiers.js 没有 fetch / XHR');

  /* 不复制数据：文件里不该出现词条的正文（抽 6 条词表里的读音来查） */
  const words = fs.readFileSync(SRC.dataN5, 'utf8').match(/"k":"[^"]+"/g) || [];
  const sample = words.slice(0, 6).map((s) => s.slice(5, -1));
  const copied = sample.filter((k) => tiers.indexOf('"' + k + '"') >= 0);
  eq(copied.length, 0, 'tiers.js 里没有复制的词条数据（抽查 ' + sample.length + ' 个读音）');

  for (const f of [{ f: 'tiers.js', s: tiers }, { f: 'index.html', s: html }]) {
    ok(f.s.indexOf(String.fromCharCode(13)) < 0, f.f + ' 是 LF 行尾');
  }
  ok(html.indexOf('assets/style.css') < 0 && html.indexOf('theme.js') < 0 && html.indexOf('progress.js') < 0,
    'index.html 仍不引共享资源 / 不接 progress.js');
}

/* ================================ 收尾 ================================ */
console.log('');
if (fails.length) {
  console.log('FAIL（' + fails.length + '）');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('✓ 全部通过 (' + pass + ')');
