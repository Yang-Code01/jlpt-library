/* ============================================================
   真题模块解锁层（exam-lock.js）
   ============================================================
   题目数据以密文形式存放（exam/data/N2/enc/*.js），本文件负责：
     1. 页面一进来就铺一层不透明锁屏，内容区先藏起来
     2. 收口令 → PBKDF2 派生 KEK → 解包 DEK（解不开 = 口令错）
     3. 解密时用 HKDF(DEK, 卷名) 得到分卷密钥，AES-256-GCM 解密 + 解压
     4. 解出来的对象与原先的 window.EXAM_<卷> 完全同形，上层代码无需知道加密存在

   口令永不离开本机：没有网络请求、没有 cookie、没有服务端。
   密钥只活在内存闭包 + （可选）本标签页的 sessionStorage 里。

   对外接口：
     EXAM_LOCK.ready                    Promise，解锁后 resolve
     EXAM_LOCK.load(url, 全局名, AAD名)  → Promise<数据对象>
     EXAM_LOCK.isUnlocked()             → boolean
     EXAM_LOCK.lock()                   清除内存密钥并重新上锁
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
  let dekKey = null;        // 非导出的 HKDF CryptoKey
  let unlocked = false;
  let overlay = null;
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
    'html[data-exam-locked] .wrap{visibility:hidden !important}',
    '#exam-lock{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;',
    'padding:24px;background:var(--paper,#e9ebee);color:var(--ink,#17202a);',
    'font-family:var(--font-sans,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif)}',
    '#exam-lock .lk-card{width:100%;max-width:402px;background:var(--surface,#fbfcfc);',
    'border:1px solid var(--border,#d8dde2);border-radius:var(--radius,14px);padding:28px 26px 24px}',
    '#exam-lock .lk-eyebrow{font-size:11px;letter-spacing:.14em;color:var(--muted,#5a6672);margin:0 0 8px}',
    '#exam-lock h2{font-size:19px;font-weight:600;letter-spacing:.01em;margin:0 0 10px}',
    '#exam-lock .lk-note{font-size:13px;line-height:1.7;color:var(--muted,#5a6672);margin:0 0 18px}',
    '#exam-lock .lk-row{display:flex;gap:8px}',
    '#exam-lock input[type=password]{flex:1;min-width:0;font:inherit;font-size:14px;padding:11px 13px;',
    'background:var(--surface-2,#f2f4f5);border:1px solid var(--border,#d8dde2);',
    'border-radius:var(--radius-sm,10px);color:var(--ink,#17202a);outline:none}',
    '#exam-lock input[type=password]:focus{border-color:var(--accent,#c3422a)}',
    '#exam-lock button{font:inherit;font-size:14px;font-weight:600;padding:11px 20px;cursor:pointer;',
    'background:var(--accent,#c3422a);color:var(--on-accent,#fff);border:none;',
    'border-radius:var(--radius-sm,10px);white-space:nowrap}',
    '#exam-lock button:disabled{opacity:.55;cursor:default}',
    '#exam-lock .lk-remember{display:flex;align-items:center;gap:7px;font-size:12.5px;',
    'color:var(--muted,#5a6672);margin:12px 0 0;cursor:pointer}',
    '#exam-lock .lk-remember input{margin:0;accent-color:var(--accent,#c3422a)}',
    '#exam-lock .lk-err{font-size:13px;color:var(--red,#a33b3b);min-height:20px;margin:10px 0 0}',
    '#exam-lock .lk-foot{font-size:11.5px;line-height:1.7;color:var(--muted,#5a6672);',
    'margin:16px 0 0;padding-top:14px;border-top:1px solid var(--border-soft,#e4e8ec)}'
  ].join("");

  /* ---------- 锁屏 ---------- */
  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.id = "exam-lock";
    overlay.innerHTML =
      '<div class="lk-card">' +
        '<p class="lk-eyebrow">JLPT 真题练习</p>' +
        '<h2>这一区已加密</h2>' +
        '<p class="lk-note">题库以 AES-256-GCM 加密存放，没有口令读不出内容。' +
        '口令只在本机内存里使用，不会发送到任何地方。</p>' +
        '<div class="lk-row">' +
          '<input id="lk-pass" type="password" autocomplete="current-password" spellcheck="false" placeholder="输入口令">' +
          '<button id="lk-go" disabled>解锁</button>' +
        '</div>' +
        '<label class="lk-remember"><input type="checkbox" id="lk-remember" checked>' +
        '本标签页内免重复输入（关闭标签页即失效）</label>' +
        '<p class="lk-err" id="lk-err"></p>' +
        '<p class="lk-foot">口令没有找回通道，遗失后无法还原数据——这是设计使然，' +
        '因为它同时也是唯一的解密依据。</p>' +
      "</div>";
    document.body.appendChild(overlay);

    const input = overlay.querySelector("#lk-pass");
    const btn = overlay.querySelector("#lk-go");
    const err = overlay.querySelector("#lk-err");
    const remember = overlay.querySelector("#lk-remember");

    function setErr(msg) { err.textContent = msg || ""; }
    function setBusy(busy) {
      btn.disabled = busy || !meta;
      input.disabled = busy;
      btn.textContent = busy ? "解锁中…" : "解锁";
    }
    function unlock() {
      const pass = input.value;
      if (!pass) { setErr("请输入口令。"); input.focus(); return; }
      setErr(""); setBusy(true);
      unwrapDek(pass)
        .then((dek) => activate(dek, remember.checked))
        .catch(() => { setErr("口令错误。"); setBusy(false); input.select(); })
        .then(() => setBusy(false));
    }
    btn.addEventListener("click", unlock);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });
    return { setErr, setBusy, focus: () => input.focus() };
  }

  let ui = null;
  function lockAttrOn() { document.documentElement.setAttribute("data-exam-locked", ""); }
  function lockAttrOff() { document.documentElement.removeAttribute("data-exam-locked"); }

  function onDomReady() {
    ui = buildOverlay();
    loadMeta();
  }

  function loadMeta() {
    injectScript(META_URL)
      .then(() => {
        const m = window.EXAM_ENC_META;
        if (!m || !m.wrap) throw new Error("meta.js 里没有口令包裹信息");
        meta = m;
        // 本标签页内已解锁过？直接复用，不必再输一次
        let saved = null;
        try { saved = sessionStorage.getItem(SS_KEY); } catch (_) {}
        if (saved) {
          activate(b64ToBytes(saved), false).catch(() => {
            try { sessionStorage.removeItem(SS_KEY); } catch (_) {}
            if (ui) { ui.setBusy(false); ui.setErr(""); ui.focus(); }
          });
        } else if (ui) {
          ui.setBusy(false); ui.focus();
        }
      })
      .catch((e) => { if (ui) { ui.setBusy(false); ui.setErr("无法加载加密参数：" + e.message); } });
  }

  async function activate(dekBytes, remember) {
    dekKey = await crypto.subtle.importKey("raw", dekBytes, "HKDF", false, ["deriveBits"]);
    if (remember) { try { sessionStorage.setItem(SS_KEY, bytesToB64(dekBytes)); } catch (_) {} }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    lockAttrOff();
    if (!unlocked) { unlocked = true; readyResolve(); }
  }

  /* ---------- 对外接口 ---------- */
  async function load(url, globalName, aadName) {
    await ready;
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
    if (!overlay) { lockAttrOn(); ui = buildOverlay(); }
    if (ui) { ui.setBusy(false); ui.focus(); }
  }

  /* ---------- 启动 ---------- */
  document.head.insertAdjacentHTML("beforeend", "<style>" + STYLE + "</style>");
  lockAttrOn();   // 先藏内容，避免加密数据没到、页面却先闪一下
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onDomReady);
  } else {
    onDomReady();
  }

  window.EXAM_LOCK = {
    ready: ready,
    load: load,
    lock: lock,
    isUnlocked: function () { return unlocked; }
  };
})();
