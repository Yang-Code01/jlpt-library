/* 真题模块共享核心（形态 B）：数据加载 / 题目渲染 / 评分 / 记录 / 计时 */
"use strict";

const EXAM = (() => {
  const PART_LABEL = { listening: "听力", lang: "言语知识", reading: "读解" };
  // 作答顺序：听力放最后（用户决定 2025-07）
  const PART_ORDER = ["lang", "reading", "listening"];
  const LS_EXAM = "jlpt_exam_records";      // [{exam,mode,score,total,nomc,ts}]
  const LS_PRACTICE = "jlpt_practice_records"; // {subType: {count, last}}

  // ---------- 数据加载 ----------
  // 题库以密文存放（data/N2/enc/*.js），由 EXAM_LOCK 解密还原。
  // 解出来的对象与原先的 window.EXAM_<卷> 完全同形，所以本文件下游
  // （渲染 / 评分 / 记录 / 区间播放）不需要知道加密这回事。
  // 仍然走 script 注入而非 fetch，本地 file:// 直接打开依然可用。
  const cache = {};
  function lockMod() {
    if (!window.EXAM_LOCK) throw new Error("解锁模块未加载（exam-lock.js）");
    return window.EXAM_LOCK;
  }
  function loadExam(exam) { // exam: "2023-12"
    if (cache[exam]) return Promise.resolve(cache[exam]);
    return lockMod()
      .load("data/N2/enc/" + exam + ".js", "EXAM_ENC_" + exam.replace(/-/g, "_"), exam)
      .then((d) => {
        if (!d) throw new Error("no data: " + exam);
        cache[exam] = d;
        return d;
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
  // ---------- 轻量索引（题型专练页用） ----------
  // 30 卷全量有 6 MB，只为「有哪些题型、各多少题」而全量加载不划算。
  // index-lite 只含 {typePart, exams:{exam:{total,types}}}，压缩加密后不到 1 KB，
  // 同样以密文存放（enc/index.js）——它也属于该藏起来的信息。
  let indexCache = null;
  function loadIndex() {
    if (indexCache) return Promise.resolve(indexCache);
    return lockMod()
      .load("data/N2/enc/index.js", "EXAM_ENC_INDEX_LITE", "index-lite")
      .then((d) => {
        if (!d) throw new Error("no index");
        indexCache = d;
        return d;
      });
  }
  // 只加载「含该题型」的卷，再按 exams 给定顺序取池。排序与全量 poolOf 完全一致：
  // 传入的 exams 已是时间序，而 poolOf 就是按 exams 顺序遍历。
  function poolOfLazy(exams, index, subType) {
    const need = exams.filter(e => index.exams[e] && index.exams[e].types[subType]);
    return Promise.all(need.map(loadExam)).then(() => poolOf(need, subType));
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
  // 专练记录以题型名当键。2026-09-27 统一题型命名后，旧名的记录若不迁移，
  // 就会和新名的记录裂成两条、累计题量被拆散——正是这次统一要消灭的问题，
  // 所以在读取时顺手并进新键（迁移后旧键即消失，不会重复累加）。
  const LEGACY_SUBTYPE = {
    "汉字接续": "语词形成",
    "听力·短对话Ⅰ": "听力·课题理解",
    "听力·短对话Ⅱ": "听力·要点理解",
    "听力·短独白": "听力·概要理解",
    "听力·情境应答": "听力·即时应答",
    "听力·长篇": "听力·综合理解",
    "读解·意见A/B": "读解·意见AB",
    "读解·整体理解": "文章文法"
  };
  const records = {
    examAll() { return lsGet(LS_EXAM, []); },
    addExam(r) { const a = this.examAll(); a.unshift(r); lsSet(LS_EXAM, a.slice(0, 50)); },
    practiceAll() {
      const p = lsGet(LS_PRACTICE, {});
      let dirty = false;
      for (const oldName of Object.keys(LEGACY_SUBTYPE)) {
        const from = p[oldName];
        if (!from) continue;
        const to = p[LEGACY_SUBTYPE[oldName]] || { count: 0, last: 0 };
        to.count += from.count || 0;
        to.last = Math.max(to.last || 0, from.last || 0);
        p[LEGACY_SUBTYPE[oldName]] = to;
        delete p[oldName];
        dirty = true;
      }
      if (dirty) lsSet(LS_PRACTICE, p);
      return p;
    },
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

  // 部分阅读文章在数据源里只提供图片（如 2012-07 問題10 第2篇、問題14 的表格），
  // 抓取时以这个哨兵值占位。渲染成一条说明，而不是把哨兵当正文显示出来。
  const IMG_PASSAGE = "[图片文章]";

  // 填空型阅读题（問題9 / 文章文法·整体理解）的 question 是 "(1)" 这类空位标记或空串，
  // 单独显示没有信息量，统一转成一句可读的题干：「文章の（1）に入る最もよいものはどれか。」
  // 只在「有文章的阅读填空题型」上生效；听力/其他题型的空题干有各自的处理，绝不套用。
  const FILL_TYPES = /文章文法|整体理解/;
  function fillStem(q) {
    if (q.part !== "reading" || !FILL_TYPES.test(q.subType || "")) return "";
    const raw = String(q.question == null ? "" : q.question).trim();
    const m = raw.match(/^[（(]\s*(\d+)\s*[)）]$/);
    // 优先用 question 里的空位编号；question 为空串时（如 2011-07 的 R9）退回整卷题号
    let no = m ? m[1] : (raw === "" ? String(q.qNo) : null);
    if (no == null || !/^\d+$/.test(no)) return "";
    return `文章の（${no}）に入る最もよいものはどれか。`;
  }

  function qHTML(q, opts = {}) {
    const { review = false, audioOnce = false } = opts;
    const d = cache[examKeyOf(q)];
    const h = [];
    h.push(`<div class="q-head"><span class="q-no">第 ${q.qNo} 题</span><span class="q-tag">${PART_LABEL[q.part]} · 問題${q.problem} · ${q.subType}</span></div>`);
    // 题型说明（问题N 的官方指令）。原先不渲染，导致听力题只剩选项、看不出在问什么。
    if (q.instruction) h.push(`<div class="q-inst">${esc(q.instruction)}</div>`);
    if (q.prompt) h.push(`<div class="q-prompt">${mk(q.prompt)}</div>`);
    if (q.passage === IMG_PASSAGE) {
      h.push(`<div class="q-nostem">本题的文章/表格在原卷中以图片形式给出，本站数据源未提供文字版，请结合题干与选项作答。</div>`);
    } else if (q.passage && d.passages && d.passages[q.passage]) {
      h.push(`<div class="q-passage">${mk(d.passages[q.passage])}</div>`);
    } else if (q.passage) {
      h.push(`<div class="q-passage">${mk(q.passage)}</div>`);
    }
    // 填空型先把 "(1)"/空串替换成可读题干；其余题型照用 question
    const fill = fillStem(q);
    const stem = fill || q.question || "";
    if (stem) h.push(`<div class="q-stem">${mk(stem)}</div>`);
    // 听力题的作答指引。缺对话场景描述（免费数据源只给选项+答案）时，给一条明确的
    // 作答指引，不编造原文。注意：许多卷（第三方数据源）根本没有音频文件，此时若仍
    // 提示「请先听音频」，会让人去找一段不存在的音频——必须区分这两种情况。
    if (q.part === "listening" && q.options) {
      const lacksStem = !q.prompt && !q.question;
      if (!q.audio) {
        h.push(`<div class="q-nostem">本题听力音频本站暂未收录（数据源未提供），请结合题型说明与选项作答；确认答案后可直接查看解析。</div>`);
      } else if (lacksStem) {
        h.push(`<div class="q-nostem">本题为听力题：请先听音频，再从下方 1–4 选项中选出最合适的答案。</div>`);
      }
    }
    if (q.audio) {
      // 区间播放：官方每 Part 一个大文件，靠 audioRange 定位到本题。2023 等已有 per-question 文件的卷无 audioRange，走普通整文件播放。
      const rangeAttr = q.audioRange
        ? ` data-range-start="${q.audioRange[0]}" data-range-end="${q.audioRange[1]}"`
        : "";
      h.push(`<div class="audio-box"><audio controls ${audioOnce ? 'data-once="1"' : ""}${rangeAttr} src="data/N2/audio/${q.audio}"></audio>${audioOnce ? '<div class="q-meta">仿真模式：本段音频只播放一次</div>' : ""}</div>`);
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

  // 区间播放：官方每 Part 一个大文件，靠 data-range-* 定位到本题。
  // 点击播放时跳到区间起点；播放到区间终点自动暂停。无 data-range-* 的音频（如 2023 per-question 文件）不受影响。
  (function bindRangeAudio() {
    document.addEventListener("play", (e) => {
      const a = e.target;
      if (a && a.dataset && a.dataset.rangeStart !== undefined) {
        const s = parseFloat(a.dataset.rangeStart);
        const en = parseFloat(a.dataset.rangeEnd);
        const once = a.dataset.once === "1";
        // 仿真模式(once)播完即停、不可重播；练习模式播到区间尾再点播放则回到起点重播
        if (a.currentTime < s - 0.15 || (a.currentTime >= en && !once)) a.currentTime = s;
      }
    }, true);
    document.addEventListener("timeupdate", (e) => {
      const a = e.target;
      if (a && a.dataset && a.dataset.rangeStart !== undefined) {
        const en = parseFloat(a.dataset.rangeEnd);
        if (a.currentTime >= en) { try { a.pause(); } catch (_) {} a.currentTime = en; }
      }
    }, true);
  })();

  return { S, PART_LABEL, PART_ORDER, loadExam, loadIndex, allQuestions, poolOf, poolOfLazy,
           examSet, shuffle,
           records, isCorrect, scoreSet, esc, mk, examKeyOf, qHTML, canConfirm, pick,
           resetSession, stopTimer, startTimer, fmtTime, isNarrow };
})();