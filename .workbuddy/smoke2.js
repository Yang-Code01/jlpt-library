/* 冒烟测试：用最小 DOM 桩跑真实的 progress.js + quiz.js。测试完即删。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* ---------- 最小 DOM ---------- */
function matches(el, sel) {
  const m = /^([a-zA-Z]*)((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/.exec(sel);
  if (!m) throw new Error('shim 不支持的选择器: ' + sel);
  const [, tag, cls, attrs] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const c of (cls.match(/\.[\w-]+/g) || [])) if (!el._cls.has(c.slice(1))) return false;
  for (const a of (attrs.match(/\[([\w-]+)\]/g) || [])) {
    const name = a.slice(1, -1);
    if (name === 'id' ? !el.attrs.id : !(name in el.attrs)) return false;
  }
  return true;
}
function parseSel(sel) {
  const parts = []; const re = /(>|\s+)?([^\s>]+)/g; let m;
  while ((m = re.exec(sel))) parts.push({ comb: m[1] === '>' ? '>' : ' ', comp: m[2] });
  return parts;
}
function qa(root, sel) {
  let cur = [root];
  for (const p of parseSel(sel)) {
    const next = [];
    if (p.comb === '>') { for (const n of cur) for (const c of n.children) if (matches(c, p.comp)) next.push(c); }
    else { for (const n of cur) { const st = [n]; while (st.length) { const e = st.pop(); for (const c of e.children) { if (matches(c, p.comp)) next.push(c); st.push(c); } } } }
    cur = next;
  }
  return cur;
}
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.attrs = {}; this._cls = new Set(); this._ev = {};
    this.checked = false; this.textContent = ''; this.title = ''; this.open = false;
    const self = this;
    this.classList = {
      add: (...cs) => cs.forEach((c) => self._cls.add(c)),
      remove: (...cs) => cs.forEach((c) => self._cls.delete(c)),
      contains: (c) => self._cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !self._cls.has(c) : !!on; v ? self._cls.add(c) : self._cls.delete(c); return v; }
    };
  }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(' '); }
  get id() { return this.attrs.id || ''; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) {
    if (c.parentNode) { const i = c.parentNode.children.indexOf(c); if (i >= 0) c.parentNode.children.splice(i, 1); }
    c.parentNode = this; this.children.push(c); return c;
  }
  insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; return i < 0 ? this.appendChild(c) : (c.parentNode = this, this.children.splice(i, 0, c), c); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return qa(this, s); }
  addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); }
  dispatch(t) { (this._ev[t] || []).forEach((f) => f.call(this, { target: this })); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  set innerHTML(html) {
    this.children = [];
    const re = /<(\w+)([^>]*)>/g; let m;
    while ((m = re.exec(html))) {
      const el = new El(m[1]); el.parentNode = this;
      const cls = /class="([^"]*)"/.exec(m[2]); if (cls) el.className = cls[1];
      const idm = /\sid="([^"]*)"/.exec(m[2]); if (idm) el.attrs.id = idm[1];
      const tm = /type="([^"]*)"/.exec(m[2]); if (tm) el.attrs.type = tm[1];
      this.children.push(el);
    }
  }
}

function makeQuestion(answerN, answerText) {
  const q = new El('div'); q.className = 'question-block';
  const stem = new El('p'); stem.className = 'stem'; q.appendChild(stem);
  const ol = new El('ol'); ol.className = 'options'; q.appendChild(ol);
  for (let i = 1; i <= 4; i++) {
    const li = new El('li'); ol.appendChild(li);
    const num = new El('span'); num.className = 'opt-num'; num.textContent = String(i); li.appendChild(num);
    const txt = new El('span'); txt.textContent = '选项' + i; li.appendChild(txt);
  }
  const det = new El('details'); det.className = 'explanation-block'; q.appendChild(det);
  const sum = new El('summary'); sum.textContent = '答案与解析'; det.appendChild(sum);
  const ap = new El('p'); ap.className = 'answer'; ap.textContent = answerText; det.appendChild(ap);
  return q;
}

function makePage(nMod, questions) {
  const body = new El('body');
  const nav = new El('nav'); nav.className = 'pagenav'; body.appendChild(nav);
  for (let i = 1; i <= nMod; i++) {
    const gp = new El('div'); gp.className = 'gp'; gp.attrs.id = 'gp' + i;
    const h3 = new El('h3'); h3.textContent = '知识点' + i; gp.appendChild(h3);
    const p = new El('p'); p.textContent = '正文'; gp.appendChild(p);
    body.appendChild(gp);
  }
  const quiz = new El('section'); quiz.className = 'card'; quiz.attrs.id = 'quiz'; body.appendChild(quiz);
  questions.forEach((q) => quiz.appendChild(q));
  return { body, nav };
}

function run(nMod, questions, pagePath, scripts, shared) {
  const { body, nav } = makePage(nMod, questions);
  const store = shared || new Map();
  const sandbox = {
    console, Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: { pathname: pagePath },
    document: {
      readyState: 'complete', body,
      querySelector: (s) => qa(body, s)[0] || null,
      querySelectorAll: (s) => qa(body, s),
      createElement: (t) => new El(t),
      addEventListener: () => {}
    }
  };
  sandbox.window = sandbox;
  scripts.forEach((code) => vm.runInNewContext(code, sandbox));
  return { body, nav, store };
}

const PROG = fs.readFileSync(path.join(ROOT, 'assets', 'progress.js'), 'utf8');
const QUIZ = fs.readFileSync(path.join(ROOT, 'assets', 'quiz.js'), 'utf8');
let fail = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '   → ' + extra : ''));
  if (!cond) fail++;
}

console.log('--- A. 模块勾选框位置（右下 = 模块最后一个子元素）---');
{
  const { body } = run(3, [], '/jlpt/n5/grammar/01.html', [PROG]);
  const gps = body.children.filter((c) => c._cls.has('gp'));
  ok(gps.every((g) => g.children.slice(-1)[0]._cls.has('pg-mod')), '勾选框是模块的最后一个子元素');
  ok(gps.every((g) => !g.children[0]._cls.has('pg-mod')), '勾选框不再挂在标题上');
  ok(gps.every((g) => g.children[0].children.length === 0), '标题内没有被塞入东西');
  ok(gps.every((g) => !g.children[0]._cls.has('has-pg')), '不再加 has-pg 类');
}

console.log('--- B. 自测练习：答错 → 判定 + 标出正解 + 自动展开 ---');
{
  const q = makeQuestion(1, '正确答案：1（です）');
  const { body } = run(0, [q], '/jlpt/n5/grammar/01.html', [QUIZ]);
  const lis = q.querySelectorAll('ol.options > li');
  ok(lis.length === 4, '4 个选项');
  ok(lis.every((li) => !!li.querySelector('.opt-btn')), '每个选项都变成按钮');
  ok(lis.every((li) => li._cls.has('has-btn')), 'li 加上 has-btn');
  ok(lis[0].querySelector('.opt-btn').children.length === 2, '原内容（序号+文本）被移进按钮');

  const det = q.querySelector('details.explanation-block');
  const res = q.querySelector('.q-result');
  ok(!!res, '生成判定结果行');
  ok(det.children.indexOf(res) < 0 && q.children.indexOf(res) === q.children.indexOf(det) - 1, '结果行插在解析块之前');
  ok(det.open === false, '初始解析块是收起的');

  lis[2].querySelector('.opt-btn').dispatch('click');   // 选第 3 项（错）
  ok(lis[2]._cls.has('is-picked') && lis[2]._cls.has('is-wrong'), '所选项标为错误');
  ok(lis[0]._cls.has('is-answer'), '正确项（第 1 项）被标出');
  ok(!lis[0]._cls.has('is-picked'), '正确项没被误标成所选项');
  ok(res.textContent === '回答错误 · 正确答案 1', '结果文案', res.textContent);
  ok(res._cls.has('is-wrong'), '结果行带 is-wrong');
  ok(det.open === true, '解析块自动展开');
  ok(q._cls.has('is-wrong'), '题目块带 is-wrong');
}

console.log('--- C. 自测练习：改选为正确项 ---');
{
  const q = makeQuestion(2, '正确答案：2（では）');
  const { body } = run(0, [q], '/jlpt/n5/grammar/01.html', [QUIZ]);
  const lis = q.querySelectorAll('ol.options > li');
  const det = q.querySelector('details.explanation-block');
  const res = q.querySelector('.q-result');

  lis[0].querySelector('.opt-btn').dispatch('click');
  ok(lis[0]._cls.has('is-wrong') && lis[1]._cls.has('is-answer'), '先答错');
  lis[1].querySelector('.opt-btn').dispatch('click');
  ok(lis[1]._cls.has('is-picked') && lis[1]._cls.has('is-answer'), '改选后标为正确');
  ok(!lis[0]._cls.has('is-wrong') && !lis[0]._cls.has('is-picked'), '旧的答错标记被清除');
  ok(!lis[0]._cls.has('is-answer'), '旧的正解高亮被清除');
  ok(res.textContent === '回答正确', '结果文案', res.textContent);
  ok(res._cls.has('is-right') && !res._cls.has('is-wrong'), '结果行状态切换正确');
  ok(q._cls.has('is-right') && !q._cls.has('is-wrong'), '题目块状态切换正确');
  ok(det.open === true, '解析块保持展开');
}

console.log('--- D. 答案无法解析时不做改造（不能误判）---');
{
  const q = makeQuestion(null, '答案见教材第 5 页');
  const { body } = run(0, [q], '/jlpt/n5/grammar/01.html', [QUIZ]);
  ok(q.querySelectorAll('.opt-btn').length === 0, '没有生成按钮');
  ok(!q.querySelector('.q-result'), '没有生成结果行');
  ok(q.querySelectorAll('ol.options > li')[0].children.length === 2, '选项内容保持原样');
}

console.log('--- E. 两者共存时互不干扰 ---');
{
  const q = makeQuestion(4, '正确答案：4（ました）');
  const { body, nav } = run(5, [q], '/jlpt/n5/grammar/01.html', [PROG, QUIZ]);
  const gps = body.children.filter((c) => c._cls.has('gp'));
  ok(gps.length === 5, '知识点模块勾选框仍为 5 个', gps.length);
  ok(gps.every((g) => g.children.slice(-1)[0]._cls.has('pg-mod')), '仍在模块末尾');
  ok(q.querySelectorAll('.opt-btn').length === 4, '题目按钮正常生成');
  ok(nav.querySelector('.pg-pct').textContent === '0/5 · 0%', 'quiz 不计入知识点进度', nav.querySelector('.pg-pct').textContent);
  ok(body.children.find((c) => c.id === 'quiz').querySelectorAll('.pg-mod').length === 0, 'quiz 区块无进度勾选框');

  // 勾满 5 个模块 → 顶部自动勾选 + 100%
  gps.forEach((g) => { const i = g.children.slice(-1)[0].querySelector('.pg-input'); i.checked = true; i.dispatch('change'); });
  ok(nav.querySelector('.pg-pct').textContent === '5/5 · 100%', '勾满 → 100%', nav.querySelector('.pg-pct').textContent);
  ok(nav.querySelector('.pg-input').checked === true, '勾满 → 顶部自动勾选');
}

console.log(fail ? '\n结果：' + fail + ' 项失败' : '\n结果：全部通过');
process.exit(fail ? 1 : 0);
