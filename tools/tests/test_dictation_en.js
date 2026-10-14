/* ============================================================
   英语听写页（en/dictation/*）· 行为冒烟测试（迷你 DOM，无框架、无浏览器）
   运行：node tools/tests/test_dictation_en.js   （失败退出码 1）

   驱动的是真页面 en/dictation/index.html —— 它自带三份脚本：
     ../data/vocab.js（1.5MB 全量词表）→ lists.js（77 个词单现算）→ cfg.js（语言层）
     → ../../dictation/dictation.js（与日语页共用的同一个内核）。
   所以这里同时钉住两件事：英语侧该有的样子，以及内核被覆盖对象接管后仍然成立的样子。

   日语侧行为逐字不变由 test_dictation.js（81 项）负责，本文件只补一条：
   日语页 HTML 里没有 #setSkipDone，证明内核新开关没有渗进日语界面。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./dom.js');

const ROOT = path.resolve(__dirname, '../..');
const EN_PAGE = 'en/dictation/index.html';

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

/* 按文档顺序跑页面自带的脚本（与 test_unit.js / test_reading.js 同一套 helper） */
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

/* 有声的 speechSynthesis 桩：日语语音排在最前，用来验「精确 en-US 优先于前缀 en-GB」 */
function boot(store, opts) {
  const spoken = [], timers = [];
  const sb = pageSandbox(EN_PAGE, store, Object.assign({
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    speechSynthesis: {
      getVoices: () => [{ lang: 'ja-JP' }, { lang: 'en-GB' }, { lang: 'en-US' }],
      speak(u) { spoken.push(u); if (u.onend) u.onend(); },
      cancel() {}, addEventListener() {}, onvoiceschanged: undefined
    }
  }, (opts || {}).sandbox || {}));
  /* 页面脚本已跑完，但引擎是「播放时才 new」，所以这时候换掉构造函数仍然生效 */
  sb.SpeechSynthesisUtterance = function (t) {
    this.text = t; this.lang = ''; this.rate = 1; this.voice = null;
    this.onend = null; this.onerror = null;
  };
  const doc = sb.__doc;
  const $ = (id) => doc.body.querySelector('#' + id);
  return {
    sb, doc, $, spoken, store: sb.__store,
    flush: () => { while (timers.length) timers.shift().fn(); },
    cards: () => doc.querySelectorAll('.list-card'),
    has: (k) => sb.__store.has(k),
    get: (k) => sb.__store.get(k),
    lists: () => sb.DICTATION_LISTS
  };
}
function click(B, sel) {
  const el = B.doc.body.querySelector(sel);
  if (!el) throw new Error('找不到 ' + sel);
  el.fire('click');
  return el;
}
function sub(B, id) { return B.doc.body.querySelector('#' + id); }
function answer(B, text) {
  sub(B, 'answerInput').value = text;
  sub(B, 'btnSubmit').fire('click');
}
function change(B, sel, value) {
  const el = B.doc.body.querySelector(sel);
  el.value = value;
  el.fire('change');
  return el;
}
/* 勾选框要连 checked 一起改，再派发 change（toggle 事件在真浏览器里由用户操作产生） */
function toggle(B, id, checked) {
  const el = sub(B, id);
  el.checked = checked;
  el.fire('change');
  return el;
}

const B = boot();
const L = B.lists();

/* ===================== A 词单视图：与 77 个词表单元一一对应 ===================== */
section('A 词单视图（77 个单元 · 四档分组）');
ok(!!B.lists(), 'window.DICTATION_LISTS 由 lists.js 现算出来');
eq(L.length, 77, '词单数 = 词表单元数 77');
eq(sub(B, 'listGrid').querySelectorAll('.list-card').length, 77, '渲染 77 张词单卡');
eq(sub(B, 'listGrid').querySelectorAll('.list-group-title').length, 4, '四个档位分组标题');
eq(sub(B, 'listGrid').querySelectorAll('.list-group-title').map((e) => e.textContent).join('|'), '1k|2k|3k|4k', '分组标题 = 四档');
eq(B.doc.querySelectorAll('.list-card')[0].querySelector('.lc-title').textContent, '单元 01', '首卡标题');
eq(B.doc.querySelectorAll('.list-card')[0].querySelector('.lc-desc').textContent, '词频位次 1–50', '首卡词频区间');
eq(B.doc.querySelectorAll('.list-card')[0].querySelector('.lc-count').textContent, '50 词', '首卡词数');
eq(L[0].words[0].w, 'the', '单元 1 第一个词 = 词频第 1 的 the');
eq(L[76].words[0].w, 'known', '末单元（77）第一个词');
eq(L[76].desc, '词频位次 3,760–3,766', '末单元词频区间（4k 档 20 单 = 2810+19*50 起）');
eq(L[76].words.length, 7, '末单元 7 词（不足 50 不报错）');
eq(L[56].desc, '词频位次 2,801–2,809', '3k 末单元 9 词（3k 只有 809 词，区间不能靠位次取模）');
eq(L[40].desc, '词频位次 2,001–2,050', '3k 首单元区间');
eq(L[57].desc, '词频位次 2,810–2,859', '4k 首单元区间');
eq(new Set(L.map((l) => l.id)).size, 77, '77 个词单 id 无重复');
eq(L[20].id, 'en-2k-21', '2k 首单元 id');
eq(L[76].id, 'en-4k-77', '末单元 id');
eq(L.reduce((n, l) => n + l.words.length, 0), 3766, '77 单合计 3766 词 = 全量词表');
ok(L.every((l) => l.words.length === l.words.length && l.color && l.group === l.id.split('-')[1]), '每单都有 group / color，group 与 id 一致');
eq(sub(B, 'wbBadge').textContent, '0', '错词本徽标初始 0');
ok(sub(B, 'btnReview').disabled === true, '错词本为空时禁用「复习本地错词」');

/* ===================== B 语言层：cfg.js 覆盖对象 ===================== */
section('B 语言层（cfg.js）');
eq(B.sb.DICTATION_CFG.speechLang, 'en-US', '发音语言 = en-US');
ok(B.sb.DICTATION_CFG.voiceMatch('en-GB') === true, 'voiceMatch 认 en-GB');
ok(B.sb.DICTATION_CFG.voiceMatch('ja-JP') === false, 'voiceMatch 不认日语');
eq(B.sb.DICTATION_CFG.norm('  Hello   World '), 'hello world', 'norm = 去首尾空白 + 小写 + 折叠内部空白');
ok(B.sb.DICTATION_CFG.isAnswer(' Year ', { w: 'year' }) === true, 'isAnswer 大小写与空白不敏感');
ok(B.sb.DICTATION_CFG.isAnswer('years', { w: 'year' }) === false, 'isAnswer 不做词形还原（多一个 s 就是错）');
ok(B.sb.DICTATION_CFG.isAnswer('   ', { w: 'year' }) === false, '空输入不算答对');
eq(B.sb.DICTATION_CFG.settingsKey, 'en-dictation-settings', '设置键与日语侧不同');
eq(B.sb.DICTATION_CFG.progressKey, 'en-dictation-progress', '进度键与日语侧不同');
eq(B.sb.DICTATION_CFG.wrongbookKey, 'en-dictation-wrongbook', '错词本键与日语侧不同');
eq(B.doc.querySelectorAll('input[name="engine"]').length, 1, '发音引擎只有一个选项（英语只用浏览器内置）');
eq(B.doc.querySelectorAll('input[name="engine"]')[0].value, 'browser', '那个选项就是 browser');
eq(sub(B, 'grpVoicevox').style.display, 'none', 'VOICEVOX 分组标记保留但隐藏');
eq(sub(B, 'grpAzure').style.display, 'none', 'Azure 分组标记保留但隐藏');
ok(B.doc.body.querySelectorAll('input[name="acceptMode"]').length === 0, '英语页不出现 acceptMode（判题已被 cfg 接管）');

/* ===================== C 进入练习：计量、页签、发音 ===================== */
section('C 进入练习');
click(B, '.list-card[data-id="en-1k-01"]');
eq(sub(B, 'viewLists').style.display, 'none', '词单视图隐藏');
eq(sub(B, 'viewPractice').style.display, '', '练习视图显示');
eq(sub(B, 'hdrTitle').textContent, '英语单词听写', '标题');
eq(sub(B, 'hdrSub').textContent, '单元 01 · 答错后拼写正确再进入下一词', '副标题 = 词单名');
eq(sub(B, 'sideListName').textContent, '单元 01 · 独立进度', '侧栏词单名');
eq(sub(B, 'cntNow').textContent, '1', '进度 1 / n');
eq(sub(B, 'cntTotal').textContent, '50', '整表 50 词');
eq(sub(B, 'footRemain').textContent, '还剩 50 个词', '剩余词数');
eq(sub(B, 'listTabs').querySelectorAll('.ltab').length, 20, '1k 档同组页签 20 个');
eq(sub(B, 'listPill').textContent, 'List 1 / 20', '页签提示 = List 1 / 20');
eq(sub(B, 'meaningText').textContent, 'art. 那', '默认显示中文释义（tr 首行）');
eq(sub(B, 'answerInput').getAttribute('placeholder'), '输入听到的单词', '输入框提示文案（cfg 覆盖）');

section('C2 发音：en-US 且精确匹配优先于前缀匹配');
B.flush();                                   // 触发进入后 250ms 的自动播放
eq(B.spoken.length, 2, '每题默认播放 2 次');
eq(B.spoken[0].lang, 'en-US', 'utterance.lang = en-US');
eq(B.spoken[0].text, 'the', '朗读文本 = 单词（英语词单没有假名层）');
ok(B.spoken[0].voice && B.spoken[0].voice.lang === 'en-US', '语音挑选：精确 en-US 胜过前缀 en-GB（getVoices 里 ja 排第一）');
eq(B.spoken[0].rate, 0.9, '语速 = 设置值 0.9');
eq(sub(B, 'playStatus').textContent, '已播放 2 次 · 浏览器语音 · 0.9×', '播放状态文案');

/* ===================== D 判题与错词本 ===================== */
section('D 判题与错词本（大小写不敏感）');
answer(B, 'The');                            // 首字母大写、词形一致 → 应算对
eq(sub(B, 'fbLine').textContent, '正确！按 Enter 进入下一词', '大小写不敏感：The 判对');
eq(sub(B, 'statDone').textContent, '1', '已完成 +1');
eq(sub(B, 'statErr').textContent, '0', '未计错');
eq(sub(B, 'wordResult').querySelector('.wr-badge').textContent, '一次通过', '本词结果徽标');

section('D2 进度写入 en-dictation-progress（不碰日语键）');
let prog = JSON.parse(B.get('en-dictation-progress') || '{}');
ok(!!prog['en-1k-01'], '按 listId 记进度');
eq(prog['en-1k-01'].keys.length, 1, '记录 1 个已练词');
eq(prog['en-1k-01'].keys[0], 'the|/ðә/', 'wordKey = 单词|音标');
ok(!B.has('dictation-progress-v2'), '不写日语进度键');
ok(!B.has('dictation-settings'), '全程不写日语设置键（设置只在改动时才落盘）');

section('D3 切页签 → 另一单元，答错入错词本 → 照写移出');
click(B, '.ltab[data-id="en-1k-02"]');
const w2 = L[1].words[0];
eq(sub(B, 'cntTotal').textContent, '50', '切表后队列 50 词');
eq(sub(B, 'cntNow').textContent, '1', '切表后回到第 1 个词');
eq(sub(B, 'hdrSub').textContent, '单元 02 · 答错后拼写正确再进入下一词', '切表同步副标题');
answer(B, 'zzz');
eq(sub(B, 'fbLine').textContent, '拼写错误 · 正确答案：' + w2.w + '（' + w2.k + '）', '答错反馈含正确答案与音标');
eq(sub(B, 'statErr').textContent, '1', '错误次数 +1');
eq(sub(B, 'wordResult').querySelector('.wr-badge').textContent, '错误 1 次 · 请照写一遍', '答错徽标');
let wb = JSON.parse(B.get('en-dictation-wrongbook') || '[]');
eq(wb.length, 1, '错词本进 1 条');
eq(wb[0].w, w2.w, '错词本存 w');
eq(wb[0].k, w2.k, '错词本存音标（记在 k 位）');
eq(sub(B, 'wbBadge').textContent, '1', '错词本徽标更新');
B.flush();                                   // 650ms 后清空输入框并重播
eq(sub(B, 'answerInput').value, '', '答错后输入框被清空');
answer(B, w2.w);                             // 照写一遍（小写形式）
eq(sub(B, 'fbLine').textContent, '纠错通过！按 Enter 进入下一词', '照写正确 → 纠错通过');
eq(JSON.parse(B.get('en-dictation-wrongbook') || '[]').length, 0, '答对后移出错词本');
eq(sub(B, 'wbBadge').textContent, '0', '徽标归零');
ok(!B.has('dictation-wrongbook'), '全程不写日语错词本键');

/* ===================== E 「练过的词不再出现」开关 ===================== */
section('E 已练过滤（默认开，可关）');
eq(sub(B, 'setSkipDone').checked, true, '默认勾选「练过的词不再出现」');
click(B, '#btnBack');                        // 返回词单：单元 01 已练 1 词、单元 02 已练 1 词
ok(sub(B, 'viewLists').style.display !== 'none', '返回词单视图');
ok(sub(B, 'listGrid').innerHTML.indexOf('已练 1') >= 0, '词单卡显示「已练 1」');
click(B, '.list-card[data-id="en-1k-01"]');
eq(sub(B, 'cntTotal').textContent, '49', '已练 1 词后队列 50 → 49');
click(B, '#btnBack');
click(B, '#btnSettings');
eq(sub(B, 'setShowHint').checked, true, '英语页沿用默认「显示中文释义」');
eq(sub(B, 'setRepeats').value, 2, '英语页沿用默认播放 2 次');
toggle(B, 'setSkipDone', false);             // 关掉开关
eq(JSON.parse(B.get('en-dictation-settings')).skipDone, false, '开关状态被持久化');
click(B, '#btnCloseSettings');
click(B, '.list-card[data-id="en-1k-01"]');
eq(sub(B, 'cntTotal').textContent, '50', '关掉开关后每次都从整表第一个词开始');
eq(sub(B, 'cntNow').textContent, '1', '关掉开关后从第 1 个词开始');
click(B, '#btnSettings');
toggle(B, 'setSkipDone', true);              // 恢复默认（后面的断言依赖它）
click(B, '#btnCloseSettings');

section('E2 日语页没有这个开关（内核新选项没有渗进日语界面）');
const jaHtml = fs.readFileSync(path.join(ROOT, 'dictation', 'index.html'), 'utf8');
ok(jaHtml.indexOf('setSkipDone') < 0, '日语听写页 HTML 里没有 #setSkipDone');
ok(jaHtml.indexOf('English') < 0, '日语听写页 HTML 里没有英语侧字样');

/* ===================== F 当前词表弹窗 ===================== */
section('F 当前词表弹窗（音标列）');
click(B, '#btnWordList');
eq(sub(B, 'wordListDialog').querySelectorAll('thead th').map((e) => e.textContent).join('|'), '#|单词|音标|中文释义|状态', '表头第三列是音标');
eq(sub(B, 'wlSub').textContent, '50 词 · 已练 1 · 组：1k', '弹窗副标题');
eq(sub(B, 'wlBody').querySelectorAll('tr').length, 50, '50 行');
eq(sub(B, 'wlBody').querySelector('td.st').textContent, '✓ 已练', '第一行标已练');
ok(sub(B, 'wlBody').innerHTML.indexOf('/ðә/') >= 0, '音标写进了表体');
click(B, '#btnCloseWordList');

/* ===================== G 门户入口 ===================== */
section('G 门户与入口');
const portal = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(portal.indexOf('en/dictation/index.html') >= 0, '门户有英语听写入口');
ok(fs.existsSync(path.join(ROOT, 'en', 'dictation', 'index.html')), '入口指向的页面存在');
ok(portal.indexOf('en/dictation/lists.js') < 0 && portal.indexOf('en/dictation/cfg.js') < 0, '门户不加载听写的数据脚本');

/* ============================================================ */
console.log('\n' + (fails.length ? 'RESULT: FAIL（' + fails.length + '/' + (pass + fails.length) + ' 项失败）'
                                 : 'RESULT: ALL PASS（共 ' + pass + ' 项断言）'));
if (fails.length) { fails.forEach((f) => console.log('  FAIL  ' + f)); process.exit(1); }
