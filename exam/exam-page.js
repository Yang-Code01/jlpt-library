/* 真实考试页逻辑（形态 B） */
(function () {
  "use strict";
  const { S, PART_LABEL, PART_ORDER, loadExam, examSet, records, isCorrect,
          scoreSet, qHTML, canConfirm, pick, resetSession, startTimer, stopTimer, fmtTime,
          isNarrow, esc } = EXAM;
  const EXAMS = ["2010-07", "2010-12", "2011-07", "2011-12", "2012-07", "2012-12", "2013-07", "2013-12",
                 "2014-07", "2014-12", "2015-07", "2015-12", "2016-07", "2016-12", "2017-07",
                 "2017-12", "2018-07", "2018-12", "2019-07", "2019-12", "2020-12", "2021-07",
                 "2021-12", "2022-07", "2022-12", "2023-07", "2023-12", "2024-07", "2024-12",
                 "2025-07"];
  // 目前只有 N2 入库；其余等级占位显示，避免误以为「资料库没有年份」
  const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
  const LEVEL = "N2";
  // 首屏不需要任何试卷数据：年份/月份由上面的 EXAMS 常量算出，卷内 meta 等真正开始作答时再取。
  // 于是打开本页只拉 3 个 JS 文件，而不是 30 卷约 6.0 MB。
  const state = { screen: "setup", exam: null, year: null, month: null, mode: null, sideOpen: false, meta: null };
  const side = document.getElementById("side");
  const main = document.getElementById("main");

  // 进入页面补一个初始状态，浏览器返回键才有"上一屏"可退
  try { history.replaceState({ jlpt: "setup" }, ""); } catch (_) {}
  renderSetup();

  // ---------- 浏览器返回键：从答题/复盘退回设置屏 ----------
  // 开始考试时往历史里压一条 {jlpt:"answer"}；此时历史 = [..., setup, answer]。
  // 按浏览器返回键 → 回到 setup，界面同步为设置屏。再按一次才真正离开本页。
  function pushScreen(name) {
    try { history.pushState({ jlpt: name }, ""); } catch (_) {}
  }
  window.addEventListener("popstate", () => {
    // 只要落在"设置"这一层，就把界面切回设置屏
    state.screen = "setup";
    state.sideOpen = false;
    stopTimer();
    renderSetup();
    window.scrollTo(0, 0);
  });

  // ---------- 设置 ----------
  function levelPills() {
    return `<h4>等级</h4><div class="pills">${LEVELS.map(lv =>
      `<button class="pill ${lv === LEVEL ? "on" : ""}" data-lv="${lv}" ${lv !== LEVEL ? "disabled" : ""}>${lv}${lv !== LEVEL ? " <small>待入库</small>" : ""}</button>`).join("")}</div>`;
  }

  function renderSetup() {
    const years = [...new Set(EXAMS.map(e => +e.slice(0, 4)))].sort();
    const monthsOf = y => EXAMS.filter(e => +e.slice(0, 4) === y).map(e => +e.slice(5, 7)).sort((a, b) => a - b);
    side.innerHTML = `
      ${levelPills()}
      <h4>年份</h4>
      <div class="pills">${years.map(y =>
        `<button class="pill ${state.year === y ? "on" : ""}" data-year="${y}">${y}</button>`).join("")}</div>
      <h4>月份</h4>
      <div class="pills">${(state.year ? monthsOf(state.year) : []).map(m =>
        `<button class="pill ${state.month === m ? "on" : ""}" data-month="${m}">${state.year}.${m}</button>`).join("")}</div>
      ${state.month ? `<h4>模式</h4>
      <div class="pills">
        <button class="pill ${state.mode === "sim" ? "on" : ""}" data-mode="sim">仿真 <small>155 分钟 · 听力一次</small></button>
        <button class="pill ${state.mode === "relaxed" ? "on" : ""}" data-mode="relaxed">宽松 <small>不限时 · 可回放</small></button>
      </div>` : ""}`;
    side.querySelectorAll("[data-year]").forEach(el => el.onclick = () => {
      state.year = +el.dataset.year; state.month = null; state.mode = null; renderSetup();
    });
    side.querySelectorAll("[data-month]").forEach(el => el.onclick = () => {
      state.month = +el.dataset.month; state.mode = null; renderSetup();
    });
    side.querySelectorAll("[data-mode]").forEach(el => el.onclick = () => {
      state.mode = el.dataset.mode; renderSetup();
    });

    if (!state.year || !state.month || !state.mode) {
      main.innerHTML = `<div class="q-block"><div class="q-stem">在左侧选择年份、月份与模式，开始整卷作答。</div>
        <div class="q-meta">N2 已入库 30 卷（2010.7 – 2025.7）。N1 / N3 / N4 / N5 待入库。</div>
        <div class="q-meta">言语知识 60 分钟 · 读解 45 分钟 · 听力 50 分钟，共 155 分钟（本系统作答顺序：听力放最后）。</div></div>`;
      return;
    }
    const e = state.year + "-" + String(state.month).padStart(2, "0");
    main.innerHTML = `
      <div class="q-block">
        <div class="q-stem"><b>${state.year}.${state.month} N2 整卷</b></div>
        <div class="q-meta">仿真：155 分钟倒计时，听力只播放一次，倒计时结束自动交卷。<br>宽松：不限时，音频可回放，可随时交卷。</div>
        <div class="q-meta" style="margin-top:14px">你选择了：<b>${state.mode === "sim" ? "仿真" : "宽松"}</b></div>
      </div>
      <div style="margin-top:18px;display:flex;gap:10px">
        <button class="btn" id="start">开始考试</button>
        <a class="btn ghost" href="index.html">返回入口</a>
      </div>`;
    const startBtn = document.getElementById("start");
    startBtn.onclick = async () => {
      if (startBtn.dataset.busy) return;               // 防重复点击
      startBtn.dataset.busy = "1";
      const idleLabel = startBtn.textContent;
      startBtn.disabled = true;
      startBtn.textContent = "加载本卷…";
      let d;
      try {
        d = await loadExam(e);                          // 此刻才拉这一卷的数据
      } catch (err) {
        startBtn.disabled = false;
        startBtn.textContent = idleLabel;
        delete startBtn.dataset.busy;
        startBtn.insertAdjacentHTML("afterend",
          `<div class="q-meta" style="color:var(--accent-ink);margin-top:10px">本卷数据加载失败：${esc(String(err && err.message || err))}</div>`);
        return;
      }
      state.exam = e;
      state.meta = d.meta;
      S.set = examSet(e);
      resetSession();
      S.mode = "exam";
      S.examMode = state.mode;
      state.screen = "answer";
      state.sideOpen = !isNarrow();
      pushScreen("answer");   // 记一层历史：浏览器返回键从答题屏退回设置屏
      if (state.mode === "sim") startTimer(155 * 60, () => finish(true));
      renderAnswer();
      window.scrollTo(0, 0);
    };
  }

  // ---------- 答题 ----------
  function renderSide() {
    const meta = state.meta;   // 进入答题屏前必然已加载（start 里 await 过）
    const q = S.set[S.idx];
    const answered = S.set.filter(x => S.answers[x.id] !== undefined).length;
    // 侧栏题号网格
    let nav = "";
    for (const part of PART_ORDER) {
      const sec = (meta.parts.find(p => p.part === part)) || { label: PART_LABEL[part], minutes: "—" };
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
        <button class="btn ghost" id="back">‹ 返回</button>
        <button class="btn ghost" id="prev" ${S.idx === 0 ? "disabled" : ""}>上一题</button>
        <span class="spacer"></span>
        <button class="btn confirm" id="confirm" ${canConfirm(q) ? "" : "hidden"}>确认答案</button>
        <span style="font-size:13px;color:var(--muted)">${S.idx + 1} / ${S.set.length}</span>
        ${state.mode === "sim" ? `<span class="b-timer t-timer">${fmtTime(S.remain)}</span>` : ""}
        <button class="btn" id="next">${S.idx < S.set.length - 1 ? "下一题" : "交卷"}</button>
      </div>`;
    bindOptions(main);
    // 返回上一层：回到选卷设置屏，而不是直接跳出本模块
    document.getElementById("back").onclick = () => backToSetup();
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

  // 回到上一层（选卷设置屏），保留已选年份/月份/模式。
  // 优先走 history.back()，让 popstate 统一处理（页内按钮与浏览器返回键行为一致、
  // 历史栈也不会堆积）；若历史里没有可退的层（如直接刷新进入答题态），则就地渲染。
  function backToSetup() {
    stopTimer();
    if (history.length > 1 && state.screen !== "setup") {
      try { history.back(); return; } catch (_) {}
    }
    state.screen = "setup";
    state.sideOpen = false;
    renderSetup();
    window.scrollTo(0, 0);
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
    side.innerHTML = `<h4>${state.year}.${month} N2</h4>
      <div class="q-meta" style="font-size:12px">${state.mode === "sim" ? "仿真模式" : "宽松模式"}${auto ? " · 倒计时结束自动交卷" : ""}</div>
      <div style="margin-top:14px"><button class="btn ghost" id="back2">‹ 返回上一层</button></div>`;
    main.innerHTML = `
      <div class="score-hero">
        <div class="sc">${sc.right}<span style="font-size:20px;color:var(--muted)"> / ${sc.countable}</span></div>
        <div class="sc-sub">${auto ? "倒计时结束，自动交卷。" : "已交卷。"} 另有 ${sc.nomc} 道练习模式题（不计分）${sc.unanswered ? ` · 未答 ${sc.unanswered} 题` : ""}</div>
      </div>
      <div id="rlist"></div>
      <div style="margin-top:18px;display:flex;gap:10px">
        <button class="btn ghost" id="again">再考一次</button>
        <button class="btn ghost" id="back3">‹ 返回上一层</button>
      </div>`;
    document.getElementById("rlist").innerHTML = S.set.map(q => reviewItem(q)).join("");
    document.getElementById("back2").onclick = backToSetup;
    document.getElementById("back3").onclick = backToSetup;
    document.getElementById("again").onclick = () => {
      S.set = examSet(state.exam); resetSession(); S.examMode = state.mode;
      state.screen = "answer";
      state.sideOpen = !isNarrow();
      pushScreen("answer");   // 再考一次同样占一层历史，返回键仍能退回设置屏
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