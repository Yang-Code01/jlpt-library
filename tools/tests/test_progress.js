/* 共享进度脚本的行为测试（无框架，node tools/tests/test_progress.js）
 *
 * 两层：
 *   A 回归  —— 日语侧现有行为一条不许变（模块勾选、索引盖章、进度条、导入过滤）
 *   B 新契约 —— 英语侧的 key 形态、window.LibProgress 四个方法、面板计数只算日语
 *
 * 这是「测试缝 2」（VM + 迷你 DOM 驱动共享脚本），不进仓库。
 */
'use strict';
const path = require('path');
const H = require('./dom.js');

const PROGRESS = path.resolve(__dirname, '../../assets/progress.js');

let pass = 0; const fails = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? '  ::  ' + extra : ''));
}
function show(v) {
  if (v && v.nodeType) return '<' + String(v.tagName).toLowerCase() + (v.id ? '#' + v.id : '') + '>';
  return JSON.stringify(v);
}
function eq(a, b, name) {
  ok(Object.is(a, b), name, 'got ' + show(a) + ' want ' + show(b));
}
function section(t) { console.log('\n— ' + t); }
function progressOf(sb) { return JSON.parse(sb.__store.get('jlpt-progress') || '{}'); }
function doneOf(sb) { return progressOf(sb).done || {}; }
function modOf(sb) { return progressOf(sb).mod || {}; }
/* 无 API 时给个空壳，让断言失败而不是抛错——一次跑完能看全部红点 */
var NOOP_API = { isDone: () => false, markDone() {}, unmark() {}, count: () => 0 };
function apiOf(sb) {
  const a = sb.LibProgress;
  return (a && typeof a.isDone === 'function') ? a : NOOP_API;
}

/* 造一个单元页沙箱：nav.pagenav + N 个 div.gp[id] */
function unitSandbox(nav, gps, pathname, seed) {
  const html = (nav ? '<nav class="pagenav"></nav>' : '') +
    Array.from({ length: gps }, (_, i) => `<div class="gp" id="gp${i + 1}"></div>`).join('');
  const sb = H.makeSandbox({ pathname, html });
  if (seed) sb.__store.set('jlpt-progress', JSON.stringify(seed));
  H.runFile(sb, PROGRESS);
  return sb;
}

/* 造一个索引页沙箱 */
function indexSandbox(seed) {
  const html = [
    '<header class="top"></header>',
    '<div class="level-block" id="n5">',
    '  <div class="stats"><span>24 个单元</span></div>',
    '  <details class="mod"><summary>语法</summary>',
    '    <ul class="unit-list">',
    '      <li><a href="n5/grammar/01.html">01</a></li>',
    '      <li><a href="n5/grammar/02.html">02</a></li>',
    '    </ul></details>',
    '</div>'
  ].join('\n');
  const sb = H.makeSandbox({ pathname: '/jlpt-library/n5/index.html', html });
  if (seed) sb.__store.set('jlpt-progress', JSON.stringify(seed));
  H.runFile(sb, PROGRESS);
  return sb;
}

/* ===================== A 回归：日语侧 ===================== */
section('A1 单元页：模块勾选框 + 页面总控');
{
  const sb = unitSandbox(true, 3, '/jlpt-library/n5/grammar/01.html');
  const doc = sb.__doc;
  eq(doc.querySelectorAll('div.gp label.pg-check').length, 3, '每个 div.gp 末尾挂一个勾选框');
  eq(doc.querySelectorAll('nav.pagenav label.pg-check').length, 1, 'nav.pagenav 里挂一个页面总控');
  eq(doc.querySelector('nav.pagenav .pg-pct').textContent, '0/3 · 0%', '总控初始百分比');

  const boxes = doc.querySelectorAll('div.gp input.pg-input');
  boxes[0].checked = true; boxes[0].fire('change');
  boxes[1].checked = true; boxes[1].fire('change');
  eq(progressOf(sb).done['n5/grammar/01.html'], undefined, '只勾 2/3 → 页面级不写');
  eq(doc.querySelector('nav.pagenav .pg-pct').textContent, '2/3 · 67%', '总控百分比跟随');

  boxes[2].checked = true; boxes[2].fire('change');
  ok(typeof progressOf(sb).done['n5/grammar/01.html'] === 'number', '勾满 3/3 → 页面级写入时间戳');
  eq(doc.querySelector('nav.pagenav .pg-input').checked, true, '总控自动打勾');

  boxes[1].checked = false; boxes[1].fire('change');
  eq(progressOf(sb).done['n5/grammar/01.html'], undefined, '取消任一模块 → 页面级删除');
}

section('A2 索引页：单元盖章 + 分组计数 + 总进度条');
{
  const sb = indexSandbox({ v: 2, done: { 'n5/grammar/01.html': 1757152320000 }, mod: {} });
  const doc = sb.__doc;
  const as = doc.querySelectorAll('details.mod ul.unit-list a[href]');
  eq(as.length, 2, '两张单元卡');
  ok(as[0].classList.contains('is-done'), '已看的卡盖 is-done');
  ok(!as[1].classList.contains('is-done'), '未看的卡不盖');
  eq(doc.querySelector('details.mod summary .mod-done').textContent, '已看 1/2', '分组计数');
  eq(doc.querySelectorAll('.lv-done').length, 1, '级别药丸追加 .lv-done');
  eq(doc.querySelector('.lv-done').textContent, '已看 1/2', '级别计数');

  const bar = doc.querySelector('.pg-overall');
  ok(!!bar, '.pg-overall 已注入');
  eq(bar.parentNode, doc.body, '挂在 body 下');
  eq(bar.nextElementSibling, null, '.pg-overall 是 body 末子（header.top 之后）');
  eq(bar.querySelector('.pg-num').textContent, '已看 1 / 2 单元', '总进度数字');
  eq(bar.querySelector('.pg-fill').style.width, '50.0%', '总进度条宽度');
}

section('A3 导入过滤：英语合法单元进，模块入口页与垃圾键出');
{
  const sb = indexSandbox();
  sb.__doc.querySelector('.pg-manage').click();
  const dlg = sb.__doc.querySelector('dialog.pg-dialog');
  ok(!!dlg, '面板已挂出');

  const payload = {
    v: 2,
    done: {
      'n5/grammar/02.html': 111,
      'en/1k/01.html': 222,
      'reading/1k/01.html': 555,
      'en/typing/index.html': 333,
      'en/dictation/index.html': 444,
      'en/reading/index.html': 666,
      'bogus': 777
    },
    mod: { 'n5/grammar/02.html#gp1': 1, 'en/1k/01.html#c3': 2 }
  };
  const input = dlg.querySelector('.pg-file');
  input.files = [H.makeFile('backup.json', JSON.stringify(payload))];
  input.fire('change');

  const d = doneOf(sb);
  eq(d['n5/grammar/02.html'], 111, '日语单元进');
  eq(d['en/1k/01.html'], 222, '英语词表单元进');
  eq(d['reading/1k/01.html'], 555, '英语阅读页进');
  eq(d['en/typing/index.html'], undefined, '打字模块入口页被忽略');
  eq(d['en/dictation/index.html'], undefined, '听写模块入口页被忽略');
  eq(d['en/reading/index.html'], undefined, '阅读模块入口页被忽略');
  eq(d['bogus'], undefined, '无法识别的键被忽略');
  eq(modOf(sb)['n5/grammar/02.html#gp1'], 1, '日语模块记录进');
  eq(modOf(sb)['en/1k/01.html#c3'], undefined, '英语侧不产生模块记录（导入时被过滤）');
  ok(/忽略 5 条/.test(dlg.querySelector('.pg-dlg-msg').textContent), '提示里报出忽略条数',
    dlg.querySelector('.pg-dlg-msg').textContent);
}

section('A4 英语页不挂日语式勾选框');
{
  const sb = unitSandbox(true, 0, '/jlpt-library/en/1k/01.html');
  eq(sb.__doc.querySelectorAll('label.pg-check').length, 0, '英语词表页不生成 済 勾选框');
}
{
  const sb = unitSandbox(true, 0, '/jlpt-library/n5/grammar/01.html');
  eq(sb.__doc.querySelectorAll('nav.pagenav label.pg-check').length, 1,
    '没有模块的日语页仍保留手工标记（回归）');
}

/* ===================== B 新契约：英语侧 ===================== */
section('B1 window.LibProgress 存在且只暴露四个方法');
{
  const sb = unitSandbox(false, 0, '/jlpt-library/en/1k/01.html');
  const api = sb.LibProgress;
  ok(!!api, 'LibProgress 已挂到 window');
  ['isDone', 'markDone', 'unmark', 'count'].forEach(function (k) {
    eq(typeof (api || {})[k], 'function', '方法 ' + k);
  });
  eq(Object.keys(api || {}).sort().join(','), 'count,isDone,markDone,unmark', '不多不少四个');
}

section('B2 读写走同一套 key 归一化');
{
  const sb = unitSandbox(false, 0, '/jlpt-library/');
  const L = apiOf(sb);
  eq(L.isDone('en/1k/01.html'), false, '未标记时为 false');
  L.markDone('en/1k/01.html');
  eq(L.isDone('en/1k/01.html'), true, '标记后为 true');
  eq(L.isDone('/jlpt-library/en/1k/01.html'), true, '带前导目录的 URL 归一化到同一键');
  eq(L.isDone('en/1k/01.html#card3'), true, '带 hash 也归一化到同一键');
  ok(typeof doneOf(sb)['en/1k/01.html'] === 'number', '落盘的是末三段键');
  L.unmark('en/1k/01.html');
  eq(L.isDone('en/1k/01.html'), false, '取消后为 false');
  eq(doneOf(sb)['en/1k/01.html'], undefined, '取消后从存储里删掉');
}

section('B3 count(prefix) 与 count(prefix, list)');
{
  const sb = unitSandbox(false, 0, '/jlpt-library/');
  const L = apiOf(sb);
  L.markDone('en/1k/01.html');
  L.markDone('en/1k/02.html');
  L.markDone('reading/1k/01.html');
  L.markDone('n5/grammar/01.html');
  eq(L.count('en/'), 2, '只数英语词表页');
  eq(L.count('reading/'), 1, '只数英语阅读页');
  eq(L.count(''), 4, '空前缀数全部');
  eq(L.count('', ['en/1k/01.html', 'en/1k/02.html', 'en/1k/03.html']), 2, '给 list 时只数清单内的已看项');
  eq(L.count('en/', ['en/1k/01.html', 'reading/1k/01.html']), 1, 'list 与 prefix 同时生效');
}

section('B4 进度面板计数只算日语');
{
  const sb = indexSandbox({
    v: 2,
    done: {
      'n5/grammar/01.html': 1,
      'en/1k/01.html': 2,
      'en/2k/03.html': 3,
      'reading/1k/01.html': 4
    },
    mod: { 'n5/grammar/01.html#gp1': 1 }
  });
  sb.__doc.querySelector('.pg-manage').click();
  eq(sb.__doc.querySelector('.pg-dlg-num').textContent,
    '已看 1 个单元 · 已掌握 1 个知识点',
    '英语与阅读页不混进「已看 n 个单元」');
}

/* ===================== 结论 ===================== */
console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 条失败 / ' + (pass + fails.length) : '✓ 全部通过 (' + pass + ')'));
if (fails.length) {
  fails.forEach(f => console.log('  × ' + f));
  process.exit(1);
}
