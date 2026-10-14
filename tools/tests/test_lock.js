/* 验证 exam-lock.js 的两个关键行为：
     A. 页面加载时**不上锁**（口令推迟到真正要读题时才问）
     B. prompt() 按需弹出的口令框能正确拒绝错口令、接受对口令，并还原出与明文
        逐字节一致的 JSON

   思路：用最小 DOM 桩把 exam-lock.js 跑起来 → 调 prompt() 模拟点「开始练习」
   → 模拟输入口令、点「解锁」→ 调 EXAM_LOCK.load() 取回数据 → 与明文文件比对。

   关键点：exam-lock.js 用的是 WebCrypto + DecompressionStream，Node 22 都有，
   所以这里跑的就是真实浏览器代码路径，而不是另写一份等价逻辑。

   用法：node test_lock.js <口令> */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");
const EXAM = path.join(ROOT, "exam");
const DATA = path.join(EXAM, "data", "N2");

const PASS = process.argv[2];
if (!PASS) {
  console.error("需要给出当前口令：node test_lock.js <口令>");
  process.exit(1);
}
const WRONG = "definitely-not-the-password";

/* ---------- 最小 DOM 桩 ---------- */
// 所有元素共用一张 id 表：exam-lock.js 里的 overlay.querySelector("#lk-pass")
// 与测试里拿 #lk-pass 必须是同一个实例，否则事件绑了也点不到。
const idMap = {};
function makeEl(tag) {
  const el = {
    tagName: tag, _html: "", textContent: "", value: "", checked: true,
    disabled: false, src: "", id: "", dataset: {}, children: [], _lis: {},
    parentNode: null,
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener(type, fn) { (this._lis[type] = this._lis[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (this._lis[type]) this._lis[type] = this._lis[type].filter(f => f !== fn);
    },
    fire(type, ev) { (this._lis[type] || []).slice().forEach(fn => fn(ev || {})); },
    querySelector(sel) { return (idMap[sel] = idMap[sel] || makeEl("el")); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; this.children = this.children.filter(x => x !== c); return c; },
    insertAdjacentHTML() {},
    setAttribute(k, v) { this["_attr_" + k] = v; },
    removeAttribute(k) { delete this["_attr_" + k]; },
    hasAttribute(k) { return this["_attr_" + k] !== undefined; },
    focus() {}, select() {}, click() { this.fire("click"); }
  };
  return el;
}

function makeHarness() {
  const sandbox = {};
  const ctx = vm.createContext(sandbox);

  const htmlEl = makeEl("html");
  const head = makeEl("head");
  const body = makeEl("body");

  head.appendChild = (s) => {
    const rel = String(s.src || "");
    if (!rel) return s;
    const file = path.join(EXAM, rel);
    if (!fs.existsSync(file)) { sandbox.__loadErrors.push(rel); return s; }
    const code = fs.readFileSync(file, "utf8");
    vm.runInContext(code, ctx, { filename: rel });
    if (typeof s.onload === "function") setTimeout(() => s.onload(), 0);
    return s;
  };

  const document = {
    readyState: "complete",
    documentElement: htmlEl,
    head, body,
    createElement: makeEl,
    _lis: {},
    addEventListener(type, fn) { (this._lis[type] = this._lis[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (this._lis[type]) this._lis[type] = this._lis[type].filter(f => f !== fn);
    },
    fire(type, ev) { (this._lis[type] || []).slice().forEach(fn => fn(ev || {})); },
    getElementById: (id) => idMap["#" + id] || null
  };

  sandbox.__loadErrors = [];
  sandbox.window = sandbox;
  sandbox.document = document;
  sandbox.console = console;
  sandbox.crypto = globalThis.crypto;
  sandbox.atob = globalThis.atob;
  sandbox.btoa = globalThis.btoa;
  sandbox.Blob = globalThis.Blob;
  sandbox.Response = globalThis.Response;
  sandbox.DecompressionStream = globalThis.DecompressionStream;
  sandbox.TextEncoder = globalThis.TextEncoder;
  sandbox.TextDecoder = globalThis.TextDecoder;
  sandbox.setTimeout = setTimeout;
  sandbox.queueMicrotask = queueMicrotask;
  const store = {};
  sandbox.sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };

  vm.runInContext(fs.readFileSync(path.join(EXAM, "exam-lock.js"), "utf8"), ctx,
    { filename: "exam-lock.js" });

  return { sandbox, ctx, document, ids: idMap, htmlEl, store, body };
}

const tick = () => new Promise(r => setTimeout(r, 20));
// PBKDF2 600k 次迭代要几百毫秒，不能按固定时长等——改成轮询条件。
async function waitUntil(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 30));
  }
  return false;
}
let passCount = 0, failCount = 0;
function check(ok, label, extra) {
  if (ok) { passCount++; console.log("  ✓ " + label); }
  else { failCount++; console.log("  ✗ " + label + (extra ? "  → " + extra : "")); }
}

function plainJson(file) {
  const src = fs.readFileSync(path.join(DATA, file), "utf8");
  let j = src.slice(src.indexOf("=") + 1).trim();
  if (j.endsWith(";")) j = j.slice(0, -1);
  return j;
}
// 明文 JSON 里键值之间有空格，不能拿字符串直接比；比对象，且 JSON.stringify
// 会保留键顺序，所以这仍然是一次严格的等价判定。
function plainObj(file) { return JSON.parse(plainJson(file)); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 给 promise 挂一个「已结算」探针，用来断言 prompt() 在输对之前不该 resolve
function track(p) {
  const t = { state: "pending" };
  p.then(() => { t.state = "resolved"; }, (e) => { t.state = "rejected"; t.err = e; });
  return t;
}

(async function main() {
  console.log("=== 1. 页面加载时不上锁（口令推迟到点按钮时才问） ===");
  const H = makeHarness();
  await tick();
  const LOCK = H.sandbox.EXAM_LOCK;
  check(!!LOCK, "exam-lock.js 加载并导出 EXAM_LOCK");
  check(LOCK.isUnlocked() === false, "启动后仍未解锁");
  check(!H.htmlEl.hasAttribute("data-exam-locked"), "html 不再带 data-exam-locked");
  check(H.body.children.length === 0, "启动不往 body 塞任何东西（没有遮罩）");
  check(await waitUntil(() => H.sandbox.EXAM_ENC_META && !!H.sandbox.EXAM_ENC_META.wrap),
    "meta.js 已在后台静默加载（含口令包裹信息）");
  check(!H.ids["#lk-pass"], "此时口令输入框还不存在");

  console.log("\n=== 2. prompt() 才弹出口令框 ===");
  const t1 = track(LOCK.prompt());
  const shown = await waitUntil(() => !!H.ids["#lk-pass"]);
  check(shown, "调用后模态出现");
  check(H.body.children.length === 1, "body 里多了一个模态根节点", String(H.body.children.length));
  const modalRoot = H.body.children[0];
  check(modalRoot["_attr_role"] === "dialog", "模态带 role=dialog", String(modalRoot["_attr_role"]));
  const input = H.ids["#lk-pass"], btn = H.ids["#lk-go"], err = H.ids["#lk-err"];
  check(!!input && !!btn && !!err, "控件齐备（输入框 / 解锁 / 错误行）");
  check(!!H.ids["#lk-cancel"], "有取消按钮");
  // 文案锁死：只剩版权声明，不要再堆实现细节和口令遗失说明
  check(/因版权限制，本资料仅提供个人使用。如需获取，请联系作者。/.test(modalRoot.innerHTML),
    "说明文案就是版权声明");
  check(!/AES|本机内存|找回通道/.test(modalRoot.innerHTML),
    "不再出现加密算法、口令不出本机、口令遗失之类的冗长说明");
  check((modalRoot.innerHTML.match(/<button/g) || []).length === 2,
    "只有「解锁」「取消」两个按钮",
    String((modalRoot.innerHTML.match(/<button/g) || []).length));
  check(t1.state === "pending", "输对之前 prompt() 不结算");

  console.log("\n=== 3. 空口令应提示而不是当错口令 ===");
  input.value = "";
  btn.fire("click");
  await tick();
  check(err.textContent === "请输入口令。", "空口令提示「请输入口令。」", JSON.stringify(err.textContent));
  check(t1.state === "pending", "空口令后 prompt() 仍 pending");

  console.log("\n=== 4. 取消应 reject(cancelled) 并关掉模态 ===");
  H.ids["#lk-cancel"].fire("click");
  await waitUntil(() => t1.state !== "pending");
  check(t1.state === "rejected" && t1.err && t1.err.cancelled === true,
    "取消 → reject 且 err.cancelled === true", t1.state + "/" + (t1.err && t1.err.message));
  check(H.body.children.length === 0, "取消后模态已移除");
  check(LOCK.isUnlocked() === false, "取消后仍然未解锁");
  check(!H.store["jlpt-exam-dek"], "取消不会把密钥写进 sessionStorage");

  console.log("\n=== 5. 点遮罩空白处也等于取消 ===");
  const t2 = track(LOCK.prompt());
  await waitUntil(() => !!H.ids["#lk-pass"]);
  const scrim = H.body.children[0];
  scrim.fire("click", { target: scrim });
  await waitUntil(() => t2.state !== "pending");
  check(t2.state === "rejected" && t2.err && t2.err.cancelled === true, "点遮罩 → cancelled");

  console.log("\n=== 6. Esc 也等于取消 ===");
  const t3 = track(LOCK.prompt());
  await waitUntil(() => !!H.ids["#lk-pass"]);
  H.document.fire("keydown", { key: "Escape" });
  await waitUntil(() => t3.state !== "pending");
  check(t3.state === "rejected" && t3.err && t3.err.cancelled === true, "Esc → cancelled");
  check(H.body.children.length === 0, "Esc 后模态已移除");

  console.log("\n=== 7. 错误口令应被拒绝 ===");
  const t4 = track(LOCK.prompt());
  await waitUntil(() => !!H.ids["#lk-pass"]);
  const errEl = H.ids["#lk-err"];
  errEl.textContent = "";        // 桩里控件是单例，清掉上一段的残留提示
  input.value = WRONG;
  btn.fire("click");
  const showedErr = await waitUntil(() => errEl.textContent === "口令错误。");
  check(showedErr, "错误口令显示「口令错误。」", JSON.stringify(errEl.textContent));
  check(t4.state === "pending", "错误口令后 prompt() 仍 pending（可以重输）");
  check(H.body.children.length === 1, "模态仍然开着，让人重输");
  check(!H.store["jlpt-exam-dek"], "错误口令不会把密钥写进 sessionStorage");

  console.log("\n=== 8. 正确口令应解锁（并在同一个 promise 上 resolve） ===");
  input.value = PASS;
  btn.fire("click");   // 这次走点击
  const ok = await waitUntil(() => t4.state !== "pending");
  check(ok && t4.state === "resolved", "prompt() 在超时内 resolve", t4.state);
  check(LOCK.isUnlocked() === true, "EXAM_LOCK.isUnlocked() === true");
  check(H.body.children.length === 0, "解锁后模态已移除");
  check(!!H.store["jlpt-exam-dek"], "勾选后密钥写入本标签页 sessionStorage");

  console.log("\n=== 9. 已解锁后再 prompt() 应秒过且不再弹窗 ===");
  let resolvedFast = false;
  LOCK.prompt().then(() => { resolvedFast = true; });
  await tick();
  check(resolvedFast, "立刻 resolve");
  check(H.body.children.length === 0, "不再弹出模态");

  console.log("\n=== 10. 逐卷解密结果与明文一致 ===");
  const vols = fs.readdirSync(DATA).filter(f => /^\d{4}-\d{2}\.js$/.test(f)).map(f => f.slice(0, -3)).sort();
  const bad = [];
  for (const v of vols) {
    const got = await LOCK.load("data/N2/enc/" + v + ".js", "EXAM_ENC_" + v.replace(/-/g, "_"), v);
    if (!same(got, plainObj(v + ".js"))) bad.push(v);
    await tick();
  }
  check(bad.length === 0, vols.length + " 卷全部与明文等价", bad.join("、"));

  console.log("\n=== 11. 密文互换/错配应被 AAD 拒绝 ===");
  let rejected = false;
  try {
    // 故意用 2011-07 的密文冒充 2011-12（AAD 不匹配，GCM 认证必须失败）
    await LOCK.load("data/N2/enc/2011-07.js", "EXAM_ENC_2011_07", "2011-12");
  } catch (e) { rejected = true; }
  check(rejected, "卷名与密文不匹配时解密失败（AAD 生效）");

  console.log("\n=== 12. lock() 之后要重新输口令 ===");
  LOCK.lock();
  check(LOCK.isUnlocked() === false, "lock() 后回到未解锁");
  check(!H.store["jlpt-exam-dek"], "lock() 清掉了 sessionStorage 里的密钥");
  const t5 = track(LOCK.prompt());
  await waitUntil(() => !!H.ids["#lk-pass"]);
  check(H.body.children.length === 1, "lock() 后再 prompt() 会重新弹窗");
  input.value = PASS;
  input.fire("keydown", { key: "Enter" });      // 这次走回车
  await waitUntil(() => t5.state !== "pending");
  check(t5.state === "resolved", "回车也能提交并解锁", t5.state);

  console.log("\n=== 13. 没有加载失败 ===");
  check(H.sandbox.__loadErrors.length === 0, "没有出现加载失败",
    H.sandbox.__loadErrors.join("、"));

  console.log("\n" + (failCount ? "✗ 失败 " + failCount + " 项，通过 " + passCount + " 项" : "✓ 全部通过（" + passCount + " 项）"));
  process.exitCode = failCount ? 1 : 0;
})();
