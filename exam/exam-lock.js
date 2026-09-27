/* ============================================================
   真题模块解锁层（exam-lock.js）
   ============================================================
   题目数据以密文形式存放（exam/data/N2/enc/*.js），本文件负责：
     1. 被调用时弹出口令模态（不是页面一进来就锁）
     2. 收口令 → PBKDF2 派生 KEK → 解包 DEK（解不开 = 口令错）
     3. 解密时用 HKDF(DEK, 卷名) 得到分卷密钥，AES-256-GCM 解密 + 解压
     4. 解出来的对象与原先的 window.EXAM_<卷> 完全同形，上层代码无需知道加密存在

   为什么不再入口即锁：题型专练的选题屏、真实考试的选卷屏都只需要「目录」信息
   （有哪些卷、有哪些题型、各多少题），不涉及题目正文。所以口令推迟到真正
   要读题的时刻——点「开始练习」/「开始考试」——才要，能少一道无谓的门。

   口令永不离开本机：没有网络请求、没有 cookie、没有服务端。
   密钥只活在内存闭包 + （可选）本标签页的 sessionStorage 里。

   对外接口：
     EXAM_LOCK.prompt()                 → Promise，解锁后 resolve；
                                          用户取消则 reject(err.cancelled === true)
     EXAM_LOCK.load(url, 全局名, AAD名)  → Promise<数据对象>（内部自动先 prompt）
     EXAM_LOCK.isUnlocked()             → boolean
     EXAM_LOCK.lock()                   清除内存密钥与 sessionStorage，下次重新要口令
     EXAM_LOCK.ready                    Promise，首次解锁后 resolve
   ============================================================ */
(function () {
  "use strict";

  const META_URL = "data/N2/enc/meta.js";
  const HKDF_SALT = new TextEncoder().encode("jlpt-exam-hkdf-v1");
  const INFO_PREFIX = "jlpt-exam-v1:";
  const WRAP_AAD = new TextEncoder().encode("jlpt-exam-dek-v1");
  const IV_LEN = 12;
  const SS_KEY = "jlpt-exam-dek";   // sessionStorage：仅本标签页，关掉即失效

  let meta = null;          // meta.js 解出的公开参数（盐、KDF 次数、被包裹的 DEK）
  let metaPromise = null;   // 只加载一次
  let dekKey = null;        // 非导出的 HKDF CryptoKey
  let unlocked = false;
  let modal = null;         // 当前模态根节点
  let pending = null;       // 正在等待的 prompt()：{ promise, resolve, reject }
  let keyHandler = null;    // Esc 监听，关闭时要摘掉
  let savedOverflow = "";   // 模态期间锁背景滚动，关闭时还原
  let readyResolve;
  const ready = new Promise((res) => { readyResolve = res; });

  /* ---------- 小工具 ---------- */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function injectScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("无法加载 " + url));
      document.head.appendChild(s);
    });
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("当前浏览器不支持解压，请用 Chrome 103+ / Firefox 113+ / Safari 16.4+ 打开");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function focusEl(el) { try { el.focus(); } catch (_) {} }
  function selectEl(el) { try { el.select(); } catch (_) {} }
  function cancelledError() {
    const e = new Error("已取消输入口令");
    e.cancelled = true;
    return e;
  }

  /* ---------- 密钥 ---------- */
  async function deriveKek(passphrase) {
    const base = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: b64ToBytes(meta.salt), iterations: meta.iter, hash: "SHA-256" },
      base, 256);
  }
  // 口令错时 GCM 认证标签不匹配，这里直接抛错 —— 不需要额外的校验位，
  // 也就没有可以离线试探的捷径。
  async function unwrapDek(passphrase) {
    const kekBits = await deriveKek(passphrase);
    const kek = await crypto.subtle.importKey("raw", kekBits, { name: "AES-GCM" }, false, ["decrypt"]);
    const wrapped = b64ToBytes(meta.wrap.ct);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(meta.wrap.iv), additionalData: WRAP_AAD, tagLength: 128 },
      kek, wrapped);
    return new Uint8Array(plain);
  }
  async function decryptVolume(aadName, b64) {
    const buf = b64ToBytes(b64);
    const iv = buf.subarray(0, IV_LEN);
    const ctAndTag = buf.subarray(IV_LEN);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT,
        info: new TextEncoder().encode(INFO_PREFIX + aadName) },
      dekKey, 256);
    const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
    const deflated = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv, additionalData: new TextEncoder().encode(aadName), tagLength: 128 },
      key, ctAndTag);
    const json = new TextDecoder().decode(await inflateRaw(new Uint8Array(deflated)));
    return JSON.parse(json);
  }

  /* ---------- 样式 ---------- */
  const STYLE = [
    '#exam-lock{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;',
    'padding:24px;background:rgba(12,16,20,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);',
    'font-family:var(--font-sans,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif)}',
    '#exam-lock .lk-card{width:100%;max-width:402px;background:var(--surface,#fbfcfc);color:var(--ink,#17202a);',
    'border:1px solid var(--border,#d8dde2);border-radius:var(--radius,14px);padding:28px 26px 24px;',
    'box-shadow:0 18px 48px rgba(10,14,18,.28)}',
    '#exam-lock .lk-eyebrow{font-size:11px;letter-spacing:.14em;color:var(--muted,#5a6672);margin:0 0 8px}',
    '#exam-lock h2{font-size:19px;font-weight:600;letter-spacing:.01em;margin:0 0 10px}',
    '#exam-lock .lk-note{font-size:13px;line-height:1.7;color:var(--muted,#5a6672);margin:0 0 18px}',
    '#exam-lock .lk-row{display:flex;gap:8px}',
    '#exam-lock input[type=password]{flex:1;min-width:0;font:inherit;font-size:14px;padding:11px 13px;',
    'background:var(--surface-2,#f2f4f5);border:1px solid var(--border,#d8dde2);',
    'border-radius:var(--radius-sm,10px);color:var(--ink,#17202a);outline:none}',
    '#exam-lock input[type=password]:focus{border-color:var(--accent,#c3422a)}',
    '#exam-lock #lk-go{font:inherit;font-size:14px;font-weight:600;padding:11px 20px;cursor:pointer;',
    'background:var(--accent,#c3422a);color:var(--on-accent,#fff);border:none;',
    'border-radius:var(--radius-sm,10px);white-space:nowrap}',
    '#exam-lock #lk-go:disabled{opacity:.55;cursor:default}',
    '#exam-lock .lk-remember{display:flex;align-items:center;gap:7px;font-size:12.5px;',
    'color:var(--muted,#5a6672);margin:12px 0 0;cursor:pointer}',
    '#exam-lock .lk-remember input{margin:0;accent-color:var(--accent,#c3422a)}',
    '#exam-lock .lk-err{font-size:13px;color:var(--red,#a33b3b);min-height:20px;margin:10px 0 0}',
    /* 底部只剩「取消」一个按钮，改为右对齐（原来左边还有一行口令遗失的说明） */
    '#exam-lock .lk-foot{display:flex;align-items:flex-end;justify-content:flex-end;gap:14px;',
    'margin:14px 0 0;padding-top:14px;',
    'border-top:1px solid var(--border-soft,#e4e8ec)}',
    '#exam-lock .lk-cancel{font:inherit;font-size:12.5px;font-weight:400;background:none;border:none;',
    'color:var(--muted,#5a6672);padding:2px;cursor:pointer;flex:none;',
    'text-decoration:underline;text-underline-offset:3px;white-space:nowrap}',
    '#exam-lock .lk-cancel:hover{color:var(--ink,#17202a)}'
  ].join("");

  /* ---------- 背景滚动 ---------- */
  function bodyLock(on) {
    const b = document.body;
    if (!b || !b.style) return;
    if (on) { savedOverflow = b.style.overflow || ""; b.style.overflow = "hidden"; }
    else { b.style.overflow = savedOverflow; }
  }

  /* ---------- 模态 ---------- */
  function buildModal() {
    const root = document.createElement("div");
    root.id = "exam-lock";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "lk-title");
    root.innerHTML =
      '<div class="lk-card">' +
        '<p class="lk-eyebrow">JLPT 真题练习</p>' +
        '<h2 id="lk-title">请输入口令</h2>' +
        '<p class="lk-note">因版权限制，本资料仅提供个人使用。如需获取，请联系作者。</p>' +
        '<div class="lk-row">' +
          '<input id="lk-pass" type="password" autocomplete="current-password" spellcheck="false" placeholder="输入口令">' +
          '<button id="lk-go" type="button">解锁</button>' +
        '</div>' +
        '<label class="lk-remember"><input type="checkbox" id="lk-remember" checked>' +
        '本标签页内免重复输入（关闭标签页即失效）</label>' +
        '<p class="lk-err" id="lk-err"></p>' +
        '<div class="lk-foot">' +
          '<button class="lk-cancel" id="lk-cancel" type="button">取消</button>' +
        '</div>' +
      "</div>";
    document.body.appendChild(root);
    return root;
  }

  function closeModal() {
    if (keyHandler) {
      try { document.removeEventListener("keydown", keyHandler); } catch (_) {}
      keyHandler = null;
    }
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    modal = null;
    bodyLock(false);
  }

  // 收尾一次 prompt()：清 pending、关模态、按结果 resolve / reject
  function settle(p, err) {
    if (pending === p) pending = null;
    closeModal();
    if (err) p.reject(err); else p.resolve();
  }

  function openModal(p) {
    if (modal) return;                 // 同一时刻只可能有一个模态
    modal = buildModal();
    const root = modal;

    const input = root.querySelector("#lk-pass");
    const btn = root.querySelector("#lk-go");
    const err = root.querySelector("#lk-err");
    const remember = root.querySelector("#lk-remember");
    const cancel = root.querySelector("#lk-cancel");

    let done = false;
    function setErr(msg) { err.textContent = msg || ""; }
    function setBusy(busy) {
      btn.disabled = busy;
      input.disabled = busy;
      btn.textContent = busy ? "解锁中…" : "解锁";
    }
    function close(errObj) {
      if (done) return;
      done = true;
      settle(p, errObj || null);
    }

    function submit() {
      if (done) return;
      const pass = input.value;
      if (!pass) { setErr("请输入口令。"); focusEl(input); return; }
      setErr(""); setBusy(true);
      unwrapDek(pass)
        .then((dek) => installDek(dek, !!remember.checked))
        .then(() => close(null))
        .catch(() => {
          if (done) return;
          setErr("口令错误。");
          setBusy(false);
          if (input.select) selectEl(input); else focusEl(input);
        });
    }

    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e && e.key === "Enter") submit(); });
    cancel.addEventListener("click", () => close(cancelledError()));
    // 点遮罩空白处也算取消（点卡片内部不算）
    root.addEventListener("click", (e) => { if (e && e.target === root) close(cancelledError()); });
    keyHandler = (e) => { if (e && e.key === "Escape") close(cancelledError()); };
    try { document.addEventListener("keydown", keyHandler); } catch (_) {}

    bodyLock(true);
    setBusy(false);
    focusEl(input);
  }

  /* ---------- meta / 解锁 ---------- */
  function loadMeta() {
    if (metaPromise) return metaPromise;
    metaPromise = injectScript(META_URL).then(() => {
      const m = window.EXAM_ENC_META;
      if (!m || !m.wrap) throw new Error("meta.js 里没有口令包裹信息");
      meta = m;
      return m;
    });
    return metaPromise;
  }

  async function installDek(dekBytes, remember) {
    dekKey = await crypto.subtle.importKey("raw", dekBytes, "HKDF", false, ["deriveBits"]);
    if (remember) { try { sessionStorage.setItem(SS_KEY, bytesToB64(dekBytes)); } catch (_) {} }
    unlocked = true;
    readyResolve();
  }

  /* ---------- 对外接口 ---------- */
  // 需要口令时调它。已解锁则立刻 resolve；已有一次询问在进行则复用同一个 Promise。
  function prompt() {
    if (unlocked) return Promise.resolve();
    if (pending) return pending.promise;

    const p = {};
    p.promise = new Promise((resolve, reject) => { p.resolve = resolve; p.reject = reject; });
    pending = p;

    loadMeta()
      .then(() => {
        if (pending !== p) return;              // 期间已被别处结束
        if (unlocked) { pending = null; p.resolve(); return; }
        openModal(p);
      })
      .catch((e) => {
        if (pending !== p) return;
        pending = null;
        p.reject(new Error("无法加载加密参数：" + ((e && e.message) || e)));
      });

    return p.promise;
  }

  // 取数据：调用方忘了先 prompt() 也不会读到空数据，这里兜一道底。
  async function load(url, globalName, aadName) {
    await prompt();
    await injectScript(url);
    const b64 = window[globalName];
    if (typeof b64 !== "string") throw new Error("密文格式异常：" + globalName);
    try { delete window[globalName]; } catch (_) {}
    return decryptVolume(aadName, b64);
  }

  function lock() {
    dekKey = null;
    unlocked = false;
    try { sessionStorage.removeItem(SS_KEY); } catch (_) {}
  }

  /* ---------- 启动：不上锁、不动 DOM，只把密钥状态准备好 ---------- */
  document.head.insertAdjacentHTML("beforeend", "<style>" + STYLE + "</style>");
  loadMeta()
    .then(() => {
      // 本标签页内已经解锁过？直接复用，不必再输一次。
      // 失败就清掉，安静地留给下一次 prompt() 重新问。
      let saved = null;
      try { saved = sessionStorage.getItem(SS_KEY); } catch (_) {}
      if (!saved) return;
      return installDek(b64ToBytes(saved), false)
        .catch(() => { try { sessionStorage.removeItem(SS_KEY); } catch (_) {} });
    })
    .catch(() => { /* meta 加载失败：等真正 prompt() 时再把错误给人看 */ });

  window.EXAM_LOCK = {
    ready: ready,
    prompt: prompt,
    load: load,
    lock: lock,
    isUnlocked: function () { return unlocked; }
  };
})();
