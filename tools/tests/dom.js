/* 迷你 DOM —— 给 VM 里的共享脚本（进度脚本 / 打字内核 / 听写内核）当宿主。
 *
 * 只实现这三个脚本真正用到的子集，刻意不追求标准完备：
 *   · 元素树 + parentNode / childNodes / firstChild
 *   · classList（**真的记账**，能被 toggle(cls, force) 的第二参数驱动）
 *   · 属性、style、textContent、innerHTML（带一个够用的解析器）
 *   · querySelector / querySelectorAll：支持「标签 / .类 / #id / [属性] / 标签.类」
 *     组成的后代组合选择器（空格分隔），不支持 `>` 与 `,`
 *   · 事件冒泡（dispatchEvent 从 target 一路向上），故委托式处理器可测
 *   · localStorage / FileReader / Blob / URL / confirm / location 桩
 *
 * 为什么不用 jsdom：仓库无构建、无外部依赖，装了它就把「零依赖」这条约束破了。
 *
 * 选择器：支持「标签 / .类 / #id / [属性] / [属性=值] / [属性^=值] / [属性$=值] /
 * [属性*=值]」的后代组合（空格分隔），不支持 `>`、`,` 与伪类；遇到不认识的片段**抛错**。
 */
'use strict';

const VOID_TAGS = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'area', 'base', 'col']);

/* ============================ 选择器 ============================ */

/* 迷你选择器：故意**遇到不认识的片段就抛错**，而不是当通配。
 * 早先的宽容写法踩过坑：`.en-w:not(.x)` 被当成 `.en-w.x`、`[k^="v"]` 被当成
 * 「没有条件的复合选择器」→ 静默匹配到全部元素，测试看着绿、其实测的是别的元素。 */
function parseCompound(s) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let i = 0;
  const unsupported = (why) => {
    throw new Error('迷你 DOM 不支持选择器片段 ' + why + '：' + JSON.stringify(s) +
      '（只支持 标签 / .类 / #id / [属性] / [属性=值] / [属性^=值]，用空格组合后代）');
  };
  const tm = /^[a-zA-Z][\w-]*/.exec(s);
  if (tm) { out.tag = tm[0].toUpperCase(); i = tm[0].length; }
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      const m = /^\.([\w-]+)/.exec(s.slice(i));
      if (!m) unsupported(c);
      out.classes.push(m[1]); i += m[0].length;
    } else if (c === '#') {
      const m = /^#([\w-]+)/.exec(s.slice(i));
      if (!m) unsupported(c);
      out.id = m[1]; i += m[0].length;
    } else if (c === '[') {
      const m = /^\[([\w-]+)(?:(\^|\$|\*)?=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/.exec(s.slice(i));
      if (!m) unsupported(c);
      out.attrs.push({
        name: m[1], op: m[2] || null,
        value: m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]
      });
      i += m[0].length;
    } else if (c === ':') unsupported(c);
    else i++;
  }
  return out;
}

function parseSelector(sel) {
  return String(sel).trim().split(/\s+/).map(parseCompound);
}

function matchesCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value === undefined) continue;
    const v = String(el.getAttribute(a.name));
    if (a.op === '^') { if (v.indexOf(a.value) !== 0) return false; }
    else if (a.op === '$') { if (!a.value || v.slice(-a.value.length) !== a.value) return false; }
    else if (a.op === '*') { if (v.indexOf(a.value) < 0) return false; }
    else if (v !== a.value) return false;
  }
  return true;
}

/* ============================ 节点 ============================ */

function makeText(text) {
  return { nodeType: 3, _text: String(text), parentNode: null };
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag || '').toUpperCase();
    this._attrs = Object.create(null);
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.files = null;
    this.open = false;
    this._lis = Object.create(null);
    this._classList = mkClassList(this);
    this.style.setProperty = function (k, v) { this[k] = v; };
    this.style.removeProperty = function (k) { delete this[k]; };
  }

  get classList() { return this._classList; }

  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = String(v); }

  get className() { return this._attrs['class'] || ''; }
  set className(v) { this._attrs['class'] = String(v); }

  /* data-* → dataset（驼峰化）。dictation/typing 靠它读词表 id。 */
  get dataset() {
    const o = {};
    for (const k of Object.keys(this._attrs)) {
      if (k.indexOf('data-') !== 0) continue;
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      o[camel] = this._attrs[k];
    }
    return o;
  }

  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.children;
    return s[s.indexOf(this) + 1] || null;
  }

  /* --- 属性 --- */
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === 'style') parseStyle(this.style, String(v));   // 内联 style="display:none" 要能读出来
    /* 表单控件：属性要反映到属性值上（真 DOM 如此）。dictation 内核会读
       input[name=engine].value 与 #setShowHint.checked / #setSkipDone.checked。 */
    if (k === 'value') this.value = String(v);
    if (k === 'checked') this.checked = true;
    if (k === 'disabled') this.disabled = true;
  }
  removeAttribute(k) { delete this._attrs[k]; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); }

  /* --- 树 --- */
  appendChild(c) {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = this.childNodes.indexOf(ref);
    c.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  /* --- 文本 --- */
  get textContent() {
    return this.childNodes.map(n => (n.nodeType === 3 ? n._text : n.textContent)).join('');
  }
  set textContent(v) {
    this.childNodes.length = 0;
    if (v !== '' && v !== null && v !== undefined) this.appendChild(makeText(v));
  }

  /* --- innerHTML --- */
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(v) {
    this.childNodes.length = 0;
    for (const n of parseHTML(String(v), this).slice()) this.appendChild(n);
  }

  /* --- 查询 --- */
  _descendants(out) {
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      out.push(c);
      c._descendants(out);
    }
    return out;
  }
  querySelectorAll(sel) {
    const compounds = parseSelector(sel);
    let ctx = [this];
    for (const c of compounds) {
      const seen = new Set(), next = [];
      for (const root of ctx) {
        for (const d of root._descendants([])) {
          if (seen.has(d)) continue;
          if (matchesCompound(d, c)) { seen.add(d); next.push(d); }
        }
      }
      ctx = next;
    }
    return ctx;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    const compounds = parseSelector(sel);
    const c = compounds[compounds.length - 1];
    let n = this;
    while (n && n.nodeType === 1) { if (matchesCompound(n, c)) return n; n = n.parentNode; }
    return null;
  }
  contains(n) {
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }

  /* --- 事件 --- */
  addEventListener(type, fn) { (this._lis[type] = this._lis[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const a = this._lis[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatchEvent(evt) {
    evt.target = evt.target || this;
    let n = this;
    while (n) {
      const a = n._lis[evt.type] || [];
      for (const fn of a) fn.call(n, evt);
      n = n.parentNode;
    }
    return true;
  }
  fire(type, props) { return this.dispatchEvent(Object.assign({ type, preventDefault() {}, stopPropagation() {} }, props)); }
  click() { this.fire('click'); }
  focus() {} blur() {} select() {} scrollIntoView() {}

  /* --- 对话框桩 --- */
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function mkClassList(el) {
  const read = () => String(el._attrs['class'] || '').split(/\s+/).filter(Boolean);
  const write = (a) => { el._attrs['class'] = a.join(' '); };
  return {
    add(...cs) { const a = read(); for (const c of cs) if (!a.includes(c)) a.push(c); write(a); },
    remove(...cs) { write(read().filter(c => !cs.includes(c))); },
    contains(c) { return read().includes(c); },
    toggle(c, force) {
      const has = read().includes(c);
      const want = force === undefined ? !has : !!force;
      if (want && !has) this.add(c);
      else if (!want && has) this.remove(c);
      return want;
    },
    get length() { return read().length; }
  };
}

/* ============================ HTML 解析 ============================ */

const ATTR_RE = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/* 把 style="display:none; color: red" 写进 el.style（驼峰化属性名） */
function parseStyle(style, text) {
  String(text).split(';').forEach(function (decl) {
    const i = decl.indexOf(':');
    if (i < 0) return;
    const k = decl.slice(0, i).trim();
    const v = decl.slice(i + 1).trim();
    if (!k) return;
    style[k.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = v;
  });
}

function applyAttrs(el, s) {
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) {
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    el.setAttribute(m[1], v);
  }
}

function parseHTML(html, doc) {
  const root = { nodeType: 1, tagName: '#FRAGMENT', _attrs: {}, childNodes: [], classList: { contains: () => false },
    // 刻意不写 parentNode：这样 El.appendChild 的「先摘再挂」分支不会在遍历时改这个数组
    appendChild(c) { this.childNodes.push(c); return c; },
    getAttribute: () => null, hasAttribute: () => false };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0, m;
  while ((m = re.exec(html))) {
    const text = html.slice(last, m.index);
    if (text.trim()) top().appendChild(makeText(text));
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    if (m[0][1] === '/') {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tagName === tag.toUpperCase()) { stack.length = k; break; }
      }
    } else {
      const el = new El(tag);
      applyAttrs(el, m[2]);
      top().appendChild(el);
      const selfClosed = /\/\s*$/.test(m[2]);
      if (!selfClosed && !VOID_TAGS.has(tag)) stack.push(el);
    }
  }
  const tail = html.slice(last);
  if (tail.trim()) top().appendChild(makeText(tail));
  return root.childNodes;
}

function serialize(n) {
  if (n.nodeType === 3) return n._text;
  const attrs = Object.keys(n._attrs).map(k => ` ${k}="${n._attrs[k]}"`).join('');
  const kids = n.childNodes.map(serialize).join('');
  return `<${n.tagName.toLowerCase()}${attrs}>${kids}</${n.tagName.toLowerCase()}>`;
}

/* ============================ 文档与环境 ============================ */

function createElement(tag) { return new El(tag); }

function createDocument() {
  const doc = new El('#document');
  doc.tagName = '#DOCUMENT';
  doc.documentElement = new El('html');
  doc.head = new El('head');
  doc.body = new El('body');
  doc.appendChild(doc.documentElement);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.createElement = createElement;
  doc.readyState = 'complete';
  /* 真 DOM 的 document.title：读写 <title> 元素 */
  Object.defineProperty(doc, 'title', {
    get() {
      const t = doc.documentElement.querySelector('title');
      return t ? String(t.textContent || '') : '';
    },
    set(v) {
      let t = doc.documentElement.querySelector('title');
      if (!t) { t = new El('title'); doc.head.appendChild(t); }
      t.textContent = String(v);
    }
  });
  doc.createElementNS = (_ns, t) => new El(t);
  doc.getElementById = (id) => doc.body.querySelector('#' + id) || doc.documentElement.querySelector('#' + id);
  /* document 上的监听器真记账，测试可以 fire('keydown', {key:'Tab'}) */
  doc._lis = Object.create(null);
  doc.addEventListener = function (type, fn) { (doc._lis[type] = doc._lis[type] || []).push(fn); };
  doc.removeEventListener = function (type, fn) {
    const a = doc._lis[type] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  doc.fire = function (type, props) {
    const evt = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, props);
    (doc._lis[type] || []).slice().forEach((fn) => fn(evt));
    return evt;
  };
  return doc;
}

/** 把一份 HTML 片段装进 body —— 模拟「打开的是一个页面」。 */
function loadHTML(doc, html) {
  for (const n of parseHTML(html, doc).slice()) doc.body.appendChild(n);
  return doc;
}

function makeFile(name, text) {
  return { name: name, _text: String(text), size: String(text).length, type: 'application/json' };
}

/** 造 VM 沙箱：document / localStorage / FileReader / Blob / URL / confirm / location */
function makeSandbox(opts) {
  opts = opts || {};
  const winLis = Object.create(null);
  const doc = createDocument();
  if (opts.html) loadHTML(doc, opts.html);
  const store = new Map();
  const files = {};                                  // 可控的 FileReader 结果
  const sandbox = {
    document: doc,
    location: { pathname: opts.pathname || '/jlpt-library/', href: 'file:///jlpt-library/' + (opts.pathname || ''), hash: '' },
    navigator: { userAgent: 'node', language: 'ja' },
    localStorage: {
      getItem(k) { return store.has(String(k)) ? store.get(String(k)) : null; },
      setItem(k, v) { store.set(String(k), String(v)); },
      removeItem(k) { store.delete(String(k)); },
      clear() { store.clear(); },
      get length() { return store.size; },
      key(i) { return Array.from(store.keys())[i]; }
    },
    sessionStorage: {
      getItem() { return null; }, setItem() {}, removeItem() {}, clear() {}
    },
    FileReader: function () {
      this.result = null; this.onload = null; this.onerror = null;
      this.readAsText = (f) => { this.result = f && f._text !== undefined ? f._text : ''; if (this.onload) this.onload(); };
    },
    Blob: function (parts, o) { this.parts = parts; this.type = (o || {}).type; },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    confirm: () => (opts.confirm === undefined ? true : !!opts.confirm),
    alert: () => {},
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout, setInterval: opts.setInterval || (() => 1), clearInterval: () => {},
    queueMicrotask,
    Audio: function (url) {
      this.src = String(url || '');
      this.onended = null; this.onerror = null;
      this.play = () => Promise.resolve();
      this.pause = () => {};
      this.remove = () => {};
    },
    Promise,
    fetch: opts.fetch || (() => Promise.reject(new Error('sandbox 未提供 fetch'))),
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    speechSynthesis: opts.speechSynthesis || { getVoices: () => [], speak() {}, cancel() {}, addEventListener() {} },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    /* window 上的监听器也真记账（内核把 keydown 挂在 window 上），
       测试用 sb.__winFire('keydown', { key: ' ' }) 触发。 */
    addEventListener: function (type, fn) { (winLis[type] = winLis[type] || []).push(fn); },
    scrollTo: () => {},
    __store: store,
    __files: files,
    __doc: doc
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.__winFire = function (type, props) {
    const evt = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, props);
    (winLis[type] || []).slice().forEach((fn) => fn(evt));
    return evt;
  };
  return sandbox;
}

/** 在沙箱里跑一段脚本源码。 */
function run(sandbox, src, filename) {
  const vm = require('vm');
  if (!sandbox.__ctx) sandbox.__ctx = vm.createContext(sandbox);
  return vm.runInContext(src, sandbox.__ctx, { filename: filename || 'inline.js' });
}

/** 从磁盘读文件并跑起来（用真实物理路径解析相对路径）。 */
function runFile(sandbox, file) {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(file, 'utf8');
  return run(sandbox, src, file);
}

module.exports = { makeSandbox, run, runFile, createDocument, loadHTML, makeFile, parseHTML, El };
