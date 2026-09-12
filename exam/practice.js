/* 题型专练页逻辑（形态 B） */
(function () {
  "use strict";
  const { S, PART_LABEL, PART_ORDER, loadExam, poolOf,
          records, isCorrect, scoreSet, qHTML,
          resetSession, fmtTime } = EXAM;
  const EXAMS = ["2023-07", "2023-12"];
  const TIER = [10, 20, 30];
  const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
  const state = { level: "N2", subType: null, tier: 10, screen: "setup" };
  const side = document.getElementById("side");
  const main = document.getElementById("main");

  function subTypesOfPart(part) {
    const seen = [];
    for (const k of EXAMS) for (const q of dataCache[k].questions)
      if (q.part === part && !seen.includes(q.subType)) seen.push(q.subType);
    return seen;
  }
  const dataCache = {};
  // 加载完两卷数据后进入设置界面
  Promise.all(EXAMS.map(e => loadExam(e))).then(ds => {
    ds.forEach((d, i) => { dataCache[EXAMS[i]] = d; });
    setupSide();
    renderMain();
  });

  function setupSide() {
    let h = "<h4>等级</h4><div class=\"pills\">";
    for (const lv of LEVELS) {
      h += `<button class="pill ${state.level === lv ? "on" : ""}" data-lv="${lv}" ${lv !== "N2" ? "disabled" : ""}>${lv}${lv !== "N2" ? " <small>待入库</small>" : ""}</button>`;
    }
    h += "</div><h4>子题型</h4>";
    for (const part of PART_ORDER) {
      h += `<div class="b-nav-sec"><span>${PART_LABEL[part]}</span></div>`;
      for (const st of subTypesOfPart(part)) {
        const n = poolOf(EXAMS, st).length;
        h += `<div class="st-item ${state.subType === st ? "on" : ""}" data-st="${st}"><span>${st.replace(/^(听力·|读解·)/, "")}</span><small>${n} 题</small></div>`;
      }
    }
    side.innerHTML = h;
    side.querySelectorAll("[data-st]").forEach(el => el.onclick = () => {
      state.subType = el.dataset.st; state.tier = 10; state.screen = "setup";
      setupSide(); renderMain();
    });
  }

  function renderMain() {
    if (state.screen !== "answer") {
      if (!state.subType) {
        main.innerHTML = `<div class="q-block"><div class="q-stem">从左侧选择一个子题型，再从下方选题量，开始随机抽题。</div></div>`;
        return;
      }
      const n = poolOf(EXAMS, state.subType).length;
      main.innerHTML = `<div class="pick-group"><div class="pg-label">题量档位（题池 ${n} 题 = 两卷并集，按真题顺序取前 N）</div>
        <div class="pills">${TIER.map(t => `<button class="pill ${state.tier === t ? "on" : ""}" data-tier="${t}" ${n < t ? "disabled" : ""}>${t} 题${n < t ? `<small>池 ${n}</small>` : ""}</button>`).join("")}</div></div>
        <div style="margin-top:18px"><button class="btn" id="start">开始练习</button></div>`;
      main.querySelectorAll("[data-tier]").forEach(el => el.onclick = () => { state.tier = +el.dataset.tier; renderMain(); });
      document.getElementById("start").onclick = () => {
        S.set = poolOf(EXAMS, state.subType).slice(0, Math.min(state.tier, n));
        resetSession();
        S.mode = "practice";
        state.screen = "answer";
        setupSide(); renderMain(); window.scrollTo(0, 0);
      };
      return;
    }
    // 答题
    const q = S.set[S.idx];
    const a = S.answers[q.id];
    const canConfirm = q.options && !S.locked[q.id] && (q.subAnswers
      ? (a && a.q1 !== undefined && a.q2 !== undefined)
      : a !== undefined && !q.optionsMissing);
    main.innerHTML = `
      <div class="q-block">${qHTML(q)}</div>
      <div class="b-actions">
        <button class="btn ghost" id="prev" ${S.idx === 0 ? "disabled" : ""}>上一题</button>
        <span class="spacer"></span>
        ${canConfirm ? `<button class="btn confirm" id="confirm">确认答案</button>` : ""}
        <span style="font-size:13px;color:var(--muted)">${S.idx + 1} / ${S.set.length}</span>
        <button class="btn" id="next">${S.idx < S.set.length - 1 ? "下一题" : "交卷"}</button>
      </div>`;
    bindOptions(main);
    document.getElementById("prev").onclick = () => { S.idx--; renderMain(); window.scrollTo(0, 0); };
    const cf = document.getElementById("confirm");
    if (cf) cf.onclick = () => { S.locked[q.id] = true; renderMain(); window.scrollTo(0, 0); };
    document.getElementById("next").onclick = () => {
      if (S.idx < S.set.length - 1) { S.idx++; renderMain(); window.scrollTo(0, 0); }
      else finish();
    };
    window.scrollTo(0, 0);
  }

  function bindOptions(root) {
    root.querySelectorAll(".opts").forEach(box => {
      const qid = box.dataset.qid;
      if (box.dataset.locked) return; // 已确认，锁定
      const q = S.set.find(x => x.id === qid);
      box.querySelectorAll(".opt").forEach(el => el.onclick = () => {
        if (q.subAnswers) {
          const cur = S.answers[qid] || {};
          if (cur.q1 === undefined) cur.q1 = +el.dataset.idx; else cur.q2 = +el.dataset.idx;
          S.answers[qid] = cur;
        } else S.answers[qid] = +el.dataset.idx;
        renderMain();
      });
    });
    root.querySelectorAll("audio[data-once]").forEach(a =>
      a.addEventListener("ended", () => a.setAttribute("controls", "controlsdisabled")));
  }

  function finish() {
    const sc = scoreSet(S.set, S.answers);
    records.addPractice(state.subType, S.set.length);
    state.screen = "review";
    setupSide();
    main.innerHTML = `
      <div class="score-hero"><div class="sc">${sc.right}<span style="font-size:20px;color:var(--muted)"> / ${sc.countable}</span></div>
      <div class="sc-sub">${sc.nomc ? `另有 ${sc.nomc} 道练习模式题（不计分）` : ""}${sc.unanswered ? ` · 未答 ${sc.unanswered}` : ""}</div></div>
      <div id="rlist"></div>
      <div style="margin-top:18px;display:flex;gap:10px">
        <button class="btn" id="again">再练一组</button>
        <a class="btn ghost" href="index.html">回到入口</a>
      </div>`;
    document.getElementById("rlist").innerHTML = S.set.map(q => reviewItem(q)).join("");
    document.getElementById("again").onclick = () => {
      const n = poolOf(EXAMS, state.subType).length;
      S.set = poolOf(EXAMS, state.subType).slice(0, Math.min(state.tier, n));
      resetSession(); state.screen = "answer"; renderMain(); window.scrollTo(0, 0);
    };
    window.scrollTo(0, 0);
  }

  function reviewItem(q) {
    const a = S.answers[q.id];
    let mark = "未作答";
    if (a !== undefined) {
      const c = isCorrect(q, a);
      mark = c === null ? "练习模式" : (c ? '<span class="r-ok">✓ 答对</span>' : '<span class="r-bad">✗ 答错</span>');
    }
    return `<div class="review-q"><details>
      <summary><div class="q-head"><span class="q-no">第 ${q.qNo} 题 · ${q.subType}</span><span>${mark}</span></div></summary>
      <div class="q-body">${qHTML(q, { review: true })}</div></details></div>`;
  }
})();