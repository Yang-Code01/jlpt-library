// 生成真题数据：cleaned（.scratch/jlpt-exam/materials/cleaned）→ exam/data/N2/*.js + manifest.json
// 题干/文章会从 quiz-platform 源（papers/）找回下划线标记 **词**（清洗时被剥掉）。
// 以后每加一卷：往 cleaned/ 放 <exam>-text.json / <exam>-listening.json（格式同现有），
// papers/<exam>/ 放 quiz JSON，复制音频到 exam/data/N2/audio/，把 exam 加进下面 EXAMS 数组，然后 node gen-exam-data.js
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const clean = path.join(root, ".scratch", "jlpt-exam", "materials", "cleaned");
const papers = path.join(root, ".scratch", "jlpt-exam", "materials", "papers");
const outDir = path.join(__dirname, "data", "N2");
const EXAMS = ["2023-07", "2023-12"];

const SUBTYPE_TEXT = {
  1: "汉字读音", 2: "汉字书写", 3: "汉字接续", 4: "语词选择", 5: "语词意义", 6: "语词用法",
  7: "文法填空", 8: "文法排序",
  9: "读解·整体理解", 10: "读解·短文章", 11: "读解·长文章", 12: "读解·意见A/B", 13: "读解·本文", 14: "读解·公告表格"
};
const SUBTYPE_L = { 1: "听力·短对话Ⅰ", 2: "听力·短对话Ⅱ", 3: "听力·短独白", 4: "听力·情境应答", 5: "听力·长篇" };
const PART_OF_TEXT = no => no <= 8 ? "lang" : "reading";

// ---------- 找回下划线标记 ----------
// quiz-platform 源里用 **词** 标记原文下划线（问题 1/2/5/8 题干、读解 10/11/13 文章与题干），
// 清洗时被剥掉了。两道保险的恢复策略，任一失败则原样保留（不猜）：
//   A 整段定位：cleaned 文本（去 ** 去空白）是源文本的连续子串 → 按字符映射贴回；
//   B 短语定位：源里每个 **X** 短语在 cleaned 文本中唯一命中 → 包裹该短语。
const norm = s => (s || "").replace(/\*\*/g, "").replace(/\s+/g, "");
function phraseRestore(cleanText, sourceText) {
  if (!cleanText || !sourceText) return cleanText;
  const re = /\*\*([^*]+)\*\*/g;
  let m; const spans = [];
  while ((m = re.exec(sourceText))) { const n = norm(m[1]); if (n) spans.push(n); }
  spans.sort((a, b) => b.length - a.length);
  if (!spans.length) return cleanText;
  const nc = norm(cleanText);
  const used = new Array(cleanText.length).fill(false);
  const marks = [];
  for (const nsp of spans) {
    const occ = [];
    let i = 0;
    while ((i = nc.indexOf(nsp, i)) >= 0) { occ.push(i); i += nsp.length; }
    if (occ.length !== 1) continue; // 唯一命中才贴
    let ci = 0, start = -1, end = -1;
    for (let k = 0; k < cleanText.length; k++) {
      if (/\s/.test(cleanText[k])) continue;
      if (ci === occ[0]) start = k;
      if (ci === occ[0] + nsp.length - 1) { end = k; break; }
      ci++;
    }
    if (start < 0 || end < 0) continue;
    let overlap = false;
    for (let k = start; k <= end; k++) if (used[k]) { overlap = true; break; }
    if (overlap) continue;
    for (let k = start; k <= end; k++) used[k] = true;
    marks.push({ start, end });
  }
  if (!marks.length) return cleanText;
  let out = "";
  for (let k = 0; k < cleanText.length; k++) {
    if (marks.some(x => x.start === k)) out += "**";
    out += cleanText[k];
    if (marks.some(x => x.end === k)) out += "**";
  }
  return out;
}
function restoreMarks(cleanText, sourceText) {
  if (!cleanText || !sourceText) return cleanText;
  const src = sourceText;
  // A: 整段定位
  const ns = []; const inStar = [];
  let star = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "*") {
      if (i + 1 < src.length && src[i + 1] === "*") { star = !star; i++; continue; }
      continue;
    }
    if (/\s/.test(c)) continue;
    ns.push(c); inStar.push(star);
  }
  const nc = norm(cleanText);
  const pos = ns.join("").indexOf(nc);
  if (pos >= 0) {
    let out = ""; let ci = 0; let open = false;
    for (let i = 0; i < cleanText.length; i++) {
      const c = cleanText[i];
      if (/\s/.test(c)) {
        if (open) { out += "**"; open = false; }
        out += c; continue;
      }
      const st = inStar[pos + ci];
      if (st && !open) { out += "**"; open = true; }
      if (!st && open) { out += "**"; open = false; }
      out += c; ci++;
    }
    if (open) out += "**";
    return out;
  }
  // B: 短语定位
  return phraseRestore(cleanText, src);
}
function restoreMarks(cleanText, sourceText) {
  if (!cleanText || !sourceText) return cleanText;
  const src = sourceText;
  // A: 整段定位
  const ns = []; const inStar = [];
  let star = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "*") {
      if (i + 1 < src.length && src[i + 1] === "*") { star = !star; i++; continue; }
      continue;
    }
    if (/\s/.test(c)) continue;
    ns.push(c); inStar.push(star);
  }
  const nc = norm(cleanText);
  const pos = ns.join("").indexOf(nc);
  if (pos >= 0) {
    let out = ""; let ci = 0; let open = false;
    for (let i = 0; i < cleanText.length; i++) {
      const c = cleanText[i];
      if (/\s/.test(c)) {
        if (open) { out += "**"; open = false; }
        out += c; continue;
      }
      const st = inStar[pos + ci];
      if (st && !open) { out += "**"; open = true; }
      if (!st && open) { out += "**"; open = false; }
      out += c; ci++;
    }
    if (open) out += "**";
    return out;
  }
  // B: 短语定位
  return phraseRestore(cleanText, src);
}

function loadQuiz(exam) {
  const year = exam.slice(0, 4), month = exam.slice(5, 7);
  const f = path.join(papers, exam, `quiz-${year}年${+month}月-N2.json`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function convert(exam) {
  const t = JSON.parse(fs.readFileSync(path.join(clean, exam + "-text.json"), "utf8"));
  const l = JSON.parse(fs.readFileSync(path.join(clean, exam + "-listening.json"), "utf8"));
  const quiz = loadQuiz(exam);
  const year = +exam.slice(0, 4), month = +exam.slice(5, 7);
  const passages = {};
  const questions = [];

  for (const p of t.problems) {
    const part = PART_OF_TEXT(p.no);
    const subType = SUBTYPE_TEXT[p.no];
    const sec = quiz.sections[p.no - 1];
    const secSrc = sec ? [sec.article || "", ...sec.groups.map(g => g.content || "")].join("\n") : null;
    for (const it of p.items) {
      let pkey = null, text = it.passage;
      if (p.no === 12) {
        passages["p12"] = "【A】" + restoreMarks(it.passages.A, sec.article || null) + "\n\n【B】" + restoreMarks(it.passages.B, sec.article || null);
        pkey = "p12";
      } else if (text) {
        pkey = "p" + p.no + (it.label ? "_" + it.label.replace(/[（）]/g, "") : "");
        passages[pkey] = restoreMarks(text, secSrc);
      }
      const qs = it.questions || [it];
      for (const q of qs) {
        questions.push({
          id: `n2-${exam}-${part === "lang" ? "L" : "R"}${p.no}-${q.q || q.no}`,
          part, problem: p.no, qNo: q.q || q.no, subType,
          instruction: p.instruction || null,
          passage: pkey,
          prompt: null,
          question: restoreMarks(q.question, secSrc),
          options: q.options, optionsMissing: false,
          answer: q.answer,
          subAnswers: null,
          audio: null, transcript: null,
          explanation: q.explanation || null,
          optionNotes: q.optionNotes || null,
          optionNotes: q.optionNotes || null,
          translation: q.translation || null,
          source: q.source || `2023.${month} N2 問題${p.no}`
        });
      }
    }
  }
  for (const it of l.items) {
    questions.push({
      id: `n2-${exam}-H${it.part}-${it.qNo}`,
      part: "listening", problem: it.part, qNo: it.qNo,
      subType: SUBTYPE_L[it.part],
      instruction: null, passage: null,
      prompt: it.prompt,
      question: it.question || (it.question2 ? it.question + " / " + it.question2 : null),
      options: it.options, optionsMissing: !!it.optionsMissing,
      answer: it.answer,
      subAnswers: it.subAnswers || null,
      audio: it.audioFile, transcript: it.script,
      explanation: null, translation: null,
      source: it.source
    });
  }

  return {
    meta: {
      level: "N2", exam, year, month, version: "新版(2010–)",
      totalMinutes: 155,
      parts: [
        { part: "lang", label: "言语知识", minutes: 60, problems: [1, 2, 3, 4, 5, 6, 7, 8] },
        { part: "reading", label: "读解", minutes: 45, problems: [9, 10, 11, 12, 13, 14] },
        { part: "listening", label: "听力", minutes: 50, problems: [1, 2, 3, 4, 5] }
      ],
      totalQuestions: questions.length
    },
    passages,
    questions
  };
}

fs.mkdirSync(outDir, { recursive: true });
for (const exam of EXAMS) {
  const d = convert(exam);
  const f = path.join(outDir, exam + ".js");
  fs.writeFileSync(f, `/* 自动生成：node gen-exam-data.js（源：cleaned + quiz-platform 下划线标记） */\nwindow.EXAM_${exam.replace("-", "_")} = ${JSON.stringify(d)};\n`, "utf8");
  console.log(exam, "| questions:", d.questions.length,
    "| passages:", Object.keys(d.passages).length,
    "| optionsMissing:", d.questions.filter(q => q.optionsMissing).length,
    "|", fs.statSync(f).size, "bytes");
}
fs.writeFileSync(path.join(outDir, "manifest.json"),
  JSON.stringify({ N2: { exams: EXAMS } }, null, 2), "utf8");
console.log("manifest.json written");