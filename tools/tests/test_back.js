/* 验证：真实考试 选卷 → 答题 → 返回，是否回到「选年份/月份」的设置屏 */
const path = require("path");
const { makeHarness } = require("./domharness.js");
const H = makeHarness(path.join(__dirname, "..", "..", "exam"));
H.run("exam-page.js");

const step = (ms) => new Promise(r => setTimeout(r, ms));
// 取数要过 PBKDF2/HKDF/AES-GCM，固定 sleep 在负载下会抢跑（历史上偶发 exit 1）→ 一律轮询条件
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = !!fn(); } catch (_) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await step(10);
  }
}

(async () => {
  const side = H.side, main = H.main;
  const pick = (attr, val) => {
    const el = side.querySelectorAll(`[data-${attr}]`).find(e => e.dataset[attr] === val);
    if (!el) throw new Error(`设置屏没有 data-${attr}="${val}"`);
    el.onclick();
  };

  await waitFor(() => side.querySelectorAll("[data-year]").length > 0);
  H.check("设置屏：侧栏含「年份」「月份」「等级」", ["年份", "月份", "等级"].every(t => side.innerHTML.includes(t)));
  H.check("设置屏：未选卷时不显示「开始考试」", !main.innerHTML.includes('id="start"'));

  pick("year", "2022");
  await step(10);
  pick("month", "7");
  await step(10);
  pick("mode", "relaxed");
  await step(10);
  H.check("保留已选年份 2022（on）", /class="pill on" data-year="2022"/.test(side.innerHTML));
  H.check("保留已选月份 7（on）", /class="pill on" data-month="7"/.test(side.innerHTML));
  H.check("选卷后：主区出现「开始考试」", await waitFor(() => main.innerHTML.includes('id="start"')));

  H.el("start").onclick();
  await step(20);
  H.check("答题屏：主区含题目", await waitFor(() => main.innerHTML.includes("data-qid")));
  H.check("答题屏：主区含「‹ 返回」", main.innerHTML.includes("‹ 返回"));

  H.el("back").onclick();
  await waitFor(() => main.innerHTML.includes('id="start"'));
  H.check("返回后：主区回到设置屏", main.innerHTML.includes('id="start"'));
  H.check("返回后：主区不再是答题屏", !main.innerHTML.includes("data-qid"));
  H.check("返回后：侧栏仍含「年份」「月份」「等级」", ["年份", "月份", "等级"].every(t => side.innerHTML.includes(t)));
  H.check("返回后：保留已选年份 2022（on）", /class="pill on" data-year="2022"/.test(side.innerHTML));
  H.check("返回后：保留已选月份 7（on）", /class="pill on" data-month="7"/.test(side.innerHTML));
})();
