/* 门户「区 / 语言」两级状态机的无框架测试。
   跑法：node tools/tests/test_area.js
   做法：把 index.html 里的内联脚本抽出来，在 VM + DOM 桩里跑，断言状态与标题。
   为什么不靠读代码猜：两层状态都在 <html> 属性上，改一处极易静默错位。 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fails.push(label);
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

/* ---------------- DOM 桩 ---------------- */
function cls(initial) {
  const s = new Set(initial || []);
  return {
    _s: s,
    toggle(c, on) { const v = on === undefined ? !s.has(c) : !!on; v ? s.add(c) : s.delete(c); return v; },
    add(c) { s.add(c); },
    remove(c) { s.delete(c); },
    contains(c) { return s.has(c); },
  };
}
function el(tag, attrs, initialClasses) {
  const a = Object.assign({}, attrs || {});
  return {
    tag, attrs: a, hidden: false, _h: {},
    classList: cls(initialClasses),
    getAttribute(k) { return k in a ? a[k] : null; },
    setAttribute(k, v) { a[k] = String(v); },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    fire(t) { (this._h[t] || []).forEach((f) => f()); },
  };
}

function makeDom(opts) {
  opts = opts || {};
  const root = el('html', {});
  const metaDesc = el('meta', { name: 'description', content: '默认描述' });
  const areaBtns = [
    el('button', { 'data-area-btn': 'study' }, ['on']),
    el('button', { 'data-area-btn': 'survey' }),
  ];
  const langBtns = [
    el('button', { 'data-tab': 'ja' }, ['on']),
    el('button', { 'data-tab': 'en' }),
  ];
  const chips = (opts.chips || []).map((f) => el('button', { class: 'filter-chip', 'data-filter': f }));
  const items = (opts.items || []).map((tags) => el('div', { class: 'survey-item', 'data-tags': tags }));
  const empty = el('p', { id: 'filter-empty' });
  const document = {
    documentElement: root,
    title: '',
    readyState: 'complete',
    querySelector(sel) {
      if (/meta\[name="description"\]/.test(sel)) return metaDesc;
      if (sel === '#filter-empty') return empty;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.wb-tabs button') return areaBtns;
      if (sel === '.lang-tabs button') return langBtns;
      if (sel === '.filter-chip') return chips;
      if (sel === '.survey-item') return items;
      return [];
    },
    getElementById(id) { return id === 'filter-empty' ? empty : null; },
    addEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem(k) { return k in store ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
  };
  const location = { hash: opts.hash || '' };
  return { root, metaDesc, areaBtns, langBtns, chips, items, empty, document, localStorage, location, store };
}

/* ---------------- 抽脚本 + 跑 ---------------- */
function mkWindow(dom) {
  return {
    localStorage: dom.localStorage,
    addEventListener() {},
    scrollTo() {},
    matchMedia: undefined,
  };
}

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scripts.length === 3, `index.html 内联脚本应为 3 段，实际 ${scripts.length}`);

function boot(opts, preset) {
  const dom = makeDom(opts);
  Object.keys(preset || {}).forEach((k) => dom.localStorage.setItem(k, preset[k]));
  const window = mkWindow(dom);
  const run = (code) =>
    new Function('window', 'document', 'localStorage', 'location', 'console', code)(
      window, dom.document, dom.localStorage, dom.location, console
    );
  run(scripts[0]); // <head>：先落状态（避免首屏闪错区）
  run(scripts[1]); // 页尾：门户脚本（按钮态 + 事件）
  return { dom, window };
}

/* ---------------- 1. 默认：语言学习 / 日本語 ---------------- */
{
  const { dom } = boot();
  eq(dom.root.getAttribute('data-area'), 'study', '默认 data-area');
  eq(dom.root.getAttribute('data-lang'), 'ja', '默认 data-lang');
  eq(dom.document.title, '日语学习资料库 · Language Library', '默认标题');
  ok(/JLPT N5/.test(dom.metaDesc.getAttribute('content')), '默认描述为日语侧');
  eq(dom.areaBtns[0].classList.contains('on'), true, '默认「语言学习」Tab 高亮');
  eq(dom.areaBtns[1].classList.contains('on'), false, '默认「调查报告」Tab 不高亮');
}

/* ---------------- 2. 切到调查报告：标题换、记忆写对 ---------------- */
{
  const { dom } = boot();
  dom.areaBtns[1].fire('click');
  eq(dom.root.getAttribute('data-area'), 'survey', '切区后 data-area');
  eq(dom.document.title, '调查报告 · 工作台', '切区后标题');
  ok(/AI /.test(dom.metaDesc.getAttribute('content')), '切区后描述为调查报告侧');
  eq(dom.store['jlpt-area'], 'survey', '切区写 jlpt-area');
  eq(dom.areaBtns[1].classList.contains('on'), true, '切区后 Tab 高亮');
  eq(dom.areaBtns[1].getAttribute('aria-selected'), 'true', '切区后 aria-selected');
}

/* ---------------- 3. 记忆回填：上次在调查报告区 ---------------- */
{
  const { dom } = boot({}, { 'jlpt-area': 'survey', 'jlpt-lang': 'en' });
  eq(dom.root.getAttribute('data-area'), 'survey', '回填区=survey');
  eq(dom.root.getAttribute('data-lang'), 'en', '回填语言=en');
  eq(dom.document.title, '调查报告 · 工作台', '调查报告区标题与语言无关');
  eq(dom.langBtns[1].getAttribute('aria-selected'), 'true', '回填后语言按钮态');
}

/* ---------------- 4. 深链 #survey（报告页返回链接） ---------------- */
{
  const { dom } = boot({ hash: '#survey' });
  eq(dom.root.getAttribute('data-area'), 'survey', '#survey 深链落到调查报告区');
  eq(dom.document.title, '调查报告 · 工作台', '#survey 深链标题');
}

/* ---------------- 5. 语言开关只影响语言学习区 ---------------- */
{
  const { dom } = boot();
  dom.langBtns[1].fire('click');
  eq(dom.root.getAttribute('data-lang'), 'en', '切英语后 data-lang');
  eq(dom.document.title, '英语词表 · Language Library', '切英语后标题');
  dom.areaBtns[1].fire('click'); // 进调查报告区
  dom.langBtns[0].fire('click'); // 再切日语（区内操作）
  eq(dom.root.getAttribute('data-area'), 'survey', '调查报告区内语言开关不掉区');
  eq(dom.document.title, '调查报告 · 工作台', '调查报告区内语言开关不改标题');
  dom.areaBtns[0].fire('click'); // 回语言学习
  eq(dom.root.getAttribute('data-lang'), 'ja', '回到语言学习区仍是切过的日语');
  eq(dom.document.title, '日语学习资料库 · Language Library', '回区后标题跟语言走');
}

/* ---------------- 6. 标签筛选 ---------------- */
{
  const { dom } = boot({ chips: ['all', '技能生态', '模型'], items: ['技能生态', '技能生态 模型'] });
  const [all, eco, model] = dom.chips;
  model.fire('click');
  eq(dom.items[0].hidden, true, '模型筛选：第一篇隐藏');
  eq(dom.items[1].hidden, false, '模型筛选：第二篇显示');
  eq(dom.empty.hidden, true, '有结果时不显示空提示');
  eq(model.getAttribute('aria-pressed'), 'true', '选中 chip aria-pressed');
  eq(eco.getAttribute('aria-pressed'), 'false', '未选中 chip aria-pressed');
  all.fire('click');
  eq(dom.items[0].hidden, false, '全部：都显示');
  const none = el('button', { 'data-filter': '模型' });
  void none;
}

/* ---------------- 7. 结构断言：两个区 + 生成器标记区 + 隐藏规则 ---------------- */
{
  const body = html.slice(html.indexOf('</style>')); // 只看 markup，别把 CSS 选择器算进去
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  ok(/<div class="wb-pane" data-area-pane="study">/.test(body), '有语言学习区容器');
  ok(/<div class="wb-pane" data-area-pane="survey">/.test(body), '有调查报告区容器');
  ok(/<main id="survey" class="entries">/.test(body), '调查报告清单有 #survey 锚点');
  ok(
    /html\[data-area="study"\] \.wb-pane\[data-area-pane="survey"\][\s\S]{0,140}?display: none;/.test(css),
    '语言学习区激活时隐藏调查报告区（CSS）'
  );
  ok(
    /html\[data-area="survey"\] \.wb-pane\[data-area-pane="study"\][\s\S]{0,140}?display: none;/.test(css),
    '调查报告区激活时隐藏语言学习区（CSS）'
  );
  const i = body.indexOf('<!-- wb:report-list:start -->');
  const j = body.indexOf('<!-- wb:report-list:end -->');
  const k = body.indexOf('data-area-pane="survey"');
  const m = body.indexOf('data-area-pane="study"');
  ok(i > 0 && j > i, '报告清单标记区存在且顺序正确');
  ok(i > k, '清单标记区落在调查报告区内部（标记区不能在语言学习区里）');
  ok(k > m, '调查报告区在语言学习区之后');
  const dupes = (body.match(/class="wb-pane" data-area-pane="survey"/g) || []).length;
  eq(dupes, 1, '调查报告区容器只有 1 个');
  ok(!/data-en-key/.test(body.slice(i, j)), '清单标记区里没有 data-en-key（en-accept 要求恰 107 项）');
  ok(body.indexOf('assets/progress.js') > j, '进度脚本在报告清单之后加载');
}

/* ---------------- 结果 ---------------- */
console.log(fails.length ? '✗ 失败：' : '✓ 全部通过：', `${pass} 项`);
fails.forEach((f) => console.log('  · ' + f));
process.exit(fails.length ? 1 : 0);
