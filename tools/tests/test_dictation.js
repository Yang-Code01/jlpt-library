/* ============================================================
   听写内核 · 回归 + 语言层覆盖测试（迷你 DOM，无框架、无浏览器）
   运行：node tools/tests/test_dictation.js   （失败退出码 1）

   这是票 02「两个日语内核开口」的听写侧回归缝：本仓库原本**没有**听写测试。
   A 段钉住「不设覆盖对象时日语侧行为逐字不变」，
   B 段钉住「设了覆盖对象后语言层确实改变」。

   驱动方式与真实页面一致：解析 dictation/index.html 的真 DOM，
   注入一份合成词表，跑 dictation.js，然后点真按钮 / 填真输入框。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeSandbox, run, loadHTML, parseHTML } = require('./dom.js');

const REPO = path.resolve(__dirname, '../..');
const DICT = path.join(REPO, 'dictation');
const HTML = fs.readFileSync(path.join(DICT, 'index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(DICT, 'dictation.js'), 'utf8');

/* ---------- 断言工具 ---------- */
let failed = 0, total = 0;
function ok(cond, name, extra) {
  total++;
  if (cond) console.log('  PASS  ' + name);
  else { failed++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  → ' + extra)); }
}
function eq(a, b, name) {
  const same = String(a) === String(b);
  ok(same, name, same ? '' : 'got ' + show(a) + ' want ' + show(b));
}
function show(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') {
    if (v.nodeType === 1) return '<' + String(v.tagName).toLowerCase() + (v.id ? '#' + v.id : '') + '>';
    try { return JSON.stringify(v); } catch (e) { return '[object]'; }
  }
  return JSON.stringify(v);
}
function section(t) { console.log('\n# ' + t); }

/* ---------- 合成词表 ---------- */
function lists() {
  return [
    { id: 'a1', title: '課堂A', group: 'Grp1', desc: 'desc-a', color: '--sumi-3', words: [
      { w: '否定', k: 'ひてい', m: '否定', p: '名詞' },
      { w: '一切', k: 'いっさい', m: '一切', p: '副詞' },
      { w: '全然', k: 'ぜんぜん', m: '完全', p: '副詞' }
    ] },
    { id: 'a2', title: '課堂B', group: 'Grp1', desc: '', color: '--sumi-2', words: [
      { w: '大丈夫', k: 'だいじょうぶ', m: '没关系', p: '形動' }
    ] },
    { id: 'b1', title: '身体', group: 'Grp2', desc: '', color: '--sumi-1', words: [
      { w: '頭', k: 'あたま', m: '头', p: '名詞' }
    ] }
  ];
}

/* ---------- 沙箱工厂 ---------- */
function boot(cfg, voices) {
  const spoken = [];          // 每次 new SpeechSynthesisUtterance → speak() 的记录
  const timers = [];          // 挂起的 setTimeout（测试手动 flush，避免真等待）

  const sb = makeSandbox({
    pathname: 'dictation/index.html',
    html: HTML,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    speechSynthesis: {
      getVoices: () => voices || [],
      speak(u) { spoken.push(u); if (u.onend) u.onend(); },
      cancel() {},
      addEventListener() {},
      onvoiceschanged: undefined
    }
  });
  sb.SpeechSynthesisUtterance = function (text) {
    this.text = text; this.lang = ''; this.rate = 1; this.voice = null;
    this.onend = null; this.onerror = null;
  };
  sb.window.DICTATION_LISTS = lists();
  if (cfg) sb.window.DICTATION_CFG = cfg;
  run(sb, SRC, 'dictation.js');

  const $ = (id) => sb.__doc.body.querySelector('#' + id);
  const flush = () => { while (timers.length) timers.shift().fn(); };
  return { sb, spoken, timers, flush, $, doc: sb.__doc, store: sb.__store };
}

/* 走真实交互：填输入框 → 点提交 */
function answer(B, text) {
  const inp = B.doc.body.querySelector('#answerInput');
  inp.value = text;
  B.doc.body.querySelector('#btnSubmit').fire('click');
}
function click(B, sel) {
  const el = B.doc.body.querySelector(sel);
  if (!el) throw new Error('找不到 ' + sel);
  el.fire('click');
  return el;
}
function sub(B, id) { return B.doc.body.querySelector('#' + id); }
function change(B, sel, value) {
  const el = B.doc.body.querySelector(sel);
  if (!el) throw new Error('找不到 ' + sel);
  el.value = value;
  el.fire('change');
  return el;
}

/* ============================================================ */
section('A. 不设覆盖对象 —— 日语侧逐项不变');

const A = boot(null, [{ lang: 'en-US' }, { lang: 'ja' }, { lang: 'ja-JP' }]);

section('A1 初始化与词单视图');
ok(sub(A, 'viewLists').style.display !== 'none', 'viewLists 初始可见（display 非 none）');
eq(sub(A, 'viewPractice').style.display, 'none', 'viewPractice 初始隐藏');
eq(sub(A, 'listGrid').querySelectorAll('.list-card').length, 3, '渲染 3 张词单卡');
eq(sub(A, 'listGrid').querySelectorAll('.list-group-title').length, 2, '两个分组标题');
eq(sub(A, 'listGrid').querySelector('.list-group-title').textContent, 'Grp1', '分组标题文案');
ok(sub(A, 'listGrid').innerHTML.indexOf('3 词') >= 0, '词卡显示「n 词」');
eq(sub(A, 'wbBadge').textContent, '0', '错词本徽标初始 0');
ok(sub(A, 'btnReview').disabled === true, '错词本为空时「复习错词」禁用');

section('A2 点词单 → 进入练习');
click(A, '.list-card[data-id="a1"]');
eq(sub(A, 'viewLists').style.display, 'none', '进入练习后词单视图隐藏');
eq(sub(A, 'viewPractice').style.display, '', '练习视图显示');
eq(sub(A, 'hdrTitle').textContent, '日语单词听写', '标题文案（日语）');
eq(sub(A, 'hdrSub').textContent, '課堂A · 答错后拼写正确再进入下一词', '副标题文案');
eq(sub(A, 'sideStatus').textContent, '进行中', '侧栏状态文案');
eq(sub(A, 'footRemain').textContent, '还剩 3 个词', '剩余词数（首词）');
eq(sub(A, 'cntNow').textContent, '1', '进度 1 / n');
eq(sub(A, 'cntTotal').textContent, '3', '进度总数');
eq(sub(A, 'listTabs').querySelectorAll('.ltab').length, 2, '同组页签 2 个（Grp1）');
eq(sub(A, 'meaningText').textContent, '否定', '默认显示中文释义');
eq(sub(A, 'playStatus').textContent, '未播放 · 浏览器语音 · 0.9×', '初始播放状态文案');

section('A3 语音选择：精确 lang 优先，前缀兜底；默认播放 2 次');
A.flush();                       // 触发 loadWord 里 250ms 后的自动播放
ok(A.spoken.length === 2, '每题默认播放 2 次（settings.repeats=2）', A.spoken.length);
eq(A.spoken[0].lang, 'ja-JP', 'utterance.lang = ja-JP');
eq(A.spoken[0].text, '否定', '朗读文本 = item.s || item.w');
ok(A.spoken[0].voice && A.spoken[0].voice.lang === 'ja-JP', '语音挑选：精确 ja-JP 排在 ja 前缀之前');
eq(sub(A, 'playStatus').textContent, '已播放 2 次 · 浏览器语音 · 0.9×', '播放结束后状态文案');

section('A4 判题：acceptMode=both 时 w / k 都对');
answer(A, 'ひてい');
eq(sub(A, 'fbLine').textContent, '正确！按 Enter 进入下一词', '答对反馈文案');
eq(sub(A, 'statDone').textContent, '1', '已完成 +1');
eq(sub(A, 'answerInput').disabled, true, '答对后输入框锁定');
eq(sub(A, 'btnSubmit').textContent, '下一词 →', '提交键变成「下一词」');
eq(sub(A, 'wordResult').querySelector('.wr-badge').textContent, '一次通过', '本词结果徽标');

section('A5 进度写入 dictation-progress-v2');
let prog = JSON.parse(A.store.get('dictation-progress-v2') || '{}');
ok(!!prog.a1, '按 listId 记进度');
eq(prog.a1.keys.length, 1, '记录 1 个已练词（wordKey = w|k）');
eq(prog.a1.keys[0], '否定|ひてい', 'wordKey 形状 = w|k');

section('A6 答错 → 错词本 + 错误计数；答对 → 移出错词本');
click(A, '.ltab[data-id="a2"]');         // 切到同组另一表（走页签，不刷新页面）
eq(sub(A, 'cntTotal').textContent, '1', '切表后队列长度 1');
answer(A, 'まちがい');
eq(sub(A, 'fbLine').textContent, '拼写错误 · 正确答案：大丈夫（だいじょうぶ）', '答错反馈含正确答案与假名');
eq(sub(A, 'statErr').textContent, '1', '错误次数 +1');
eq(sub(A, 'wordResult').querySelector('.wr-badge').textContent, '错误 1 次 · 请照写一遍', '答错徽标');
let wb = JSON.parse(A.store.get('dictation-wrongbook') || '[]');
eq(wb.length, 1, '错词本进 1 条');
eq(wb[0].w, '大丈夫', '错词本存 w');
eq(wb[0].k, 'だいじょうぶ', '错词本存 k');
eq(sub(A, 'wbBadge').textContent, '1', '错词本徽标更新');
A.flush();                                // 650ms 后清空输入框并重播
eq(sub(A, 'answerInput').value, '', '答错后输入框被清空');
eq(sub(A, 'answerInput').disabled, false, '答错后输入框保持可写');

answer(A, 'だいじょうぶ');
eq(sub(A, 'fbLine').textContent, '纠错通过！按 Enter 进入下一词', '照写正确 → 纠错通过');
eq(sub(A, 'wordResult').querySelector('.wr-badge').textContent, '纠错通过', '本词结果徽标 = 纠错通过');
wb = JSON.parse(A.store.get('dictation-wrongbook') || '[]');
eq(wb.length, 0, '答对后移出错词本');
eq(sub(A, 'wbBadge').textContent, '0', '徽标归零');

section('A7 已练过滤 + 练习完成');
click(A, '#btnSubmit');               // advance
eq(sub(A, 'sideStatus').textContent, '已完成', '队列走完 → 已完成');
eq(sub(A, 'footRemain').textContent, '还剩 0 个词', '完成时剩余 0');
eq(sub(A, 'mainBody').querySelector('.done-block h3').textContent, '本组练习完成', '完成块标题');
ok(sub(A, 'mainBody').innerHTML.indexOf('完成 1 词 · 错误 1 次') >= 0, '完成统计文案');
click(A, '#dbBack');
ok(sub(A, 'viewLists').style.display !== 'none', '返回词单');
ok(sub(A, 'listGrid').innerHTML.indexOf('已练 1') >= 0, '词单卡显示「已练 1」');

click(A, '.list-card[data-id="a1"]');    // a1 练过 1 个词，剩 2 个
eq(sub(A, 'cntTotal').textContent, '2', '已练的词不再出现（3 → 2）');
click(A, '.list-card[data-id="a1"]');    // 重新进入同一表
eq(sub(A, 'cntTotal').textContent, '2', '重复进入不重置已练过滤');

section('A8 设置控件默认值 + 存储键名');
click(A, '#btnSettings');
eq(sub(A, 'setRepeats').value, 2, '默认每题播放 2 次');
eq(sub(A, 'setShowHint').checked, true, '默认显示中文释义');
eq(sub(A, 'setSpeedVal').textContent, '0.9x', '默认语速 0.9 倍');
eq(sub(A, 'setGapVal').textContent, '0.8s', '默认间隔 0.8 秒');
eq(sub(A, 'grpVoicevox').style.display, 'none', '非 voicevox 引擎时隐藏 VOICEVOX 分组');
eq(sub(A, 'grpAzure').style.display, 'none', '非 azure 引擎时隐藏 Azure 分组');
eq(sub(A, 'testVoiceMsg').textContent, '', '试听状态清空');
change(A, '#setRepeats', '3');
ok(A.store.has('dictation-settings'), 'dictation-settings 写入');
eq(JSON.parse(A.store.get('dictation-settings')).repeats, 3, '播放次数改动被持久化');
ok(A.store.has('dictation-progress-v2'), 'dictation-progress-v2 存在');
ok(A.store.has('dictation-wrongbook'), 'dictation-wrongbook 存在');
ok(!A.store.has('en-dictation-wrongbook'), '未写入任何 en- 前缀键');
click(A, '#btnCloseSettings');

section('A9 当前词表弹窗');
click(A, '#btnWordList');
eq(sub(A, 'wlSub').textContent, '3 词 · 已练 1 · 组：Grp1', '当前词表弹窗副标题');
eq(sub(A, 'wlBody').querySelectorAll('tr').length, 3, '词表弹窗 3 行');
eq(sub(A, 'wlBody').querySelector('td.st').textContent, '✓ 已练', '第一行标已练');
click(A, '#btnCloseWordList');

/* ============================================================ */
section('B. 设了覆盖对象 —— 语言层确实改变');

const EN_CFG = {
  settingsKey: 'en-dictation-settings',
  progressKey: 'en-dictation-progress',
  wrongbookKey: 'en-dictation-wrongbook',
  speechLang: 'en-US',
  azLocale: 'en-US',
  voiceMatch: function (lang) { return !!lang && lang.indexOf('en') === 0; },
  norm: function (s) { return String(s == null ? '' : s).trim().toLowerCase(); },
  isAnswer: function (input, item) { return this.norm(input) === this.norm(item.w); },
  texts: {
    pageTitle: 'English Dictation',
    wrongAnswer: function (w) { return 'Spelling mistake · answer: ' + w; },
    remain: function (n) { return n + ' words left'; }
  }
};
const En = boot(EN_CFG, [{ lang: 'ja-JP' }, { lang: 'en-GB' }, { lang: 'en-US' }]);

section('B1 语音语言与挑选规则按配置改变');
click(En, '.list-card[data-id="a1"]');
En.flush();
eq(En.spoken[0].lang, 'en-US', 'utterance.lang 跟着 speechLang 变');
ok(En.spoken[0].voice && En.spoken[0].voice.lang === 'en-US', 'voiceMatch 生效（en-US 胜出，日语语音被忽略）');

section('B2 存储键按配置改变（与日语侧互不干扰）');
eq(En.store.has('dictation-wrongbook'), false, '不写日语错词本键');
eq(En.store.has('en-dictation-wrongbook'), false, '此时尚未答错');
answer(En, 'zzz');
eq(sub(En, 'statErr').textContent, '1', '答错仍计错');
ok(En.store.has('en-dictation-wrongbook'), '写入 en-dictation-wrongbook');
eq(En.store.has('dictation-wrongbook'), false, '日语错词本键仍为空');

section('B3 判题规则按配置改变');
eq(sub(En, 'fbLine').textContent, 'Spelling mistake · answer: 否定', '文案覆盖（wrongAnswer）生效');
answer(En, '  否定 ');
eq(sub(En, 'statDone').textContent, '1', '自定义 norm + isAnswer 生效（首尾空白 + 大小写不敏感）');

section('B4 文案覆盖：覆盖的换，未覆盖的回退内置日语');
eq(sub(En, 'hdrTitle').textContent, 'English Dictation', 'pageTitle 被覆盖');
eq(sub(En, 'footRemain').textContent, '3 words left', 'remain 被覆盖（当前 idx=0，队列 3 词）');
eq(sub(En, 'sideStatus').textContent, '进行中', '未覆盖的键回退内置日语文案');

/* ============================================================ */
console.log('\n' + (failed ? 'RESULT: FAIL（' + failed + '/' + total + ' 项失败）'
                           : 'RESULT: ALL PASS（共 ' + total + ' 项断言）'));
process.exit(failed ? 1 : 0);
