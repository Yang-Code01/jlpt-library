/* 真实考试页逻辑（形态 B） */
(function () {
  "use strict";
  const { S, PART_LABEL, PART_ORDER, loadExam, examSet, records, isCorrect,
          scoreSet, qHTML, canConfirm, pick, resetSession, startTimer, stopTimer, fmtTime,
          isNarrow } = EXAM;
  const EXAMS = ["2023-07", "2023-12"];
  const dataCache = {};
  const state = { screen: "setup", exam: null, month: null, mode: null, sideOpen: false };
  const side = document.getElementById("side");
  const main = document.getElementById("main");

  Promise.all(EXAMS.map(e => loadExam(e))).then(ds => {
    ds.forEach((d, i) => { dataCache[EXAMS[i]] = d; });
    renderSetup();
  });

  // ---------- 设置 ----------
  function renderSetup() {
    side.innerHTML = `
      <h4>年份</h4>
      <div class="pills"><button class="pill on" disabled>2023 <small>已入库</small></button>
      <button class="pill" disabled>2020–2022 <small>待入库</small></button>
      <button class="pill" disabled>2024–2026 <small>待入库</small></button></div>
      <h4>月份</h4>
      <div class="pills">${EXAMS.map(e => {
        const m = +e.slice(5, 7);
        return `<button class="pill ${state.month === m ? "on" : ""}" data-month="${m}">2023.${m}</button>`;
      }).join("")}</div>
      ${state.month ? `<h4>模式</h4>
      <div class="pills">
        <button class="pill ${state.mode === "sim" ? "on" : ""}" data-mode="sim">仿真 <small>155 分钟 · 听力一次</small></button>
        <button class="pill ${state.mode === "relaxed" ? "on" : ""}" data-mode="relaxed">宽松 <small>不限时 · 可回放</small></button>
      </div>` : ""}`;
    side.querySelectorAll("[data-month]").forEach(el => el.onclick = () => {
      state.month = +el.dataset.month; state.mode = null; renderSetup();
    });
    side.querySelectorAll("[data-mode]").forEach(el => el.onclick = () => {
      state.mode = el.dataset.mode; renderSetup();
    });

    if (!state.month || !state.mode) {
      main.innerHTML = `<div class="q-block"><div class="q-stem">在左侧选择月份与模式，开始整卷作答。</div>
        <div class="q-meta">N2 新版（2010–）：言语知识 60 分钟 32 题 · 读解 45 分钟 39 题 · 听力 50 分钟 29 题，共 155 分钟 100 题（本系统作答顺序：听力放最后）。</div></div>`;
      return;
    }
    const e = "2023-" + String(state.month).padStart(2, "0");
    main.innerHTML = `
      <div class="q-block">
        <div class="q-stem"><b>2023.${state.month} N2 整卷</b></div>
        <div class="q-meta">仿真：155 分钟倒计时，听力只播放一次，倒计时结束自动交卷。<br>宽松：不限时，音频可回放，可随时交卷。</div>
        <div class="q-meta" style="margin-top:14px">你选择了：<b>${state.mode === "sim" ? "仿真" : "宽松"}</b></div>
      </div>
      <div style="margin-top:18px;display:flex;gap:10px">
        <button class="btn" id="start">开始考试</button>
        <a class="btn ghost" href="index.html">返回入口</a>
      </div>`;
    document.getElementById("start").onclick = () => {
      state.exam = e;
      S.set = examSet(e);
      resetSession();
      S.mode = "exam";
      S.examMode = state.mode;
      state.screen = "answer";
      state.sideOpen = !isNarrow();
      if (state.mode === "sim") startTimer(155 * 60, () => finish(true));
      renderAnswer();
      window.scrollTo(0, 0);
    };
  }

  // ---------- 答题 ----------
  function renderSide() {
    const d = dataCache[state.exam];
    const q = S.set[S.idx];
    const answered = S.set.filter(x => S.answers[x.id] !== undefined).length;
    // 侧栏题号网格
    let nav = "";
    for (const part of PART_ORDER) {
      const sec = d.meta.parts.find(p => p.part === part);
      const qs = S.set.filter(x => x.part === part);
      nav += `<div class="b-nav-sec"><span>${sec.label}</span><span>${sec.minutes} 分</span></div>
        <div class="b-grid">${qs.map(x => {
          const i = S.set.indexOf(x);
          const cls = ["b-dot", S.answers[x.id] !== undefined ? "answered" : "", x.id === q.id ? "cur" : ""].join(" ");
          return `<div class="${cls}" data-goto="${i}" title="第${x.qNo}题">${x.qNo}</div>`;
        }).join("")}</div>`;
    }
    const tail = state.mode === "sim"
      ? `<h4>剩余时间</h4><div class="b-timer t-timer">${fmtTime(S.remain)}</div>`
      : `<h4>模式</h4><div class="q-meta" style="font-size:12px">宽松 · 不限时</div>`;
    side.innerHTML = `<button class="b-fold" id="fold">
      <span>第 ${S.idx + 1}/${S.set.length} 题 · ${PART_LABEL[q.part]} · 已答 ${answered}</span>
      <span class="b-fold-i">${state.sideOpen ? "收起 ▴" : "题号 ▾"}</span></button>
      <div class="b-fold-body" ${state.sideOpen ? "" : "hidden"}>${nav}${tail}</div>`;
    document.getElementById("fold").onclick = () => { state.sideOpen = !state.sideOpen; renderSide(); };
    side.querySelectorAll("[data-goto]").forEach(el => el.onclick = () => {
      S.idx = +el.dataset.goto;
      if (isNarrow()) state.sideOpen = false; // 跳题后滚顶，顶部应直接是题目
      renderAnswer(); window.scrollTo(0, 0);
    });
  }

  function renderAnswer() {
    renderSide();

    const q = S.set[S.idx];
    main.innerHTML = `
      <div class="q-block">${qHTML(q, { audioOnce: state.mode === "sim" })}</div>
      <div class="b-actions">
        <button class="btn ghost" id="prev" ${S.idx === 0 ? "disabled" : ""}>上一题</button>
        <span class="spacer"></span>
        <button class="btn confirm" id="confirm" ${canConfirm(q) ? "" : "hidden"}>确认答案</button>
        <span style="font-size:13px;color:var(--muted)">${S.idx + 1} / ${S.set.length}</span>
        ${state.mode === "sim" ? `<span class="b-timer t-timer">${fmtTime(S.remain)}</span>` : ""}
        <button class="btn" id="next">${S.idx < S.set.length - 1 ? "下一题" : "交卷"}</button>
      </div>`;
    bindOptions(main);
    document.getElementById("prev").onclick = () => { S.idx--; if (isNarrow()) state.sideOpen = false; renderAnswer(); window.scrollTo(0, 0); };
    // 确认后判定与解析就长在选项下方，滚到顶部反而把它藏起来
    document.getElementById("confirm").onclick = () => { S.locked[q.id] = true; renderAnswer(); };
    document.getElementById("next").onclick = () => {
      if (S.idx < S.set.length - 1) { S.idx++; if (isNarrow()) state.sideOpen = false; renderAnswer(); window.scrollTo(0, 0); }
      else finish(false);
    };
  }

  function bindOptions(root) {
    root.querySelectorAll(".opts").forEach(box => {
      const qid = box.dataset.qid;
      if (box.dataset.locked) return; // 已确认，锁定
      const q = S.set.find(x => x.id === qid);
      box.querySelectorAll(".opt").forEach(el => el.onclick = () => {
        pick(q, box, +el.dataset.idx);
        side.querySelector(`[data-goto="${S.set.indexOf(q)}"]`)?.classList.add("answered");
        document.getElementById("confirm").hidden = !canConfirm(q);
      });
    });
    root.querySelectorAll("audio[data-once]").forEach(a =>
      a.addEventListener("ended", () => a.setAttribute("controls", "controlsdisabled")));
  }

  // ---------- 交卷 / 复盘 ----------
  function finish(auto) {
    stopTimer();
    const sc = scoreSet(S.set, S.answers);
    const month = +state.exam.slice(5, 7);
    records.addExam({ exam: state.exam, month, mode: state.mode,
      score: sc.right, countable: sc.countable, total: sc.countable + sc.nomc,
      nomc: sc.nomc, unanswered: sc.unanswered, auto: !!auto, ts: Date.now() });
    state.screen = "review";
    side.innerHTML = `<h4>2023.${month} N2</h4>
      <div class="q-meta" style="font-size:12px">${state.mode === "sim" ? "仿真模式" : "宽松模式"}${auto ? " · 倒计时结束自动交卷" : ""}</div>
      <div style="margin-top:14px"><a class="btn ghost" href="index.html">回到入口</a></div>`;
    main.innerHTML = `
      <div class="score-hero">
        <div class="sc">${sc.right}<span style="font-size:20px;color:var(--muted)"> / ${sc.countable}</span></div>
        <div class="sc-sub">${auto ? "倒计时结束，自动交卷。" : "已交卷。"} 另有 ${sc.nomc} 道练习模式题（不计分）${sc.unanswered ? ` · 未答 ${sc.unanswered} 题` : ""}</div>
      </div>
      <div id="rlist"></div>
      <div style="margin-top:18px"><button class="btn ghost" id="again">再考一次</button></div>`;
    document.getElementById("rlist").innerHTML = S.set.map(q => reviewItem(q)).join("");
    document.getElementById("again").onclick = () => {
      S.set = examSet(state.exam); resetSession(); S.examMode = state.mode;
      state.screen = "answer";
      state.sideOpen = !isNarrow();
      if (state.mode === "sim") startTimer(155 * 60, () => finish(true));
      renderAnswer(); window.scrollTo(0, 0);
    };
    window.scrollTo(0, 0);
  }

  function reviewItem(q) {
    const a = S.answers[q.id];
    let mark = "未作答";
    if (a !== undefined) {
      const c = isCorrect(q, a);
      mark = c === null ? "练习模式" : (c ? '<span class="r-ok">✓</span>' : '<span class="r-bad">✗</span>');
    }
    return `<div class="review-q"><details>
      <summary><div class="q-head"><span class="q-no">第 ${q.qNo} 题 · ${PART_LABEL[q.part]} 問題${q.problem} · ${q.subType}</span><span>${mark}</span></div></summary>
      <div class="q-body">${qHTML(q, { review: true })}</div></details></div>`;
  }
})();