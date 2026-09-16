/* 真题模块共享核心（形态 B）：数据加载 / 题目渲染 / 评分 / 记录 / 计时 */
"use strict";

const EXAM = (() => {
  const PART_LABEL = { listening: "听力", lang: "言语知识", reading: "读解" };
  // 作答顺序：听力放最后（用户决定 2025-07）
  const PART_ORDER = ["lang", "reading", "listening"];
  const LS_EXAM = "jlpt_exam_records";      // [{exam,mode,score,total,nomc,ts}]
  const LS_PRACTICE = "jlpt_practice_records"; // {subType: {count, last}}

  // ---------- 数据加载（script 注入，file:// 可用） ----------
  const cache = {};
  function loadExam(exam) { // exam: "2023-12"
    if (cache[exam]) return Promise.resolve(cache[exam]);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "data/N2/" + exam + ".js";
      s.onload = () => {
        const d = window["EXAM_" + exam.replace("-", "_")];
        if (!d) return reject(new Error("no data: " + exam));
        cache[exam] = d;
        resolve(d);
      };
      s.onerror = () => reject(new Error("load failed: " + exam));
      document.head.appendChild(s);
    });
  }
  function allQuestions(exams) {
    const out = [];
    for (const k of exams) for (const q of cache[k].questions) out.push(q);
    return out;
  }
  function poolOf(exams, subType) {
    return allQuestions(exams).filter(q => q.subType === subType);
  }
  function examSet(exam) {
    const d = cache[exam];
    const order = { lang: 0, reading: 1, listening: 2 };
    return d.questions.slice().sort((a, b) => order[a.part] - order[b.part] || a.problem - b.problem || a.qNo - b.qNo);
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // ---------- 记录 ----------
  function lsGet(key, dft) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? dft : v; } catch (e) { return dft; }
  }
  function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  const records = {
    examAll() { return lsGet(LS_EXAM, []); },
    addExam(r) { const a = this.examAll(); a.unshift(r); lsSet(LS_EXAM, a.slice(0, 50)); },
    practiceAll() { return lsGet(LS_PRACTICE, {}); },
    addPractice(subType, n) {
      const p = this.practiceAll();
      const e = p[subType] || { count: 0, last: 0 };
      e.count += n; e.last = Date.now();
      p[subType] = e;
      lsSet(LS_PRACTICE, p);
    }
  };

  // ---------- 判定 / 计分 ----------
  function isCorrect(q, ans) {
    if (q.subAnswers) return ans && ans.q1 === q.subAnswers.q1 && ans.q2 === q.subAnswers.q2;
    if (q.optionsMissing) return null;
    return ans === q.answer;
  }
  function scoreSet(set, answers) {
    let right = 0, countable = 0, nomc = 0, unanswered = 0;
    for (const q of set) {
      const a = answers[q.id];
      if (q.subAnswers) { if (a) { countable++; if (isCorrect(q, a)) right++; } else unanswered++; }
      else if (q.optionsMissing) { nomc++; if (a !== undefined) right += isCorrect(q, a) ? 1 : 0; }
      else if (a !== undefined) { countable++; if (isCorrect(q, a)) right++; }
      else unanswered++;
    }
    return { right, countable, nomc, unanswered };
  }

  // ---------- 渲染 ----------
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  // 渲染下划线标记：**词** → <span class="u-mark">词</span>（先转义再替换，内容安全）
  function mk(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<span class="u-mark">$1</span>'); }
  function examKeyOf(q) { return q.id.match(/^n2-(\d{4}-\d{2})/)[1]; }

  function qHTML(q, opts = {}) {
    const { review = false, audioOnce = false } = opts;
    const d = cache[examKeyOf(q)];
    const h = [];
    h.push(`<div class="q-head"><span class="q-no">第 ${q.qNo} 题</span><span class="q-tag">${PART_LABEL[q.part]} · 問題${q.problem} · ${q.subType}</span></div>`);
    if (q.prompt) h.push(`<div class="q-prompt">${mk(q.prompt)}</div>`);
    if (q.passage && d.passages[q.passage]) h.push(`<div class="q-passage">${mk(d.passages[q.passage])}</div>`);
    if (q.question) h.push(`<div class="q-stem">${mk(q.question)}</div>`);
    if (q.audio) {
      h.push(`<div class="audio-box"><audio controls ${audioOnce ? 'data-once="1"' : ""} src="data/N2/audio/${q.audio}"></audio>${audioOnce ? '<div class="q-meta">仿真模式：本段音频只播放一次</div>' : ""}</div>`);
    }
    if (q.options) {
      const locked = review || !!S.locked[q.id];
      h.push(`<div class="opts" data-qid="${q.id}" ${locked ? 'data-locked="1"' : ""}>`);
      q.options.forEach((o, i) => {
        const a = S.answers[q.id];
        let sel = (a === i + 1 || (a && typeof a === "object" && a.q1 === i + 1)) && !review;
        // 确认/复盘后标出正确答案与错选
        let cls = "";
        if (review || (S.locked[q.id] && !q.optionsMissing)) {
          if (i + 1 === q.answer) cls = "correct";
          else if (a === i + 1 || (a && typeof a === "object" && a.q1 === i + 1)) cls = "wrong";
        }
        h.push(`<div class="opt ${sel ? "on" : ""} ${cls}" data-idx="${i + 1}"><span class="o-idx">${i + 1}</span><span>${esc(o)}</span></div>`);
      });
      h.push(`</div>`);
      if (q.subAnswers) {
        const a = S.answers[q.id];
        const done = a && a.q1 !== undefined && a.q2 !== undefined;
        h.push(`<div class="q-meta">本题含两个小问：先点选第一问答案，再点选第二问答案，然后点「确认」。${done ? "（已选 2/2）" : ""}</div>`);
      }
      if ((review || S.locked[q.id]) && !q.optionsMissing) {
        const a = S.answers[q.id];
        const c = isCorrect(q, a);
        const verdict = a === undefined
          ? `<span class="r-bad">未确认</span>`
          : (c ? '<span class="r-ok">✓ 回答正确</span>' : '<span class="r-bad">✗ 回答错误</span>');
        h.push(`<div class="q-verdict">${verdict}　正确答案：<b>${q.subAnswers ? `小问 1 → ${q.subAnswers.q1}，小问 2 → ${q.subAnswers.q2}` : q.answer}</b></div>`);
        if (q.explanation || q.optionNotes) {
          h.push(`<div class="q-explain open"><div class="q-explain-h">解析</div>`);
          if (q.optionNotes && Object.keys(q.optionNotes).length) {
            // 逐选项展示：错项用自编 optionNotes，正确项用原有 explanation
            q.options.forEach((o, i) => {
              const n = i + 1;
              const note = q.optionNotes[n] || (n === q.answer ? q.explanation : null);
              if (!note) return;
              h.push(`<div class="opt-note${n === q.answer ? " ok" : ""}"><span class="o-idx">${n}</span><span class="opt-text">${esc(o)}</span><span class="opt-why">${esc(note)}</span></div>`);
            });
            h.push(`<div class="q-meta">错项解析为自编教学内容，仅供参考。</div>`);
          } else {
            h.push(esc(q.explanation));
          }
          if (q.translation) h.push(`<div class="q-trans">参考译文：${esc(q.translation)}</div>`);
          h.push(`</div>`);
        }
      }
    } else {
      h.push(`<div class="nomc">练习模式：本题选项暂缺（待补全）。请听音频、对照原文与题干作答后核对答案。</div>`);
    }
    if (review) {
      const a = S.answers[q.id];
      if (q.optionsMissing) {
        h.push(`<div class="q-meta">正确答案：<b>${q.answer}</b>${a !== undefined ? "（已核对）" : ""}</div>`);
      }
      if (q.transcript) h.push(`<details class="transcript"><summary style="cursor:pointer;color:var(--muted)">听力原文</summary><div>${esc(q.transcript)}</div></details>`);
      h.push(`<div class="q-meta">${esc(q.source)}</div>`);
    }
    return h.join("");
  }

  // 共享会话状态（页面各自驱动）
  const S = { set: [], answers: {}, locked: {}, idx: 0, mode: null, examMode: null, subType: null, timer: null, remain: 0 };
  function resetSession() { S.answers = {}; S.locked = {}; S.idx = 0; stopTimer(); }

  function canConfirm(q) {
    const a = S.answers[q.id];
    return !!q.options && !S.locked[q.id] && (q.subAnswers
      ? !!(a && a.q1 !== undefined && a.q2 !== undefined)
      : a !== undefined && !q.optionsMissing);
  }

  // 记一次作答并就地重绘选项：整块重渲染会把窗口滚动位置、音频进度、原文滚动位置一起清掉
  function pick(q, box, idx) {
    if (q.subAnswers) {
      const cur = S.answers[q.id] || {};
      if (cur.q1 === undefined) cur.q1 = idx; else cur.q2 = idx;
      S.answers[q.id] = cur;
    } else S.answers[q.id] = idx;
    const a = S.answers[q.id];
    box.querySelectorAll(".opt").forEach(el => {
      const i = +el.dataset.idx;
      el.classList.toggle("on", a === i || (a && typeof a === "object" && a.q1 === i));
    });
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
  function startTimer(totalSec, onDone) {
    stopTimer();
    S.remain = totalSec;
    const draw = () => {
      S.remain--;
      document.querySelectorAll(".t-timer").forEach(el => el.textContent = fmtTime(S.remain));
      if (S.remain <= 0) { stopTimer(); onDone && onDone(); }
    };
    draw();
    S.timer = setInterval(draw, 1000);
  }
  function fmtTime(s) {
    const m = Math.floor(s / 60), r = s % 60;
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }
  // 与 exam.css 的 800px 断点保持一致：窄屏单列布局下侧栏会压在题目上方
  const isNarrow = () => matchMedia("(max-width: 800px)").matches;

  return { S, PART_LABEL, PART_ORDER, loadExam, allQuestions, poolOf, examSet, shuffle,
           records, isCorrect, scoreSet, esc, mk, examKeyOf, qHTML, canConfirm, pick,
           resetSession, stopTimer, startTimer, fmtTime, isNarrow };
})();