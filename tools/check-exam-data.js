/* 全库完整性审计（原先是硬编码 10 卷的旧脚本，2026-09-27 改为自动发现全部卷 + 全字段体检）。
 *
 * 用法：仓库根直接跑即可 ——
 *   node tools/check-exam-data.js
 *
 * 检查项：
 *   1 卷清单：data/N2/*.js ≡ exam-page.js/practice.js 的 EXAMS ≡ index-lite.js（三方一致）
 *   2 id 全局唯一；id 与 卷号/part/problem/qNo 自洽
 *   3 answer 在选项范围内；有 optionsMissing 时选项数=缺失数+已有数
 *   4 optionNotes：键必须落在「错误选项」编号上（不得包含正确答案），且键在范围内
 *   5 optionNotes 是否漏了某个错误选项的注释（提示，不算错）
 *   6 解析覆盖：言語知識+読解 每卷 100%；听力允许缺（第三方源无解析）
 *   7 听力题 instruction 覆盖；「完全没有题干也没有指引」的题（应为 0）
 *   8 meta.exam 与文件名一致；meta.parts 的 problem 列表与实际题目吻合
 */
const fs = require("fs");
const path = require("path");

// ---------- 定位 exam/ ----------
let examDir = process.cwd();
if (!fs.existsSync(path.join(examDir, "data", "N2"))) examDir = path.join(__dirname, "..", "exam");
const N2 = path.join(examDir, "data", "N2");
if (!fs.existsSync(N2)) { console.error("找不到 exam/data/N2，请在 exam/ 目录下运行"); process.exit(2); }

const fails = [];
const warns = [];
const fail = m => fails.push(m);
const warn = m => warns.push(m);

const load = f => {
  const src = fs.readFileSync(path.join(N2, f), "utf8");
  const m = src.match(/=\s*(\{[\s\S]*\});\s*$/);
  if (!m) throw new Error("无法解析 " + f);
  return JSON.parse(m[1]);
};

// 选项数。注意 optionsMissing 是 **布尔** 标志（表示「该题选项文本未收录」），
// 不是数字；带此标志的题在 UI 里按非计分练习题处理（isCorrect 返回 null），
// 但答案键仍是 1–4，所以要按 4 个选项来校验范围。
function optCount(q) {
  if (q.options && q.options.length) return q.options.length;
  return q.optionsMissing ? 4 : 0;
}

// ---------- 1 卷清单三方一致 ----------
const files = fs.readdirSync(N2).filter(f => /^\d{4}-\d{2}\.js$/.test(f)).map(f => f.replace(".js", "")).sort();
const readExams = p => {
  const s = fs.readFileSync(path.join(examDir, p), "utf8");
  const m = s.match(/const EXAMS = \[([\s\S]*?)\]/);
  return m ? (m[1].match(/"\d{4}-\d{2}"/g) || []).map(x => x.slice(1, -1)) : null;
};
const pageExams = readExams("exam-page.js");
const pracExams = readExams("practice.js");
const lite = require("vm").runInNewContext(fs.readFileSync(path.join(N2, "index-lite.js"), "utf8") + "\n;window.EXAM_INDEX_N2", { window: {} });
if (!pageExams) fail("exam-page.js 里找不到 EXAMS");
if (!pracExams) fail("practice.js 里找不到 EXAMS");
if (pageExams && JSON.stringify(pageExams) !== JSON.stringify(files)) fail("exam-page.js 的 EXAMS 与数据文件不一致");
if (pracExams && JSON.stringify(pracExams) !== JSON.stringify(files)) fail("practice.js 的 EXAMS 与数据文件不一致");
if (JSON.stringify(Object.keys(lite.exams).sort()) !== JSON.stringify(files)) fail("index-lite.js 的卷清单与数据文件不一致");
if (files.includes("2020-07")) fail("出现了 2020-07（该场考试因疫情取消，不应存在）");

// ---------- 逐卷体检 ----------
const allIds = new Map();
let total = 0, explLangRead = 0, langRead = 0, listen = 0, listenInstr = 0, noStem = 0, missingOpt = 0, noAudio = 0;
// 听力说明必须真的是「聴解说明」。只检查「非空」不够：19 卷曾因抓取器回落到言語知識
// 文本而显示「問題1　次の言葉の読み方として…」，当时这项检查照样报 100%。
// 真源 = .scratch/jlpt-exam/scrape_jala.py 的 INSTR_LISTEN。
const LISTEN_INSTR = {
  1: "では、まず質問を聞いてください",
  2: "では、まず質問を聞いてください",
  3: "では、指示に従って、質問用紙の4つの答えの中から",
  4: "では、質問を聞いて、それに対する返事を",
  5: "では、長めの話を聞きます",
};
let listenInstrBad = 0;
const listenInstrBadVols = new Set();
const rows = [];

for (const key of files) {
  const d = load(key + ".js");
  const qs = d.questions;
  total += qs.length;
  if (d.meta.exam !== key) fail(`${key}: meta.exam = ${d.meta.exam}，与文件名不符`);

  // meta.parts 覆盖实际出现的 part/problem
  const metBy = {};
  for (const p of d.meta.parts || []) for (const no of p.problems) metBy[p.part + no] = true;
  for (const q of qs) if (!metBy[q.part + q.problem]) fail(`${key}: meta.parts 未声明 ${q.part}${q.problem}`);

  let eL = 0, eLR = 0, l = 0, li = 0;
  for (const q of qs) {
    if (allIds.has(q.id)) fail(`重复 id: ${q.id}（${allIds.get(q.id)} 与 ${key}）`);
    else allIds.set(q.id, key);

    // id 自洽：n2-YYYY-MM-<L|R|H><problem>-<qNo>
    const want = `n2-${key}-${{ lang: "L", reading: "R", listening: "H" }[q.part]}${q.problem}-${q.qNo}`;
    if (q.id !== want) fail(`${key}: id ${q.id} 与规范不符（应为 ${want}）`);

    const nOpt = optCount(q);
    if (q.answer != null && nOpt && (q.answer < 1 || q.answer > nOpt))
      fail(`${key}/${q.id}: answer=${q.answer} 越界（选项数 ${nOpt}）`);

    // optionNotes 不得包含正确答案，且键要在范围内
    if (q.optionNotes && !q.optionsMissing) {
      const keys = Object.keys(q.optionNotes);
      if (q.answer != null && keys.includes(String(q.answer)))
        fail(`${key}/${q.id}: optionNotes 含正确答案 ${q.answer}（解析泄漏）`);
      for (const k of keys) {
        const n = +k;
        if (!Number.isInteger(n) || n < 1 || n > nOpt) fail(`${key}/${q.id}: optionNotes 键 ${k} 越界（选项数 ${nOpt}）`);
      }
      const wrong = [];
      for (let i = 1; i <= nOpt; i++) if (i !== q.answer) wrong.push(String(i));
      const miss = wrong.filter(w => !keys.includes(w));
      if (miss.length) warn(`${key}/${q.id}: optionNotes 缺选项 ${miss.join(",")} 的说明`);
    }

    if (q.part === "listening") {
      listen++; l++;
      if (q.optionsMissing) missingOpt++;
      if (!q.audio) noAudio++;
      if (q.instruction && (q.instruction || "").includes(LISTEN_INSTR[q.problem])) { listenInstr++; li++; }
      else { listenInstrBad++; listenInstrBadVols.add(key); }
      if (!q.prompt && !q.question && !q.instruction) noStem++;
    } else {
      langRead++; eLR++;
      if (q.explanation) explLangRead++;
      if (q.explanation) eL++;
    }
  }
  rows.push({ key, n: qs.length, lr: eLR, lrCover: eLR ? Math.round((eLR - 0) / eLR * 100) : 100, l, li });
  // 逐卷 L+R 解析覆盖
  const lrQs = qs.filter(q => q.part !== "listening");
  const lrE = lrQs.filter(q => q.explanation).length;
  if (lrQs.length && lrE !== lrQs.length)
    fail(`${key}: 言語知識+読解 解析覆盖不全（${lrE}/${lrQs.length}）`);
}

// ---------- 汇总 ----------
console.log(`审计范围：${files.length} 卷 / ${total} 题（言語知識+読解 ${langRead}，听力 ${listen}）`);
console.log("卷别明细：");
for (const r of rows)
  console.log(`  ${r.key}  题 ${String(r.n).padStart(3)}  听力 ${String(r.l).padStart(2)}  听力有指引 ${String(r.li).padStart(2)}/${String(r.l).padStart(2)}`);
console.log("");
console.log(`id 唯一性：${allIds.size} 个 id / ${total} 题 ${allIds.size === total ? "（唯一）" : "（有重复）"}`);
console.log(`言語知識+読解 解析：${explLangRead}/${langRead} = ${(explLangRead / langRead * 100).toFixed(1)}%`);
console.log(`听力 instruction：${listenInstr}/${listen} = ${(listenInstr / listen * 100).toFixed(1)}%`
  + (listenInstrBad ? `  <-- ${listenInstrBad} 条不是聴解说明（${listenInstrBadVols.size} 卷）` : ""));
if (listenInstrBad)
  fail(`听力 instruction 有 ${listenInstrBad} 条与聴解说明不符（涉及 ${[...listenInstrBadVols].sort().join("、")}）`);
console.log(`听力选项文本未收录（optionsMissing）：${missingOpt} 题（UI 按非计分练习题处理）`);
console.log(`听力无音频文件（第三方源未提供）：${noAudio}/${listen}`);
console.log(`无题干且无指引的题：${noStem}`);
console.log("");
if (warns.length) {
  console.log(`提示 ${warns.length} 条（不影响正确性）：`);
  for (const w of warns.slice(0, 20)) console.log("  · " + w);
  if (warns.length > 20) console.log(`  … 其余 ${warns.length - 20} 条省略`);
  console.log("");
}
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 条：`);
  for (const f of fails) console.log("  · " + f);
  process.exit(1);
}
console.log("✓ 全部检查通过");
