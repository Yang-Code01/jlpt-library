/* 最小 DOM 桩：让 exam/*.js 能在 node 里跑起来做端到端验证。
   要点：
   1) 默认预置本地 DEK 进 sessionStorage，让 exam-lock.js 走它自己的「本标签页
      已解锁」分支静默解锁（不弹口令框）；传 makeHarness(dir, {dek:null}) 则
      模拟「这个标签页还没输过口令」，用来验证口令框是不是真的在点按钮后才弹。
   2) head.appendChild 拦截 <script>：enc/<卷>.js 与 enc/meta.js 按真实物理路径读盘
      注入，明文 data/N2/index-lite.js 也在这里记账 —— loaded 里记逻辑路径
      （data/N2/<卷>.js、data/N2/index-lite.js），保持原有断言语义不变
   3) querySelectorAll 按选择器缓存，保证源码绑的 onclick 与测试拿到的是同一批对象
   4) 元素支持 addEventListener/fire，测试才能模拟「输入口令 → 点解锁」
   5) main/side 是固定单例；其内部带 id 的元素注册进 registry，供 getElementById 命中
   6) sandbox 必须补 scrollTo / matchMedia / localStorage / sessionStorage
      以及 crypto / atob / btoa / Blob / Response / DecompressionStream（解密要用） */
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function makeHarness(baseDir, opts) {
  opts = opts || {};
  const noDek = opts.dek === null;   // 显式传 null = 本标签页还没输过口令
  const registry = {};
  const cache = {};
  const loaded = [];   // 依序记录被注入的脚本，用来验证「首屏没加载任何卷」「只加载命中卷」

  function mkEl(id, dset) {
    const el = {
      id: id || "", dataset: dset || {},
      value: "", checked: true, textContent: "", disabled: false,
      _attrs: "", _cache: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {}, getAttribute() { return null; },
      removeAttribute() {}, hasAttribute() { return false; },
      appendChild(c) { if (c) c.parentNode = this; return c; },
      removeChild(c) { if (c) c.parentNode = null; return c; },
      // 记下追加的 HTML 片段：页面的失败提示都走 insertAdjacentHTML，
      // 不记账就断言不到（innerHTML 是重新赋值的，掺进去会打乱解析缓存）
      insertAdjacentHTML(pos, html) { this._adj = (this._adj || "") + String(html); },
      _lis: {},
      addEventListener(type, fn) { (this._lis[type] = this._lis[type] || []).push(fn); },
      fire(type, ev) { (this._lis[type] || []).forEach(fn => fn(ev || {})); },
      focus() {}, select() {},
      // exam-lock.js 用 overlay.querySelector("#lk-pass") 取模态控件。
      // 真实 DOM 里 querySelector("#x") 与 getElementById("x") 是同一个元素，
      // 这里也对齐：innerHTML 解析时登记过的 #x 优先复用，避免「绑事件的」和
      // 「测试拿到的」是两个不同实例。
      _q: {},
      querySelector(sel) {
        if (!this._q[sel]) {
          const byId = sel.charAt(0) === "#" ? registry[sel.slice(1)] : null;
          this._q[sel] = byId || mkEl("");
          registry[sel] = this._q[sel];
        }
        return this._q[sel];
      },
      querySelectorAll(sel) {
        if (this._cache[sel]) return this._cache[sel];
        const out = [];
        const re = /<(button|div|a|input)\b([^>]*)>/g;
        let m;
        while ((m = re.exec(this._html))) {
          const attrs = m[2];
          const d = {};
          for (const am of attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
            d[am[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = am[2];
          }
          const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || "";
          const idm = (attrs.match(/id="([^"]*)"/) || [])[1] || "";
          const val = (attrs.match(/value="([^"]*)"/) || [])[1];
          const key = sel.startsWith(".") ? null : sel.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          const ok = sel.startsWith(".") ? cls.split(/\s+/).includes(sel.slice(1))
            : sel.startsWith("#") ? idm === sel.slice(1)
            : sel.startsWith("[data-") ? d[key] !== undefined : false;
          if (ok) { const e = mkEl(idm, d); e._attrs = attrs; if (val !== undefined) e.value = val; out.push(e); }
        }
        this._cache[sel] = out;
        return out;
      },
      onclick: null, oninput: null
    };
    // innerHTML：写入后清缓存、并把内部 id 元素登记到 registry
    let html = "";
    Object.defineProperty(el, "innerHTML", {
      get() { return html; },
      set(v) {
        html = String(v);
        el._html = html;        // querySelectorAll 读的是 _html
        el._cache = {};
        // 注意带上 p：口令框的错误提示行是 <p id="lk-err">，
        // 漏了它就会变成「绑事件的元素」与「测试取到的元素」是两个实例。
        const re = /<(button|div|a|input|audio|p)\b([^>]*?)>/g;
        let m;
        while ((m = re.exec(html))) {
          const idm = (m[2].match(/id="([^"]*)"/) || [])[1];
          if (idm) registry[idm] = mkEl(idm);
        }
      }
    });
    el._html = html;
    if (id) registry[id] = el;
    return el;
  }

  // 题库已改为密文（data/N2/enc/<卷>.js）；题型索引反过来是明文常驻
  // （data/N2/index-lite.js）。桩按「真实物理路径读盘、逻辑路径记账」处理：
  // loaded 里记的仍是 data/N2/<卷>.js，这样原有「首屏没加载任何卷」「只加载
  // 命中卷」的断言语义完全不变。meta.js 不记账（它不是题库数据）。
  const ENC = baseDir + "/data/N2/enc/";
  const headAppend = (el) => {
    const src = el.src || "";
    let physical = null, logical = null;
    const mv = src.match(/enc\/(\d{4}-\d{2})\.js$/);
    if (mv) { physical = ENC + mv[1] + ".js"; logical = "data/N2/" + mv[1] + ".js"; }
    else if (/enc\/meta\.js$/.test(src)) { physical = ENC + "meta.js"; }
    else if (/data\/N2\/index-lite\.js$/.test(src)) {
      physical = baseDir + "/data/N2/index-lite.js"; logical = "data/N2/index-lite.js";
    }
    if (physical) {
      if (logical) loaded.push(logical);
      vm.runInContext(fs.readFileSync(physical, "utf8"), sandbox, { filename: physical });
    }
    if (el.onload) el.onload();
  };
  const doc = {
    head: { appendChild: headAppend, insertAdjacentHTML() {} },
    body: mkEl(""),
    documentElement: mkEl(""),
    createElement(t) { const e = mkEl(""); if (t === "script") e.src = ""; return e; },
    querySelectorAll() { return []; },
    getElementById(id) { if (!registry[id]) registry[id] = mkEl(id); return registry[id]; },
    addEventListener() {}, removeEventListener() {}
  };
  const sandbox = {
    window: {}, document: doc,
    matchMedia: () => ({ matches: false }),
    // 真实的内存 localStorage（早期版本 getItem 恒返回 null、setItem 空实现，
    // 导致「记录迁移」这类逻辑根本测不到）
    localStorage: (() => {
      const m = new Map();
      return {
        getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
        setItem(k, v) { m.set(String(k), String(v)); },
        removeItem(k) { m.delete(String(k)); },
        clear() { m.clear(); }
      };
    })(),
    // 题库是密文，取数需要密钥。默认把本地保底的 DEK 预置进 sessionStorage，
    // 让 exam-lock.js 走它自己的「本标签页已解锁」分支自动解锁：测试里不用写口令，
    // 但跑的确实是真实的 exam-lock.js，而不是另写一份解密逻辑。
    // 传 {dek:null} 则不预置 —— 用来验证「没解锁时按钮点了才弹口令框」。
    sessionStorage: (() => {
      const m = new Map();
      if (!noDek) {
        /* 密钥从仓库根算起，与 tools/encrypt-exam.mjs 的 DEK_FILE 同一位置 ——
           .scratch/ 不入库，克隆者要先跑 node tools/encrypt-exam.mjs gen-key。
           EXAM_DEK_FILE 可覆盖。 */
        const dekFile = process.env.EXAM_DEK_FILE ||
          path.join(__dirname, "..", "..", ".scratch", "jlpt-exam", "enc-keys", "dek.b64");
        if (!fs.existsSync(dekFile)) {
          throw new Error("缺少本地密钥文件，请先运行 tools/encrypt-exam.mjs gen-key\n  " + dekFile);
        }
        m.set("jlpt-exam-dek", fs.readFileSync(dekFile, "utf8").trim());
      }
      return {
        getItem(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
        setItem(k, v) { m.set(String(k), String(v)); },
        removeItem(k) { m.delete(String(k)); }
      };
    })(),
    crypto: globalThis.crypto, atob: globalThis.atob, btoa: globalThis.btoa,
    Blob: globalThis.Blob, Response: globalThis.Response,
    DecompressionStream: globalThis.DecompressionStream,
    TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
    queueMicrotask: globalThis.queueMicrotask,
    setInterval() { return 1; }, clearInterval() {},
    setTimeout, console, scrollTo() {},
    // 伪 history：能压栈、能 back()（back 会触发 popstate，模拟浏览器返回键）
    history: (() => {
      const stack = [];
      const popListeners = [];
      return {
        get length() { return Math.max(stack.length, 1); },
        replaceState(s) { stack.length = 0; stack.push(s); },
        pushState(s) { stack.push(s); },
        back() { if (stack.length > 1) { stack.pop(); popListeners.forEach(f => f({ state: stack[stack.length - 1] })); } },
        _on(f) { popListeners.push(f); },
        _depth() { return stack.length; }
      };
    })(),
    addEventListener(type, fn) { if (type === "popstate") sandbox.history._on(fn); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // 先装解锁层，再装核心：exam-core 的 loadExam/loadIndex 会通过 window.EXAM_LOCK 取数。
  vm.runInContext(fs.readFileSync(baseDir + "/exam-lock.js", "utf8"), sandbox, { filename: "exam-lock.js" });
  vm.runInContext(fs.readFileSync(baseDir + "/exam-core.js", "utf8") + "\nthis.EXAM=EXAM;", sandbox, { filename: "exam-core.js" });

  return {
    sandbox,
    loaded,
    check,
    run(file) { vm.runInContext(fs.readFileSync(baseDir + "/" + file, "utf8"), sandbox, { filename: file }); },
    get main() { return registry.main; },
    get side() { return registry.side; },
    el(id) { return registry[id]; }
  };
}
/* 断言：打印 ✓/✗，失败计入退出码。
   真题侧几个套件原来是「只打印布尔值」的冒烟 —— 回归根本抓不到（退出码永远是 0），
   统一走这里，见 CODING_STANDARDS.md「检查必须能失败」。 */
const tally = { pass: 0, fail: [] };
function check(name, cond, extra) {
  if (cond) { tally.pass++; console.log('  ✓ ' + name); }
  else { tally.fail.push(name + (extra ? '  ::  ' + extra : '')); console.log('  ✗ ' + name + (extra ? '  ::  ' + extra : '')); }
}
process.on('exit', () => {
  if (!tally.pass && !tally.fail.length) return;
  console.log(`\nRESULT: ${tally.fail.length ? 'FAIL' : 'ALL PASS'}（共 ${tally.pass + tally.fail.length} 项断言）`);
  if (tally.fail.length) { for (const f of tally.fail) console.log('  ✗ ' + f); process.exitCode = 1; }
});

module.exports = { makeHarness };
