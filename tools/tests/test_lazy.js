/* 按需加载 + 题型统一 的端到端验证（无头浏览器缺失，用 DOM 桩跑真实脚本）。
 *
 * 覆盖：
 *   A 真实考试页：首屏不加载任何卷；点「开始考试」只加载所选那一卷
 *   B 题型专练页：首屏只加载题型索引（密文 <1KB）；点「开始练习」只加载命中该题型的卷
 *   C 题型统一：全库 19 个题型，旧命名（情境应答/短对话Ⅰ/汉字接续/读解·整体理解…）已无入口
 *   D 索引正确性：index-lite 的题型与题数 == 直接读数据文件算出来的结果
 *   E 跨卷随机：抽题不再固定落在最早几卷，两次抽题结果不同
 *   F 旧题型名的专练记录迁移
 *   G 口令推迟：未解锁也能看选题屏/选卷屏，点了「开始练习」/「开始考试」才要口令
 */
const fs = require("fs");
const path = require("path");
const { makeHarness } = require("./domharness");

const EXAM_DIR = path.join(__dirname, "..", "..", "exam");
const tick = () => new Promise(r => setImmediate(r));
// 题库改为密文后，取数要经 crypto.subtle + DecompressionStream，是真正的异步工作，
// 固定等一个 setImmediate 等不到。凡是「断言依赖数据已就绪」的地方一律轮询条件。
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = fn(); } catch (_) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 10));
  }
}

let fails = 0;
function ok(cond, msg) {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) fails++;
}
const volOf = fs => (fs.match(/(\d{4}-\d{2})\.js$/) || [])[1];

// ---------- D 索引正确性：index-lite vs 真实数据 ----------
console.log("=== D 索引正确性（index-lite vs 数据文件）===");
const lite = require("vm").runInNewContext(
  fs.readFileSync(path.join(EXAM_DIR, "data/N2/index-lite.js"), "utf8") + "\n;window.EXAM_INDEX_N2",
  { window: {} }
);
const truthTypes = {};
const truthPer = {};
for (const f of fs.readdirSync(path.join(EXAM_DIR, "data/N2"))) {
  if (!/^\d{4}-\d{2}\.js$/.test(f)) continue;
  const d = JSON.parse(fs.readFileSync(path.join(EXAM_DIR, "data/N2", f), "utf8").match(/=\s*(\{[\s\S]*\});\s*$/)[1]);
  const per = {};
  for (const q of d.questions) { truthTypes[q.subType] = (truthTypes[q.subType] || 0) + 1; per[q.subType] = (per[q.subType] || 0) + 1; }
  truthPer[f.replace(".js", "")] = { total: d.questions.length, types: per };
}
const idxTypes = {};
for (const e of Object.values(lite.exams)) for (const [t, n] of Object.entries(e.types)) idxTypes[t] = (idxTypes[t] || 0) + n;
ok(JSON.stringify(Object.keys(idxTypes).sort()) === JSON.stringify(Object.keys(truthTypes).sort()),
   `题型集合一致（${Object.keys(idxTypes).length} 个）`);
let countMismatch = 0;
for (const t of Object.keys(truthTypes)) if (idxTypes[t] !== truthTypes[t]) countMismatch++;
ok(countMismatch === 0, "每个题型的题数与真实数据一致");
let perMismatch = 0;
for (const k of Object.keys(truthPer)) {
  const a = lite.exams[k], b = truthPer[k];
  if (!a || a.total !== b.total || JSON.stringify(a.types) !== JSON.stringify(sorted(b.types))) perMismatch++;
}
ok(perMismatch === 0, "每一卷的 total / types 与真实数据一致");
function sorted(o) { return Object.keys(o).sort().reduce((r, k) => (r[k] = o[k], r), {}); }

// ---------- C 题型统一 ----------
console.log("\n=== C 题型统一 ===");
const LEGACY = ["听力·短对话Ⅰ", "听力·短对话Ⅱ", "听力·短独白", "听力·情境应答", "听力·长篇", "读解·意见A/B", "读解·整体理解", "汉字接续"];
const leftover = LEGACY.filter(t => idxTypes[t]);
ok(leftover.length === 0, `旧题型名已全部退役${leftover.length ? "（残留：" + leftover.join("、") + "）" : ""}`);
ok(Object.keys(idxTypes).length === 19, `全库题型收敛到 19 个（实际 ${Object.keys(idxTypes).length}）`);
ok(idxTypes["听力·即时应答"] === 310 && idxTypes["听力·课题理解"] === 145 && idxTypes["文章文法"] === 140 && idxTypes["语词形成"] === 124,
   "合并后题量正确：即时应答 310 / 课题理解 145 / 文章文法 140 / 语词形成 124");

// ---------- A 真实考试页按需加载 ----------
console.log("\n=== A 真实考试页：首屏零数据、只加载所选卷 ===");
(async () => {
  {
    const H = makeHarness(EXAM_DIR);
    H.run("exam-page.js");
    await tick();
    ok(H.loaded.filter(volOf).length === 0, `首屏未加载任何卷（已注入脚本 ${H.loaded.length} 个）`);
    ok(/年份/.test(H.side.innerHTML) && /月份/.test(H.side.innerHTML), "年份/月份选择器已渲染（未依赖任何数据）");

    H.side.querySelectorAll("[data-year]").find(e => e.dataset.year === "2010").onclick();
    H.side.querySelectorAll("[data-month]").find(e => e.dataset.month === "7").onclick();
    H.side.querySelectorAll("[data-mode]").find(e => e.dataset.mode === "relaxed").onclick();
    ok(!!H.el("start"), "选完年/月/模式后出现「开始考试」");
    ok(H.loaded.filter(volOf).length === 0, "选完设置仍未加载任何卷");

    await H.el("start").onclick();
    await tick();
    const vols = H.loaded.filter(volOf);
    ok(vols.length === 1 && /2010-07\.js$/.test(vols[0]), `只加载所选那一卷（${vols.join(",")}）`);
    const S = H.sandbox.EXAM.S;
    ok(S.set.length === 107, `进入答题屏，本卷题量 ${S.set.length}（期望 107）`);
    ok(S.set[0].part === "lang", "作答顺序仍是 言语知识 → 读解 → 听力");
    ok(/已答/.test(H.side.innerHTML), "答题屏侧栏（题号网格）正常渲染，未因 meta 改动而报错");
  }

  // ---------- B 题型专练页按需加载 ----------
  console.log("\n=== B 题型专练页：首屏只拉索引，抽题只拉命中卷 ===");
  {
    const H = makeHarness(EXAM_DIR);
    H.run("practice.js");
    await until(() => H.side.querySelectorAll("[data-st]").length > 0);
    ok(H.loaded.length === 1 && /index-lite\.js$/.test(H.loaded[0]),
       `首屏只加载题型索引（已注入：${H.loaded.join(",") || "无"}）`);
    ok(H.loaded.filter(volOf).length === 0, "首屏未加载任何卷");

    const items = H.side.querySelectorAll("[data-st]");
    ok(items.length === 19, `侧栏列出 19 个题型入口（实际 ${items.length}）`);

    // 从索引算出每个题型覆盖多少卷，挑「覆盖卷最少」的题型来验证按需加载是真的在裁剪
    const volsOf = st => Object.keys(lite.exams).filter(k => lite.exams[k].types[st]);
    const ranking = Object.keys(idxTypes).map(st => [st, volsOf(st).length]).sort((a, b) => a[1] - b[1]);
    const [smallType, smallN] = ranking[0];
    console.log(`  · 覆盖卷最少的题型：${smallType}（${smallN} 卷）／最多的：${ranking[ranking.length - 1][0]}（${ranking[ranking.length - 1][1]} 卷）`);

    const pick = name => {
      const it = H.side.querySelectorAll("[data-st]").find(e => e.dataset.st === name);
      if (!it) throw new Error("侧栏找不到题型：" + name);
      it.onclick();
    };

    pick("读解·意见AB");   // 旧名「读解·意见A/B」退役后，这里只剩一个入口
    ok(H.loaded.filter(volOf).length === 0, "选题型本身仍不加载题目数据");
    ok(/题池 60 题/.test(H.main.innerHTML), "题池数字直接来自索引（60 题），无需加载数据");

    const before = H.loaded.filter(volOf).slice();
    H.el("start").onclick();
    await until(() => H.sandbox.EXAM.S.set.length === 10);
    const added = H.loaded.filter(volOf).filter(v => !before.includes(v));
    const expect = volsOf("读解·意见AB");
    ok(added.length === expect.length && added.length > 0,
       `抽题只加载命中该题型的 ${expect.length} 卷（实际 ${added.length}）`);
    const S = H.sandbox.EXAM.S;
    ok(S.set.length === 10, `默认抽 10 题（实际 ${S.set.length}）`);
    ok(S.set.every(q => q.subType === "读解·意见AB"), "抽到的题全部属于该题型");
    ok(new Set(S.set.map(q => q.id)).size === S.set.length, "抽到的题无重复");

    // ---------- E 跨卷随机 ----------
    console.log("\n=== E 跨卷随机 ===");
    const firstIds = S.set.map(q => q.id).join(",");
    const firstVols = new Set(S.set.map(q => q.id.slice(3, 10)));
    ok(firstVols.size > 1, `一组 10 题跨越了 ${firstVols.size} 卷（旧行为会固定在最早一卷）`);
    H.el("back").onclick();          // 回选题屏
    await tick();
    H.el("start").onclick();         // 再抽一组
    await until(() => H.sandbox.EXAM.S.set.map(q => q.id).join(",") !== firstIds);
    const second = H.sandbox.EXAM.S.set.map(q => q.id).join(",");
    ok(second !== firstIds, "再抽一组与上一组不同（确实打乱了顺序）");

    // 最少卷题型：换一个干净的 harness，确认真的只拉必要的几卷（而不是顺手拉完 30 卷）
    console.log(`\n--- 最少卷题型（${smallType}，${smallN} 卷）---`);
    {
      const H2 = makeHarness(EXAM_DIR);
      H2.run("practice.js");
      await until(() => H2.side.querySelectorAll("[data-st]").length > 0);
      const it = H2.side.querySelectorAll("[data-st]").find(e => e.dataset.st === smallType);
      ok(!!it, `侧栏有「${smallType}」入口`);
      it.onclick();
      ok(H2.loaded.filter(volOf).length === 0, "选题型本身仍未加载题目数据");
      H2.el("start").onclick();
      await until(() => H2.sandbox.EXAM.S.set.length > 0);
      const got = H2.loaded.filter(volOf);
      ok(got.length === smallN, `只加载该题型所在的 ${smallN} 卷（实际 ${got.length}）`);
      ok(H2.sandbox.EXAM.S.set.every(q => q.subType === smallType), "抽到的题全部属于该题型");
    }

    // 最大卷题型：汉字读音 覆盖全部 30 卷
    console.log("\n--- 全卷题型（汉字读音，覆盖全部 30 卷）---");
    H.el("back").onclick();
    await tick();
    pick("汉字读音");
    const prevIds = H.sandbox.EXAM.S.set.map(q => q.id).join(",");
    H.el("start").onclick();
    // 上一次抽题已经有 10 题了，拿「题量为 10」当信号会在旧结果上立刻返回 ——
    // 必须等这一组的题号真的换掉。
    await until(() => H.sandbox.EXAM.S.set.map(q => q.id).join(",") !== prevIds);
    const covered = new Set(H.loaded.filter(volOf).map(volOf));
    ok(covered.size === 30, `汉字读音需要全库 30 卷，实际加载 ${covered.size} 卷`);
    ok(H.sandbox.EXAM.S.set.length === 10, "大池题量仍按默认 10 题");
    ok(H.sandbox.EXAM.S.set.every(q => q.subType === "汉字读音"), "抽到的题全部属于该题型");
  }

// ---------- G 口令推迟到真正要读题时 ----------
// 这是本次改动的核心：题库密文没变，但口令框从「进模块就问」挪到
// 「点开始练习 / 开始考试才问」。索引改成明文常驻，选题屏才能不靠口令渲染。
const PASS = process.argv[2];
console.log("\n=== G 口令推迟：点「开始」才要口令 ===");
if (!PASS) {
  console.log("  · 跳过（未提供口令）：node test_lazy.js <口令>");
} else {
  // ---- 练习页 ----
  console.log("\n--- G1 题型专练 ---");
  const H = makeHarness(EXAM_DIR, { dek: null });   // 模拟「这个标签页还没输过口令」
  H.run("practice.js");
  await until(() => H.side.querySelectorAll("[data-st]").length > 0);
  ok(H.side.querySelectorAll("[data-st]").length === 19, "未输口令也能列出 19 个题型");
  ok(H.sandbox.EXAM_LOCK.isUnlocked() === false, "此时确实还没解锁");
  ok(H.loaded.filter(volOf).length === 0, "此时一卷都没加载");
  ok(!H.el("lk-pass"), "此时没有口令输入框（不再一进门就锁）");

  H.side.querySelectorAll("[data-st]").find(e => e.dataset.st === "读解·意见AB").onclick();
  ok(/题池 60 题/.test(H.main.innerHTML), "题池数字也能直接读出来（60 题）");

  H.el("start").onclick();
  ok(await until(() => !!H.el("lk-pass")), "点「开始练习」才弹出口令框");
  ok(H.loaded.filter(volOf).length === 0, "口令框弹出后仍未加载任何卷");

  H.el("lk-pass").value = "definitely-not-the-password";
  H.el("lk-go").fire("click");
  ok(await until(() => H.el("lk-err").textContent === "口令错误。"), "错误口令被拒（口令错误。）");
  ok(H.loaded.filter(volOf).length === 0, "错误口令后仍不加载数据");

  H.el("lk-cancel").fire("click");
  ok(await until(() => H.el("start").disabled === false), "取消后按钮恢复可点");
  ok(H.sandbox.EXAM.S.set.length === 0, "取消后没有进入答题屏");
  ok(!/题目加载失败/.test(H.el("start")._adj || ""), "取消没有被报成「题目加载失败」");

  H.el("start").onclick();
  await until(() => !!H.el("lk-pass"));
  ok(H.sandbox.EXAM_LOCK.isUnlocked() === false, "取消过之后仍然要口令");
  H.el("lk-pass").value = PASS;
  H.el("lk-go").fire("click");
  ok(await until(() => H.sandbox.EXAM.S.set.length === 10), "输对口令后才抽到题（10 题）");
  ok(H.sandbox.EXAM.S.set.every(q => q.subType === "读解·意见AB"), "抽到的题仍属于所选题型");
  ok(H.sandbox.EXAM_LOCK.isUnlocked() === true, "解锁状态已生效");

  // ---- 考试页 ----
  console.log("\n--- G2 真实考试 ---");
  const H2 = makeHarness(EXAM_DIR, { dek: null });
  H2.run("exam-page.js");
  await tick();
  ok(/年份/.test(H2.side.innerHTML), "未输口令也能看到选卷屏");
  H2.side.querySelectorAll("[data-year]").find(e => e.dataset.year === "2015").onclick();
  H2.side.querySelectorAll("[data-month]").find(e => e.dataset.month === "12").onclick();
  H2.side.querySelectorAll("[data-mode]").find(e => e.dataset.mode === "relaxed").onclick();
  ok(H2.loaded.filter(volOf).length === 0, "选完设置仍未加载任何卷");

  const running = H2.el("start").onclick();     // 会一直挂着，等我们输口令
  ok(await until(() => !!H2.el("lk-pass")), "点「开始考试」才弹出口令框");
  ok(H2.loaded.filter(volOf).length === 0, "口令框弹出后仍未加载任何卷");

  H2.el("lk-cancel").fire("click");
  await running;                                // 取消后 handler 要能正常收尾，不能挂死
  ok(await until(() => H2.el("start").disabled === false), "取消后按钮恢复可点");
  ok(H2.loaded.filter(volOf).length === 0, "取消后没有加载任何卷");
  ok(!/本卷数据加载失败/.test(H2.el("start")._adj || ""), "取消没有被报成「本卷数据加载失败」");

  H2.el("start").onclick();
  await until(() => !!H2.el("lk-pass"));
  H2.el("lk-pass").value = PASS;
  H2.el("lk-go").fire("click");
  // 注意：loaded 是在脚本注入那一刻就记账的，解密还没完；要等真实状态 S.set
  ok(await until(() => H2.sandbox.EXAM.S.set.length > 0), "输对口令后才进入答题屏");
  const v2 = H2.loaded.filter(volOf);
  ok(v2.length === 1 && /2015-12\.js$/.test(v2[0] || ""), `只加载所选那一卷（${v2.join(",") || "无"}）`);
}

// ---------- F 旧题型名的专练记录迁移 ----------
console.log("\n=== F 专练记录：旧题型名并入新名 ===");
{
  const H = makeHarness(EXAM_DIR);
  H.sandbox.localStorage.setItem("jlpt_practice_records", JSON.stringify({
    "听力·情境应答": { count: 45, last: 1000 },
    "听力·即时应答": { count: 255, last: 2000 },
    "汉字接续": { count: 6, last: 500 },
    "读解·整体理解": { count: 8, last: 900 }
  }));
  const p = H.sandbox.EXAM.records.practiceAll();
  ok(p["听力·即时应答"] && p["听力·即时应答"].count === 300, `旧「情境应答 45」并入「即时应答 255」→ 300（实际 ${p["听力·即时应答"] && p["听力·即时应答"].count}）`);
  ok(p["听力·即时应答"].last === 2000, "取两者较新的时间戳（不会让记录看起来变旧）");
  ok(p["语词形成"] && p["语词形成"].count === 6, "旧「汉字接续」→「语词形成」");
  ok(p["文章文法"] && p["文章文法"].count === 8, "旧「读解·整体理解」→「文章文法」");
  ok(!p["听力·情境应答"] && !p["汉字接续"] && !p["读解·整体理解"], "旧键已删除，不会重复累加");
  const again = H.sandbox.EXAM.records.practiceAll();
  ok(again["听力·即时应答"].count === 300, "再次读取不会被重复累加（迁移幂等）");
}

console.log("\n" + (fails === 0 ? "全部通过（0 失败）" : fails + " 项失败"));
process.exit(fails === 0 ? 0 : 1);
})();
