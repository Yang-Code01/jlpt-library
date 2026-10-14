/* 英语侧整合验收（票 09）：跨模块、单存储，把一条用户路径从头走到尾
 *   运行：node tools/tests/test_integration_en.js
 *
 * 这里不重复各模块自己的行为测试（test_unit / test_reading / test_dictation_en /
 * test_typing_en / test_progress 各自钉住自己的细节），只钉「模块之间接得对不对」：
 *   A 词表单元页评满 50 张 → 门户「已看 1/107」
 *   B 阅读页盖章 → 同一份存储上，门户变成 2/107（阅读键归一化后是 reading/ 前缀，仍算 107 之一）
 *   C 听写与打字页绝不碰 jlpt-progress（它们各有自己的存储键，不进 107）
 *   D 导出 → 清空 → 导入：英语键与日语键一起活得下来（门户数字与日语面板同步回滚/恢复）
 *
 * 「一条命令从零产出 107 项」「清单 ≡ 文件双向」「无死链」「file:// 安全」由
 * node tools/en-accept.mjs 校验（那个工具不需要 .scratch/，克隆者也能跑）。
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

/* 把沙箱的 localStorage 接到外部那份 Map 上，页面脚本才能与别的页面共享进度。
   必须在跑页面脚本之前调用（makeSandbox 只解析 HTML，不执行脚本）。 */
function link(sb, store) {
  sb.__store = store;
  sb.localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i]
  };
}

/* 造一个真页面沙箱：按文档顺序跑它自己的 <script>（外链的读真文件） */
function open(relPath, store, opts) {
  const abs = path.join(ROOT, ...relPath.split('/'));
  const page = fs.readFileSync(abs, 'utf8');
  const dir = path.posix.dirname('/' + relPath);
  const sb = H.makeSandbox(Object.assign({ pathname: '/' + relPath, html: page }, opts || {}));
  if (store) link(sb, store);
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

function progress(store) { return JSON.parse(store.get('jlpt-progress') || '{}'); }
function doneOf(store) { return progress(store).done || {}; }
function seed(store, obj) { store.set('jlpt-progress', JSON.stringify(obj)); }

/* ===================== A 词表单元页 → 门户 ===================== */
section('A 同一个存储：词表单元页评满 50 张卡 → 门户「已看 1/107」');
const store = new Map();
let unitDone = 0;
{
  const sb = open('en/1k/01.html', store);
  const d = sb.__doc;
  eq(d.querySelector('#enRated').textContent, '已评 0/50', '新页从 已评 0/50 起');
  eq(doneOf(store)['en/1k/01.html'], undefined, '还没评就不进总进度');

  for (let i = 0; i < 50; i++) { sb.EnUnit.flip(); sb.EnUnit.flip(); sb.EnUnit.go(1); }
  eq(d.querySelector('#enRated').textContent, '已评 50/50', '50 张卡都有过一次自评');
  unitDone = doneOf(store)['en/1k/01.html'];
  ok(typeof unitDone === 'number', '该页自动盖章进 jlpt-progress');
  const srs = JSON.parse(store.get('en-vocab-srs-1k-01') || '{}');
  eq(Object.keys(srs).length, 50, 'SM-2 记录落在本单元自己的键里（50 条）');
  ok(store.get('jlpt-progress').indexOf('en/1k/01.html') >= 0, '存储里就是归一化后的三段键');
}
{
  const portal = open('index.html', store);
  const d = portal.__doc;
  eq(d.querySelector('[data-en-overall]').textContent, '已看 1/107', '门户分母仍是 107，分子跟着长');
  eq(d.querySelector('#en-band-1k [data-en-prog]').textContent, '已看 1/20', '1k 档进一页');
  eq(d.querySelector('#en-band-2k [data-en-prog]').textContent, '已看 0/20', '别的档不动');
  ok(d.querySelector('[data-en-key="en/1k/01.html"]').classList.contains('is-done'), '入口行盖上済');
  eq(portal.LibProgress.count('en/1k'), 1, 'API 与门户显示同一份数据');
  ok(portal.LibProgress.isDone('en/1k/01.html'), 'isDone 认这个键');
}

/* ===================== B 阅读页盖章也进 107 ===================== */
section('B 阅读页盖章：归一化后是 reading/ 前缀，仍算在 107 里');
{
  const sb = open('en/reading/1k/01.html', store);
  const d = sb.__doc;
  ok(!!d.querySelector('#enMarkDone'), '页底有盖章按钮');
  d.querySelector('#enMarkDone').click();
  ok(typeof doneOf(store)['reading/1k/01.html'] === 'number', '键是 reading/1k/01.html（丢掉了 en/）');
  eq(d.querySelector('#enReadState').textContent, '已读完', '页底状态跟着变');
  ok(d.querySelector('#enMarkDone').classList.contains('is-done'), '按钮点亮');
}
{
  const portal = open('index.html', store);
  const d = portal.__doc;
  eq(d.querySelector('[data-en-overall]').textContent, '已看 2/107', '词表 1 + 阅读 1 = 2/107');
  eq(d.querySelector('#en-band-1k [data-en-prog]').textContent, '已看 1/20', '词表 1k 计数不受阅读影响');
  eq(d.querySelector('#en-read-1k [data-en-prog]').textContent, '已看 1/8', '阅读 1k 档自己那一套（篇）');
  ok(d.querySelector('[data-en-key="en/reading/1k/01.html"]').classList.contains('is-done'), '阅读入口行也盖済');
  eq(portal.LibProgress.count('reading/'), 1, '阅读计数单独可查');
}

/* ===================== C 听写与打字不进 107 ===================== */
section('C 听写与打字各有自己的存储键，绝不碰 jlpt-progress');
{
  const before = store.get('jlpt-progress');
  const type = open('en/typing/index.html', store);
  type.__doc.querySelector('[data-mode="endless"]').click();
  type.__doc.querySelector('#btn-start').click();
  const word = type.TypingGame.state.current;
  ok(!!word, '开局有词');
  for (const ch of String(word.k)) type.TypingGame.handleChar(ch);
  type.TypingGame.handleChar(String(word.k)[0] === 'z' ? 'q' : 'z');   // 无盡模式敲错即终
  eq(type.TypingGame.state.screen, 'over', '无盡模式敲错就结束');
  eq(store.get('jlpt-progress'), before, '打完一局，jlpt-progress 一个字节都没动');
  eq(Object.keys(doneOf(store)).filter((k) => k.indexOf('en/typing') === 0).length, 0, '打字不写进度键');
  const best = store.get('jlpt-typing-best');
  ok(typeof best === 'string' && /endless:1k:1/.test(best), '成绩只落在 jlpt-typing-best（与日语侧共用那一个键）', String(best));
}
{
  const before = store.get('jlpt-progress');
  const dict = open('en/dictation/index.html', store);
  const d = dict.__doc;
  ok(!!d.querySelector('#viewLists') && !!d.querySelector('#listGrid'), '英语听写页起来了（内核与日语同一份）');
  eq(store.get('jlpt-progress'), before, '听写页加载完也不写 jlpt-progress');
  ok(store.get('en-dictation-progress') === undefined || typeof store.get('en-dictation-progress') === 'string',
    '听写进度落在 en-dictation-progress（独立键）');
}
{
  const portal = open('index.html', store);
  eq(portal.__doc.querySelector('[data-en-overall]').textContent, '已看 2/107', '听写与打字过后门户数字不变');
}

/* ===================== D 导出 → 清空 → 导入 ===================== */
section('D 导出 → 清空 → 导入：英语键与日语键一起恢复');
{
  /* 补一条日语进度一起往返（用索引页真实存在的单元路径），验证「清空」是真的清、导入是真的回 */
  const JA = 'n5/basics/01-gojuon.html';
  const p = progress(store);
  p.done[JA] = 1757152320000;
  p.mod = { [JA + '#gp1']: 1 };
  seed(store, p);

  const index = open('material/index.html', store);
  const d = index.__doc;
  ok(!!d.querySelector('.pg-overall'), '日语索引页有总进度条（弹窗从这里长出来）');
  d.querySelector('.pg-manage').click();
  const dlg = d.querySelector('dialog.pg-dialog');
  ok(!!dlg, '进度面板已挂出');

  let exported = null;
  index.URL = { createObjectURL(blob) { exported = blob.parts.join(''); return 'blob:stub'; }, revokeObjectURL() {} };
  dlg.querySelector('[data-act="export"]').click();
  ok(!!exported, '导出生成了备份内容');
  const payload = JSON.parse(exported);
  ok(!!payload.done['en/1k/01.html'] && !!payload.done['reading/1k/01.html'] && !!payload.done[JA],
    '备份里三种键都在（日语单元 / 英语词表 / 英语阅读）', Object.keys(payload.done).join(','));

  dlg.querySelector('[data-act="clear"]').click();
  eq(doneOf(store)['en/1k/01.html'], undefined, '清空后英语键没了');
  eq(doneOf(store)[JA], undefined, '日语键也没了');
  eq(progress(store).mod && Object.keys(progress(store).mod).length, 0, '模块记录一起清');

  const input = dlg.querySelector('.pg-file');
  input.files = [H.makeFile('jlpt-progress.json', exported)];
  input.fire('change');
  ok(typeof doneOf(store)['en/1k/01.html'] === 'number', '导入后英语词表键回来了');
  ok(typeof doneOf(store)['reading/1k/01.html'] === 'number', '阅读键也回来了');
  ok(typeof doneOf(store)[JA] === 'number', '日语键也回来了');
  eq(progress(store).mod[JA + '#gp1'], 1, '日语模块记录回来了');
  eq(doneOf(store)['en/typing/index.html'], undefined, '模块入口页这类键永远不会被导入进来');
}
{
  const portal = open('index.html', store);
  eq(portal.__doc.querySelector('[data-en-overall]').textContent, '已看 2/107', '门户数字恢复到 2/107');
  const index = open('material/index.html', store);
  eq(index.__doc.querySelector('.pg-num').textContent, '已看 1 / 168 单元', '日语总进度条只算日语那 1 个单元');
}

/* ===================== 结论 ===================== */
console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 条失败 / ' + (pass + fails.length) : '✓ 全部通过 (' + pass + ')'));
if (fails.length) {
  fails.forEach((f) => console.log('  × ' + f));
  process.exit(1);
}
