/* 验证两条返回路径都要能回到设置屏：
   A) 页内「‹ 返回」按钮
   B) 浏览器返回键（popstate / history.back）        */
const path = require("path");
const { makeHarness } = require("./domharness.js");
const step = (ms) => new Promise(r => setTimeout(r, ms));
// 题型专练页的「开始」是异步的（要先 loadIndex / 按需拉卷），固定 sleep 会偶发抢跑；
// 改成轮询到答题屏真正出现为止，避免误报。
const waitFor = async (fn, ms = 1500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await step(10); }
  return fn();
};

async function scenario(pageFile, label, pick, startCb) {
  const H = makeHarness(path.join(__dirname, "..", "..", "exam"));
  H.run(pageFile);
  await step(20);
  const side = H.side, main = H.main;
  console.log(`\n################ ${label} ################`);

  await pick(H, side);
  console.log("【设置屏】主区含开始按钮:", /id="start"/.test(main.innerHTML));

  startCb(H);
  await waitFor(() => main.innerHTML.includes("data-qid"));
  console.log("【答题屏】主区含题目:", main.innerHTML.includes("data-qid") || main.innerHTML.includes("q-block"));
  console.log("【答题屏】主区含「‹ 返回」:", main.innerHTML.includes("‹ 返回"));

  // --- A) 页内返回按钮 ---
  console.log("\n--- A) 点页内「‹ 返回」---");
  H.el("back").onclick();
  await step(20);
  console.log("  回到设置屏:", /id="start"/.test(main.innerHTML));
  console.log("  已离开答题屏:", !main.innerHTML.includes("data-qid"));
  console.log("  历史深度:", H.sandbox.history._depth());

  // --- B) 浏览器返回键 ---
  console.log("\n--- B) 浏览器返回键 ---");
  startCb(H);
  await waitFor(() => main.innerHTML.includes("data-qid"));
  console.log("  再次进入答题屏:", main.innerHTML.includes("data-qid"));
  console.log("  历史深度:", H.sandbox.history._depth());
  H.sandbox.history.back();      // 模拟按浏览器返回键
  await step(20);
  console.log("  回到设置屏:", /id="start"/.test(main.innerHTML));
  console.log("  已离开答题屏:", !main.innerHTML.includes("data-qid"));
  console.log("  历史深度:", H.sandbox.history._depth());
}

(async () => {
  // ===== 真实考试 =====
  await scenario("exam-page.js", "真实考试 exam.html",
    async (H, side) => {
      side.querySelectorAll("[data-year]").find(e => e.dataset.year === "2022").onclick();
      await step(10);
      side.querySelectorAll("[data-month]").find(e => e.dataset.month === "7").onclick();
      await step(10);
      side.querySelectorAll("[data-mode]").find(e => e.dataset.mode === "relaxed").onclick();
      await step(10);
    },
    (H) => H.el("start").onclick());

  // ===== 题型专练 =====
  await scenario("practice.js", "题型专练 practice.html",
    async (H, side) => {
      const st = side.querySelectorAll("[data-st]").find(e => e.dataset.st === "听力·课题理解");
      st.onclick();
      await step(10);
    },
    (H) => H.el("start").onclick());
})();
