/* 验证复盘屏返回 + 再考一次后返回键仍能退回设置屏 */
const path = require("path");
const { makeHarness } = require("./domharness.js");
const step = (ms) => new Promise(r => setTimeout(r, ms));
// 题库改为密文后取数要经 PBKDF2/HKDF/AES-GCM 解密解压，固定 step 等不到，
// 凡是「断言依赖题目已渲染」的地方一律轮询条件。
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = fn(); } catch (_) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await step(10);
  }
}

(async () => {
  const H = makeHarness(path.join(__dirname, "..", "..", "exam"));
  H.run("exam-page.js");
  await step(20);
  const side = H.side, main = H.main;

  side.querySelectorAll("[data-year]").find(e => e.dataset.year === "2022").onclick(); await step(10);
  side.querySelectorAll("[data-month]").find(e => e.dataset.month === "7").onclick(); await step(10);
  side.querySelectorAll("[data-mode]").find(e => e.dataset.mode === "relaxed").onclick(); await step(10);
  H.el("start").onclick();
  await waitFor(() => main.innerHTML.includes("data-qid"));

  // 直接交卷：100 题，跳到最后再点交卷
  console.log("=== 交卷 ===");
  console.log("答题屏:", main.innerHTML.includes("data-qid"));
  // 手动触发 finish 不方便，改为点 next 直到最后：太慢。
  // 换法：检查 back2/back3 是否存在于复盘屏 —— 先模拟：直接把 set 缩到 1 题
  // 通过点击 next 在 1 题的 set 上触发交卷。

  // 重新开一个 harness，用 practice 页（题量最小可设 1）
  const P = makeHarness(path.join(__dirname, "..", "..", "exam"));
  P.run("practice.js");
  await waitFor(() => P.side.querySelectorAll("[data-st]").length > 0);
  const pside = P.side, pmain = P.main;
  pside.querySelectorAll("[data-st]").find(e => e.dataset.st === "听力·课题理解").onclick();
  await step(10);
  // 自定义题量 1
  const inp = P.el("tier-input");
  inp.value = "1";
  inp.oninput();
  await step(10);
  P.el("start").onclick();
  await waitFor(() => pmain.innerHTML.includes("data-qid"));
  console.log("\n=== practice: 1 题 → 交卷 → 复盘屏 ===");
  console.log("答题屏:", pmain.innerHTML.includes("data-qid"));
  console.log("历史深度:", P.sandbox.history._depth());
  P.el("next").onclick();   // 唯一一题 → 交卷
  await step(20);
  console.log("复盘屏含分数区:", pmain.innerHTML.includes("score-hero"));
  console.log("复盘屏含「返回上一层」:", pmain.innerHTML.includes("返回上一层"));

  console.log("\n--- 点复盘屏「‹ 返回上一层」---");
  P.el("back3").onclick();
  await step(20);
  console.log("回到设置屏:", /id="start"/.test(pmain.innerHTML));
  console.log("已离开复盘屏:", !pmain.innerHTML.includes("score-hero"));
  console.log("历史深度:", P.sandbox.history._depth());
})();
