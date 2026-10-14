/* 验证新增卷已挂上 UI：年份/月份选项齐全，且能真正开始作答。 */
const path = require("path");
const { makeHarness } = require("./domharness.js");
const step = (ms) => new Promise(r => setTimeout(r, ms));

const EXPECT_YEARS = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

(async () => {
  const H = makeHarness(path.join(__dirname, "..", "..", "exam"));
  H.run("exam-page.js");
  await step(200);
  const side = H.side, main = H.main;

  const years = side.querySelectorAll("[data-year]").map(e => +e.dataset.year);
  console.log("年份 pills:", years.join(","));
  const missingY = EXPECT_YEARS.filter(y => !years.includes(y));
  const extraY = years.filter(y => !EXPECT_YEARS.includes(y));
  console.log("  缺失年份:", missingY, " 多余年份:", extraY);

  // 每个月都应有对应卷（2010-2025 除 2020-07 外各月齐全）
  const EXPECT = ["2010-07","2010-12","2011-07","2011-12","2012-07","2012-12","2013-07","2013-12",
    "2014-07","2014-12","2015-07","2015-12","2016-07","2016-12","2017-07","2017-12",
    "2018-07","2018-12","2019-07","2019-12","2020-12","2021-07","2021-12","2022-07",
    "2022-12","2023-07","2023-12","2024-07","2024-12","2025-07"];
  let allOk = true;
  for (const e of EXPECT) {
    const y = +e.slice(0, 4), mo = +e.slice(5, 7);
    side.querySelectorAll("[data-year]").find(x => +x.dataset.year === y).onclick();
    await step(5);
    const months = side.querySelectorAll("[data-month]").map(x => +x.dataset.month);
    if (!months.includes(mo)) { console.log("  !! 缺月份:", e); allOk = false; }
  }
  console.log("每月份可点齐:", allOk);

  // 抽查四个卷能开始考试且题量正确（含补题后题数变化的 2010-07、新入库的 2011-12）
  for (const [y, mo, want] of [[2010, 7, 107], [2011, 12, 105], [2024, 12, 101], [2025, 7, 71]]) {
    side.querySelectorAll("[data-year]").find(x => +x.dataset.year === y).onclick();
    await step(5);
    side.querySelectorAll("[data-month]").find(x => +x.dataset.month === mo).onclick();
    await step(5);
    side.querySelectorAll("[data-mode]").find(x => x.dataset.mode === "relaxed").onclick();
    await step(5);
    H.el("start").onclick();
    await step(60);
    const m = main.innerHTML.match(/(\d+)\s*\/\s*(\d+)/);
    const total = m ? +m[2] : -1;
    console.log(`  ${y}.${mo}: 开始成功=${main.innerHTML.includes("data-qid")} 题量=${total} 期望=${want} ${total === want ? "OK" : "!!"}`);
    if (!m) console.log("    内文片段:", main.innerHTML.slice(0, 200));
    // 返回设置屏准备下一轮
    H.el("back").onclick();
    await step(30);
  }
})();
