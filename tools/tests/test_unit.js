/* 英语词表单元页（en/unit.js）的行为冒烟测试
 *   运行：node tools/tests/test_unit.js
 *
 * 它驱动的是生成器真正产出的那份数据与那份视图脚本：一条 50 词的切片、页头计量、
 * 列表 / 翻转卡两态、翻面即记一次自评（SM-2）、50 张评完自动盖章进 jlpt-progress。
 * 桩测不出手感（翻转动画、徽标排版），那些走人工 file:// 清单；这里只钉住数据与状态。
 *
 * 同时给票 05 留回归网：测验 / 复习队列加进来后，这些断言必须仍然成立。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./dom.js');

const ROOT = path.resolve(__dirname, '../..');

let pass = 0; const fails = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? '  ::  ' + extra : ''));
}
function show(v) {
  if (v && v.nodeType) return '<' + String(v.tagName).toLowerCase() + (v.id ? '#' + v.id : '') + '>';
  return JSON.stringify(v);
}
function eq(a, b, name) { ok(Object.is(a, b), name, 'got ' + show(a) + ' want ' + show(b)); }
function section(t) { console.log('\n— ' + t); }

/* 造一个「真页面」沙箱：按文档顺序跑它自己的 <script>（外链的读真文件）。
   与页面在浏览器里的执行顺序一致，所以模板里的脚本顺序错了也会被抓到。 */
function pageSandbox(relPath, store, opts) {
  const abs = path.join(ROOT, ...relPath.split('/'));
  const page = fs.readFileSync(abs, 'utf8');
  const dir = path.posix.dirname('/' + relPath);
  const sb = H.makeSandbox(Object.assign({ pathname: '/' + relPath, html: page }, opts || {}));
  if (store) for (const k of Object.keys(store)) sb.__store.set(k, store[k]);
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page))) {
    const src = /\ssrc="([^"]+)"/.exec(m[1]);
    if (src) {
      const p = path.posix.normalize(dir + '/' + src[1]).replace(/^\//, '');
      H.runFile(sb, path.join(ROOT, ...p.split('/')));
    } else if (m[2].trim()) {
      H.run(sb, m[2], relPath);
    }
  }
  return sb;
}

/* 77 个页面铺开后，测试一律开生成器真正产出的那份页面；不再合成假页面。 */
function doneOf(sb) { return JSON.parse(sb.__store.get('jlpt-progress') || '{}').done || {}; }
function srsOf(sb, k) { return JSON.parse(sb.__store.get(k) || '{}'); }
function progressSeed(done) { return { 'jlpt-progress': JSON.stringify({ v: 2, done: done || {}, mod: {} }) }; }

/* ===================== A 数据切片 ===================== */
section('A 数据切片与页头（直接开生成器产出的那一个页面）');
{
  const sb = pageSandbox('en/1k/01.html');
  const d = sb.__doc;
  eq(sb.EnUnit.total, 50, '第一个单元取 50 词');
  eq(d.querySelector('#enRated').textContent, '已评 0/50', '计量初值 已评 0/50');
  ok(d.querySelector('.en-title').textContent.indexOf('单元 01') >= 0, '标题含单元号', d.querySelector('.en-title').textContent);
  ok(d.querySelector('.en-sub').textContent.indexOf('词频位次 1–50') >= 0, '副标题写位次区间', d.querySelector('.en-sub').textContent);
  const rows = d.querySelectorAll('.en-row');
  eq(rows.length, 50, '列表 50 行');
  eq(rows[0].querySelector('.en-row-word').textContent, 'the', '首词是 the（词频第 1）');
  eq(d.querySelectorAll('.en-row-no')[49].textContent, '50', '末行序号 50');
  eq(sb.EnUnit.pageKey, 'en/1k/01.html', '页级进度 key 是 en/1k/01.html');
  eq(sb.EnUnit.srsKey, 'en-vocab-srs-1k-01', 'SRS 用自己的 key（决策 18）');
}
{
  /* 末单元不足 50 词：每档的最后一个页面都取实际词数（票 04 铺开后才存在） */
  const sb = pageSandbox('en/3k/57.html');
  eq(sb.EnUnit.total, 9, '3k 末单元 2801–2809：只取 9 词，不报错');
  eq(sb.__doc.querySelectorAll('.en-row').length, 9, '列表 9 行');
  eq(sb.__doc.querySelector('.en-sub').textContent.indexOf('2,801–2,809') >= 0, true, '页头写实际位次区间（带千分位）');
  const tail = pageSandbox('en/4k/77.html');
  eq(tail.EnUnit.total, 7, '4k 末单元 3760–3766：7 词');
  eq(tail.EnUnit.srsKey, 'en-vocab-srs-4k-77', '末单元的 SRS key 也对');
}

/* ===================== B 翻转卡与 SM-2 ===================== */
section('B 翻转卡：翻面即记一次自评');
{
  const sb = pageSandbox('en/1k/01.html');
  const d = sb.__doc;
  d.querySelector('[data-view="card"]').click();
  ok(!!d.querySelector('#enCard'), '切到卡片视图');
  eq(d.querySelector('.en-card-front .en-word').textContent, 'the', '第一张正面是 the');
  eq(d.querySelector('.en-deck-pos').textContent, '1 / 50 · 已评 0/50', '牌位与计量');

  d.querySelector('#enCard').click();
  ok(d.querySelector('#enCard').classList.contains('is-flipped'), '点一下翻到背面');
  const back = d.querySelector('.en-card-back');
  ok(!!back.querySelector('.en-card-ph').textContent, '背面有音标', back.querySelector('.en-card-ph').textContent);
  ok(!!back.querySelector('.en-card-pos').textContent, '背面有词性', back.querySelector('.en-card-pos').textContent);
  ok(!!back.querySelector('.en-card-tr').textContent, '背面有中释', back.querySelector('.en-card-tr').textContent);
  ok(!!back.querySelector('.en-card-def').textContent, '背面有英释');
  eq(back.querySelectorAll('.en-badges .en-badge').length >= 1, true, '背面有徽标（考纲 / 牛津 / 柯林斯）');
  eq(d.querySelector('#enRated').textContent, '已评 1/50', '翻面记一次自评');
  const rec = srsOf(sb, 'en-vocab-srs-1k-01').the;
  ok(!!rec, 'SRS 里落了一条记录');
  eq(rec.reps, 1, '首次评分 reps=1');
  eq(rec.interval, 1, '间隔 1 天');
  eq(rec.n, 1, '评分次数 1');
  eq(rec.ef, 2.5, 'q=4 时 ef 不变（2.5）');
  eq(doneOf(sb)['en/1k/01.html'], undefined, '只评 1 张还不盖章');

  d.querySelector('#enCard').click();
  eq(srsOf(sb, 'en-vocab-srs-1k-01').the.n, 1, '翻回正面不重复计分');
  d.querySelector('[data-nav="1"]').click();
  eq(d.querySelector('.en-card-front .en-word').textContent, 'be', '下一张是 be');
  eq(d.querySelector('.en-deck-pos').textContent, '2 / 50 · 已评 1/50', '第二张仍是未翻面');
}
{
  const sb = pageSandbox('en/1k/01.html');
  for (let i = 0; i < 50; i++) { sb.EnUnit.flip(); sb.EnUnit.flip(); sb.EnUnit.go(1); }
  const d = sb.__doc;
  eq(d.querySelector('#enRated').textContent, '已评 50/50', '50 张全评过');
  ok(d.querySelector('#enRated').classList.contains('is-full'), '计量满格');
  ok(!!doneOf(sb)['en/1k/01.html'], '该页自动进总进度（PRD 决策 173）');
  eq(sb.LibProgress.isDone('en/1k/01.html'), true, 'LibProgress 认这一页已完成');
}

/* ===================== C SM-2 与到期判定 ===================== */
section('C SM-2（与 jp-vocab 同参同式）');
{
  const S = pageSandbox('en/1k/01.html').EnSrs;
  ok(!!S && typeof S.sm2 === 'function', 'window.EnSrs 已导出，供票 05 的复习队列复用');
  const t = S.today();
  const a = S.sm2(null, 4);
  eq(a.reps + '/' + a.interval + '/' + a.ef, '1/1/2.5', '无记录 + 会 → 1 天 / ef 2.5');
  eq(a.due, t + 1, '到期是明天');
  const b = S.sm2(a, 4);
  eq(b.interval, 6, '第二次会 → 6 天');
  const c = S.sm2(b, 4);
  eq(c.interval, Math.round(6 * b.ef), '第三次起 interval × ef');
  const back = S.sm2(c, 1);
  eq(back.reps + '/' + back.interval, '0/1', '不会 → reps 归零、明天重来');
  eq(back.ef, Math.max(1.3, c.ef - 0.2), '不会 → ef −0.2');
  eq(S.sm2({ ef: 1.35, interval: 3, reps: 4, due: 0 }, 0).ef, 1.3, 'ef 下限 1.3');
  ok(S.isDue(null), '没有记录 = 到期');
  ok(S.isDue({ due: t }), '今天到期');
  ok(!S.isDue({ due: t + 1 }), '明天不到期');
}

/* ===================== D 不碰日语、不碰别的 key ===================== */
section('D 边界');
{
  const sb = pageSandbox('en/1k/01.html', progressSeed({ 'n5/grammar/01.html': 1 }));
  for (let i = 0; i < 50; i++) { sb.EnUnit.flip(); sb.EnUnit.flip(); sb.EnUnit.go(1); }
  const done = doneOf(sb);
  eq(done['n5/grammar/01.html'], 1, '日语侧已有的 done 条目原样保留');
  eq(Object.keys(done).length, 2, '只多出这一页');
  eq(sb.LibProgress.count('n'), 1, 'count("n") 只数日语');
  const srs = srsOf(sb, 'en-vocab-srs-1k-01');
  eq(Object.keys(srs).length, 50, 'SRS 只落在本单元自己的 key 里');
}

/* ===================== E 门户：切语言不改网址、进度数字来自清单 ===================== */
function portalSandbox(seedLang, seedDone) {
  return pageSandbox('index.html', {
    'jlpt-lang': seedLang,
    'jlpt-progress': seedDone ? JSON.stringify({ v: 2, done: seedDone, mod: {} }) : undefined
  });
}

section('E 门户双语壳');
{
  const sb = portalSandbox();
  const d = sb.__doc;
  eq(d.documentElement.getAttribute('data-lang'), 'ja', '默认日语');
  eq(d.querySelector('[data-en-overall]').textContent, '已看 0/107', '总进度分母来自门户全部英语单元（77 词表 + 30 阅读）');
  eq(d.querySelectorAll('.en-band [data-en-prog]').length, 8, '分组计数：词表 4 档 + 阅读 4 档');
  eq(d.querySelector('#en-band-1k [data-en-prog]').textContent, '已看 0/20', '词表 1k 档 20 页');
  eq(d.querySelector('#en-read-1k [data-en-prog]').textContent, '已看 0/8', '阅读 1k 档的分组计数是另一套（篇）');

  d.querySelector('[data-tab="en"]').click();
  eq(d.documentElement.getAttribute('data-lang'), 'en', '切到英语：改的是 html[data-lang]');
  eq(sb.__store.get('jlpt-lang'), 'en', '记在 localStorage');
  eq(d.querySelector('[data-tab="en"]').getAttribute('aria-selected'), 'true', 'tab 状态跟着切');
  ok(d.querySelector('[data-tab="en"]').classList.contains('on'), 'tab 高亮跟着切');
  eq(sb.location.hash, '', '切语言不改网址（不加 hash）');
  eq(sb.location.pathname, '/index.html', '也不改路径');

  d.querySelector('[data-tab="ja"]').click();
  eq(d.documentElement.getAttribute('data-lang'), 'ja', '切回日语');
  eq(sb.__store.get('jlpt-lang'), 'ja', '记忆跟着回写');
}
{
  /* 记住的语言要在首次绘制前就生效（不闪一下日语） */
  const sb = portalSandbox('en', null);
  eq(sb.__doc.documentElement.getAttribute('data-lang'), 'en', '刷新后仍在英语');
}
{
  const sb = portalSandbox(null, { 'en/1k/01.html': 111, 'en/2k/21.html': 222, 'n5/grammar/01.html': 333 });
  const d = sb.__doc;
  eq(d.querySelector('[data-en-overall]').textContent, '已看 2/107', '词表单元页盖过章就计进总数');
  eq(d.querySelector('#en-band-1k [data-en-prog]').textContent, '已看 1/20', '1k 档进一页');
  eq(d.querySelector('#en-band-2k [data-en-prog]').textContent, '已看 1/20', '2k 档进一页');
  eq(d.querySelector('#en-band-3k [data-en-prog]').textContent, '已看 0/17', '3k 档还没');
  ok(d.querySelector('[data-en-key="en/1k/01.html"]').classList.contains('is-done'), '入口行盖済');
  ok(!d.querySelector('[data-en-key="en/3k/41.html"]').classList.contains('is-done'), '没看完的不盖');
  eq(sb.LibProgress.count('en/1k'), 1, '日语页不混进英语计数');

  /* 单元页评满后回门户：门户只靠 done 映射，不靠历史累计 */
  sb.LibProgress.markDone('en/3k/41.html');
  eq(d.querySelector('[data-en-overall]').textContent, '已看 2/107', '不手动刷新就不变（门户不监听别的页）');
  sb.PORTAL_REFRESH_PROGRESS();
  eq(d.querySelector('[data-en-overall]').textContent, '已看 3/107', '重跑刷新（bfcache 返回时走这条）');
}

/* ===================== F 发音：走浏览器自带 TTS，用英语语音 ===================== */
section('F 发音');
{
  const spoken = [];
  const sb = pageSandbox('en/1k/01.html', null, {
    speechSynthesis: {
      getVoices: () => [{ lang: 'ja-JP', name: 'Haruka' }, { lang: 'en-GB', name: 'Hazel' }, { lang: 'en-US', name: 'Zira' }],
      speak: (u) => spoken.push(u),
      cancel() {},
      addEventListener() {}
    }
  });
  sb.__doc.querySelector('.en-row .en-say').click();
  eq(spoken.length, 1, '点行内发音按钮朗读一次');
  eq(spoken[0].text, 'the', '读的就是这个词');
  eq(spoken[0].lang, 'en-US', '用英语朗读，不是日语');
  eq(spoken[0].voice.name, 'Zira', '优先挑 en-US 语音（有 en-US 就不退回 en-GB）');
}

/* ===================== G 测验（票 05） ===================== */
/* 合成沙箱：不加载 1.53 MB 的真词表，只跑 en/unit.js，用来钉住清洗与兜底规则 */
function mkWord(w, tr, rank) {
  return { w: w, rank: rank || 1, ph: '', pos: 'n.', tr: tr, def: '', tag: [], collins: 0, oxford: 0 };
}
function synthSandbox(words) {
  const sb = H.makeSandbox({ pathname: '/en/1k/01.html', html: '<main id="enUnit"></main>' });
  sb.EN_VOCAB = { meta: { bands: [{ id: '1k', label: '1k', sub: '词频 1–1000', from: 1, to: 1000 }] }, words: words };
  sb.EN_UNIT = { band: '1k', unit: 1, from: 1, to: words.length };
  H.runFile(sb, path.join(ROOT, 'en', 'unit.js'));
  return sb;
}

section('G 测验：英 → 中四选一');
{
  const sb = pageSandbox('en/1k/01.html');
  const d = sb.__doc;
  const V = sb.EN_VOCAB;
  const wordNow = () => V.words.filter(w => w.w === d.querySelector('.en-quiz-word').textContent)[0];
  const optsNow = () => Array.prototype.slice.call(d.querySelectorAll('.en-opt'));
  const rightNow = () => sb.EnUnit.shortTr(wordNow().tr);

  d.querySelector('[data-view="quiz"]').click();
  ok(!!d.querySelector('.en-quiz'), '切到测验视图');
  eq(d.querySelector('.en-quiz-pos').textContent.indexOf('第 1 / 50 题'), 0, '题号从第 1 题起，共 50 题');
  eq(d.querySelector('.en-quiz-pos .en-quiz-tally').textContent, '答对 0 · 答错 0', '开局成绩为 0');
  {
    const ts = optsNow().map(b => b.textContent);
    eq(ts.length, 4, '四个选项');
    eq(new Set(ts).size, ts.length, '四个选项互不相同');
    eq(ts.indexOf(rightNow()) >= 0, true, '选项里一定有正确答案');
  }

  /* 点错一个：立刻判对错、给出正确释义、答错的词回炉 */
  const w1 = wordNow();
  const before = optsNow().map(b => b.textContent);
  const wrongIdx = before.indexOf(sb.EnUnit.shortTr(w1.tr)) === 0 ? 1 : 0;
  optsNow()[wrongIdx].click();
  /* 答一次会整块重渲染（innerHTML 换新节点），所以必须重新查，不能沿用点击前的引用 */
  ok(d.querySelector('[data-opt="' + wrongIdx + '"]').classList.contains('wrong'), '点错的那个标红');
  eq(d.querySelector('.en-opt.correct').textContent, sb.EnUnit.shortTr(w1.tr), '正确项同时标绿');
  eq(d.querySelectorAll('.en-opt[disabled]').length, 4, '答后四个选项都禁用（防连点）');
  ok(d.querySelector('.en-quiz-fb').classList.contains('is-bad'), '反馈是答错');
  ok(d.querySelector('.en-quiz-fb').textContent.indexOf(sb.EnUnit.shortTr(w1.tr)) >= 0, '答错时给出正确释义');
  eq(d.querySelector('#enRated').textContent, '已评 1/50', '答错也算一次评分');
  eq(d.querySelector('#enKnown').textContent, '已掌握 0/50', '答错不算掌握');
  {
    const rec = srsOf(sb, 'en-vocab-srs-1k-01')[w1.w];
    eq(rec.reps + '/' + rec.interval, '0/1', '答错 → reps 归零、重来间隔 1 天');
    eq(sb.EnSrs.isDue(rec), true, '答错当天到期（所以立刻回到复习队列）');
    eq(rec.ef, 2.5, '答错不罚易度因子（与 jp-vocab 的 forceReview 一致）');
  }
  d.querySelector('[data-quiz="next"]').click();
  eq(d.querySelector('.en-quiz-pos').textContent.indexOf('第 2 / 50 题'), 0, '下一题');
  eq(d.querySelectorAll('.en-opt[disabled]').length, 0, '新题的选项重新可点');
}
{
  /* 一轮 50 题全答对：选项始终互不相同、始终含正确答案、走完出成绩、自动盖章 */
  const sb = pageSandbox('en/1k/01.html');
  const d = sb.__doc;
  d.querySelector('[data-view="quiz"]').click();
  let dup = 0, miss = 0, n = 0;
  for (let i = 0; i < 50; i++) {
    const w = sb.EN_VOCAB.words.filter(x => x.w === d.querySelector('.en-quiz-word').textContent)[0];
    const right = sb.EnUnit.shortTr(w.tr);
    const btns = Array.prototype.slice.call(d.querySelectorAll('.en-opt'));
    const ts = btns.map(b => b.textContent);
    n++;
    if (new Set(ts).size !== ts.length) dup++;
    if (ts.indexOf(right) < 0) miss++;
    btns.filter(b => b.textContent === right)[0].click();
    d.querySelector('[data-quiz="next"]').click();
  }
  eq(n, 50, '一轮正好走过 50 题');
  eq(dup, 0, '50 道题的选项都互不相同');
  eq(miss, 0, '50 道题都给出了正确答案');
  eq(sb.EnUnit.state().qDone, true, '走完就是收尾状态');
  ok(!!d.querySelector('.en-quiz-sum'), '出本轮成绩');
  ok(d.querySelector('.en-quiz-sum').textContent.indexOf('答对 50') >= 0, '成绩写答对 50', d.querySelector('.en-quiz-sum').textContent);
  ok(d.querySelector('.en-quiz-sum').textContent.indexOf('答错 0') >= 0, '成绩写答错 0');
  ok(d.querySelector('.en-quiz-sum').textContent.indexOf('100%') >= 0, '正确率 100%');
  eq(d.querySelector('#enKnown').textContent, '已掌握 50/50', '全答对 → 50 个词都掌握');
  eq(d.querySelector('#enRated').textContent, '已评 50/50', '全答对 → 50 个词都评过');
  ok(!!doneOf(sb)['en/1k/01.html'], '测验答完也自动盖章（与翻转卡同一条路径）');
  d.querySelector('[data-quiz="restart"]').click();
  eq(sb.EnUnit.state().qIdx, 0, '重新测验：回到第 1 题');
  eq(sb.EnUnit.state().qDone, false, '重新测验：退出收尾状态');
  eq(d.querySelector('.en-quiz-pos .en-quiz-tally').textContent, '答对 0 · 答错 0', '重新测验：成绩清零');
}

/* ===================== H 复习队列（票 05） ===================== */
section('H 复习：到期队列、不会 / 会、与翻转卡同一份记录');
{
  const sb = pageSandbox('en/1k/01.html');
  const d = sb.__doc;
  const head = () => d.querySelector('.en-rev .en-card-front .en-word').textContent;
  d.querySelector('[data-view="review"]').click();
  eq(sb.EnUnit.state().queue, 50, '新单元一打开，50 个词全部到期');
  eq(d.querySelector('.en-rev-left').textContent, '待复习 50', '队列计数');
  ok(!!d.querySelector('.en-rev .en-card'), '复习用的是同一套卡片结构');

  const first = head();
  d.querySelector('#enRevCard').click();
  ok(d.querySelector('#enRevCard').classList.contains('is-flipped'), '点卡片翻面看释义');
  eq(d.querySelector('#enRated').textContent, '已评 0/50', '复习视图里翻面不自动记分（要靠显式的不会 / 会）');
  eq(sb.EnUnit.state().queue, 50, '翻面不动队列');

  d.querySelector('[data-rate="4"]').click();
  eq(sb.EnUnit.state().queue, 49, '评「会」就出队');
  eq(d.querySelector('#enRated').textContent, '已评 1/50', '评「会」记一次自评');
  eq(d.querySelector('#enKnown').textContent, '已掌握 1/50', '评「会」才算掌握');
  ok(!d.querySelector('#enRevCard').classList.contains('is-flipped'), '下一张回到正面');
  {
    const rec = srsOf(sb, 'en-vocab-srs-1k-01')[first];
    eq(rec.reps + '/' + rec.interval, '1/1', '会 → SM-2 排到 1 天后');
  }

  /* 评「不会」：留在队列里，但排到队尾，不是同一张立刻再来一次 */
  const second = head();
  d.querySelector('[data-rate="1"]').click();
  eq(sb.EnUnit.state().queue, 49, '评「不会」留在队列里（shift 掉再 push 回来）');
  ok(head() !== second, '下一张换了人，不是同一张立刻重复');
  {
    const rec = srsOf(sb, 'en-vocab-srs-1k-01')[second];
    eq(rec.reps, 0, '不会 → reps 归零');
    eq(rec.interval, 1, '不会 → 重来间隔 1 天');
    ok(rec.ef < 2.5, '不会 → 易度因子下调', 'ef=' + rec.ef);
    eq(rec.due, sb.EnSrs.today() + 1, '不会 → sm2 把到期推到明天（与 jp-vocab 的 srsRate(1) 同式）');
    eq(sb.EnUnit.needsReview({ w: second }), true, '但 reps 归零 → 队列口径仍把它算作待复习');
  }
  /* 剩下的一路评「会」，队尾那张应当就是刚才答错的那个词 */
  for (let i = 0; i < 48; i++) d.querySelector('[data-rate="4"]').click();
  eq(sb.EnUnit.state().queue, 1, '只剩答错的那一张');
  eq(head(), second, '答错的排到队尾（有意偏离票文的「回到队首」，理由写在票 05 的 Comments）');
  d.querySelector('[data-rate="4"]').click();
  eq(sb.EnUnit.state().queue, 0, '清空队列');
  ok(!!d.querySelector('.en-empty'), '空队列显示「今日无待复习项」');
  eq(d.querySelector('#enRated').textContent, '已评 50/50', '50 个词都有记录');
  eq(d.querySelector('#enKnown').textContent, '已掌握 50/50', '答错过的那个最后答对了');
  ok(!!doneOf(sb)['en/1k/01.html'], '复习走完也自动盖章');

  d.querySelector('[data-view="list"]').click();
  d.querySelector('[data-view="review"]').click();
  eq(sb.EnUnit.state().queue, 0, '评过的都排到明天，重进队列不会又冒出来');
}
{
  /* 评「不会」后中途离开再回到复习视图：队列重新算，答错的词不能因为 due 在明天就丢了 */
  const sb = pageSandbox('en/1k/01.html');
  const d = sb.__doc;
  d.querySelector('[data-view="review"]').click();
  const w = d.querySelector('.en-rev .en-card-front .en-word').textContent;
  d.querySelector('[data-rate="1"]').click();
  eq(sb.EnUnit.state().queue, 50, '评「不会」队列长度不变（出队又回到队尾）');
  d.querySelector('[data-view="list"]').click();
  d.querySelector('[data-view="review"]').click();
  eq(sb.EnUnit.state().queue, 50, '离开再回来，答错的那个词还在队列里（reps 归零 = 还没学会）');
  eq(sb.EnUnit.needsReview({ w: w }), true, 'needsReview 把它算作待复习');
  ok(!!d.querySelector('.en-rev .en-card'), '队列没空，还能继续复习');
}
{
  /* 同一份记录：复习里评过，再到翻转卡翻面，写的是同一条 SM-2 链 */
  const sb = pageSandbox('en/1k/01.html');
  const d = sb.__doc;
  d.querySelector('[data-view="review"]').click();
  d.querySelector('[data-rate="4"]').click();
  d.querySelector('[data-view="card"]').click();
  d.querySelector('#enCard').click();
  {
    const rec = srsOf(sb, 'en-vocab-srs-1k-01').the;
    eq(rec.n, 2, '同一份记录：评分次数累加到 2（两个视图不打架）');
    eq(rec.reps + '/' + rec.interval, '2/6', 'SM-2 接着上次走：第二次会 → 6 天');
  }
  eq(d.querySelector('#enRated').textContent, '已评 1/50', '还是只有 1 个词有记录');
}

/* ===================== I 中释清洗与选项兜底 ===================== */
section('I 中释清洗（清洗后的短释也是选项去重键）');
{
  const sb = synthSandbox([mkWord('alpha', 'n. 甲')]);
  const clean = sb.EnUnit.shortTr;
  eq(clean('n. 那'), '那', '剥词性前缀');
  eq(clean('vt. 支付, 付款'), '支付, 付款', '半角逗号保留（实测分隔符以逗号为主，分号几乎不出现）');
  eq(clean('n. ...点钟, 钟头'), '点钟, 钟头', "o'clock 那条带字面量省略号，也要剥掉");
  eq(clean('[计] 因特网, 互联网'), '因特网, 互联网', '领域标记 [计] 也剥掉');
  eq(clean('adv. 认真地\\nn. 认真的人'), '认真地', '多行长文本只取第一条（数据里的换行是字面量反斜杠 + n）');
  eq(clean('prep. 关于; 对于'), '关于', '真有分号时取第一段');
  eq(clean('a. short'), 'short', '本来就短的短释原样保留');
  eq(clean('n. ' + '甲'.repeat(30)), '甲'.repeat(24) + '…', '超长短释截到 24 字 + 省略号');
  eq(clean('n. ' + '甲'.repeat(10) + ', ' + '乙'.repeat(20)), '甲'.repeat(10) + '…', '截断优先在最后一个逗号处断');
  eq(clean('n. 甲, 乙'), '甲, 乙', '没超长就不动逗号');
  eq(clean(null), '', '空值不炸');
}
{
  /* 去重后不足 3 个干扰项：按实际数量出题，不凑数、不卡死 */
  const sb = synthSandbox([mkWord('alpha', 'n. 甲'), mkWord('beta', 'n. 甲'), mkWord('gamma', 'n. 乙')]);
  sb.EnUnit.setView('quiz');
  const opts = Array.prototype.slice.call(sb.__doc.querySelectorAll('.en-opt')).map(b => b.textContent);
  eq(opts.length, 2, '三个词只有两种不同短释 → 只出 2 个选项');
  eq(new Set(opts).size, 2, '两个选项仍然互不相同');
}
{
  /* 只有一个词：选项只有 1 个，点它算答对，能走完 */
  const sb = synthSandbox([mkWord('alpha', 'n. 甲')]);
  sb.EnUnit.setView('quiz');
  eq(sb.__doc.querySelectorAll('.en-opt').length, 1, '只有一个词时只出 1 个选项');
  sb.__doc.querySelector('.en-opt').click();
  ok(sb.__doc.querySelector('.en-opt').classList.contains('correct'), '点唯一的选项算答对');
  eq(sb.EnUnit.known(), 1, '该词进已掌握');
  sb.__doc.querySelector('[data-quiz="next"]').click();
  eq(sb.EnUnit.state().qDone, true, '一题也能收尾');
}
{
  /* 只有一个词时评「不会」：出队又回来，队列不会空（不能卡死在空态） */
  const sb = synthSandbox([mkWord('alpha', 'n. 甲')]);
  sb.EnUnit.setView('review');
  eq(sb.EnUnit.state().queue, 1, '新词到期');
  sb.EnUnit.rate(1);
  eq(sb.EnUnit.state().queue, 1, '不会 → 回到队列（只有它自己，所以还是 1）');
  ok(!!sb.__doc.querySelector('.en-rev .en-card'), '还能继续复习，不是空态');
  sb.EnUnit.rate(4);
  eq(sb.EnUnit.state().queue, 0, '会 → 出队');
}

/* ===================== 结论 ===================== */
console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 条失败 / ' + (pass + fails.length) : '✓ 全部通过 (' + pass + ')'));
if (fails.length) {
  fails.forEach(f => console.log('  × ' + f));
  process.exit(1);
}
