/* 题型专练页逻辑（形态 B） */
(function () {
  "use strict";
  const { S, PART_LABEL, PART_ORDER, loadIndex, requireUnlock, poolOfLazy, shuffle,
          records, isCorrect, scoreSet, qHTML, canConfirm, pick,
          resetSession, fmtTime, isNarrow, esc } = EXAM;
  const EXAMS = ["2010-07", "2010-12", "2011-07", "2011-12", "2012-07", "2012-12", "2013-07", "2013-12",
                 "2014-07", "2014-12", "2015-07", "2015-12", "2016-07", "2016-12", "2017-07",
                 "2017-12", "2018-07", "2018-12", "2019-07", "2019-12", "2020-12", "2021-07",
                 "2021-12", "2022-07", "2022-12", "2023-07", "2023-12", "2024-07", "2024-12",
                 "2025-07"];
  const TIER = [10, 20, 30];
  const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
  // tier 支持 0 = 全部题量；custom 为用户自定义题量（与 tier 互斥）
  const state = { level: "N2", subType: null, tier: 10, custom: null, screen: "setup", sideOpen: false };
  const side = document.getElementById("side");
  const main = document.getElementById("main");

  // 选题屏只需要 ~13 KB 的题型索引（index-lite.js）：有哪些题型、各多少题。
  // 这份索引是明文常驻的（不含任何题目正文），所以选题屏不需要口令；
  // 30 卷题目数据（约 6.0 MB）是密文，等真正点「开始练习」时按题型命中卷按需加载。
  let IDX = null;

  // 某题型在全库的题池大小（纯查索引，不加载任何题目数据）
  function poolCount(subType) {
    if (!IDX || !subType) return 0;
    let n = 0;
    for (const k of EXAMS) n += (IDX.exams[k] && IDX.exams[k].types[subType]) || 0;
    return n;
  }
  function subTypesOfPart(part) {
    const seen = [];
    for (const k of EXAMS) {
      const t = IDX && IDX.exams[k] && IDX.exams[k].types;
      if (!t) continue;
      for (const st of Object.keys(t))
        if (IDX.typePart[st] === part && !seen.includes(st)) seen.push(st);
    }
    return seen;
  }

  // 抽题：先把该题型在全库的题目并起来，打乱后取前 N。
  // 不用「按时间序取前 N」——那样每次抽到的永远是 2010 年前几卷的题。
  function drawSet(subType) {
    return poolOfLazy(EXAMS, IDX, subType).then(pool => shuffle(pool).slice(0, wantCount(pool.length)));
  }

  loadIndex().then(ix => {
    IDX = ix;
    try { history.replaceState({ jlpt: "setup" }, ""); } catch (_) {}
    setupSide();
    renderMain();
  }).catch(err => {
    side.innerHTML = "<h4>题型</h4>";
    main.innerHTML = `<div class="q-block"><div class="q-stem">题型索引加载失败：${esc(String(err && err.message || err))}</div></div>`;
  });

  // 抽题 → 进答题屏。等待期间按钮置灰，避免重复点击。
  // 首次点「开始练习」时才要口令；已解锁的（同一标签页内输过）直接过。
  function runDraw(btn) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1";
    const idle = btn.textContent;
    btn.disabled = true;
    btn.textContent = "抽题中…";
    requireUnlock().then(() => drawSet(state.subType)).then(set => {
      S.set = set;
      resetSession();
      S.mode = "practice";
      state.screen = "answer";
      state.sideOpen = !isNarrow();
      pushScreen("answer");   // 记一层历史：浏览器返回键从答题屏退回设置屏
      setupSide(); renderMain(); window.scrollTo(0, 0);
    }).catch(err => {
      btn.disabled = false; btn.textContent = idle; delete btn.dataset.busy;
      if (err && err.cancelled) return;   // 用户取消输入口令，静默回到可点状态
      btn.insertAdjacentHTML("afterend",
        `<div class="q-block" style="padding:10px 14px"><div class="q-stem" style="color:var(--accent-ink)">题目加载失败：${esc(String(err && err.message || err))}</div></div>`);
    });
  }

  // ---------- 浏览器返回键：从答题屏退回选题型/题量屏 ----------
  function pushScreen(name) {
    try { history.pushState({ jlpt: name }, ""); } catch (_) {}
  }
  window.addEventListener("popstate", () => {
    state.screen = "setup";
    state.sideOpen = false;
    setupSide();
    renderMain();
    window.scrollTo(0, 0);
  });

  function setupSide() {
    if (state.screen === "answer") {
      const n = poolCount(state.subType);
      side.innerHTML = `<button class="b-fold" id="fold">
        <span>${state.level} · ${state.subType.replace(/^(听力·|读解·)/, "")} · 题池 ${n} 题</span>
        <span class="b-fold-i">${state.sideOpen ? "收起 ▴" : "换题型 ▾"}</span></button>
        <div class="b-fold-body" ${state.sideOpen ? "" : "hidden"}>${sideBody()}</div>`;
      document.getElementById("fold").onclick = () => { state.sideOpen = !state.sideOpen; setupSide(); };
    } else side.innerHTML = sideBody();
    side.querySelectorAll("[data-st]").forEach(el => el.onclick = () => {
      state.subType = el.dataset.st; state.tier = 10; state.custom = null; state.screen = "setup";
      setupSide(); renderMain();
    });
  }

  function sideBody() {
    let h = "<h4>等级</h4><div class=\"pills\">";
    for (const lv of LEVELS) {
      h += `<button class="pill ${state.level === lv ? "on" : ""}" data-lv="${lv}" ${lv !== "N2" ? "disabled" : ""}>${lv}${lv !== "N2" ? " <small>待入库</small>" : ""}</button>`;
    }
    h += "</div><h4>子题型</h4>";
    for (const part of PART_ORDER) {
      h += `<div class="b-nav-sec"><span>${PART_LABEL[part]}</span></div>`;
      for (const st of subTypesOfPart(part)) {
        const n = poolCount(st);
        h += `<div class="st-item ${state.subType === st ? "on" : ""}" data-st="${st}"><span>${st.replace(/^(听力·|读解·)/, "")}</span><small>${n} 题</small></div>`;
      }
    }
    return h;
  }

  // 解析本次要抽的题量：自定义 > 全部(0) > 固定档位；并对题池上限做钳制
  function wantCount(pool) {
    let n;
    if (state.custom != null) n = state.custom;
    else if (state.tier === 0) n = pool;
    else n = state.tier;
    return Math.min(Math.max(1, n || 1), pool);
  }

  function renderMain() {
    if (state.screen !== "answer") {
      if (!state.subType) {
        main.innerHTML = `<div class="q-block"><div class="q-stem">从左侧选择一个子题型，再从下方选题量，开始随机抽题。</div></div>`;
        return;
      }
      const n = poolCount(state.subType);
      const cur = wantCount(n);
      main.innerHTML = `<div class="pick-group"><div class="pg-label">题量（题池 ${n} 题 = 全部已入库卷的并集，每次随机抽取）</div>
        <div class="pills">
          ${TIER.map(t => `<button class="pill ${state.custom == null && state.tier === t ? "on" : ""}" data-tier="${t}" ${n < t ? "disabled" : ""}>${t} 题${n < t ? `<small>池 ${n}</small>` : ""}</button>`).join("")}
          <button class="pill ${state.custom == null && state.tier === 0 ? "on" : ""}" data-tier="0">全部 <small>${n} 题</small></button>
        </div>
        <div class="tier-custom">
          <label for="tier-input">自定义题量</label>
          <input id="tier-input" type="number" min="1" max="${n}" step="1" inputmode="numeric"
                 value="${cur}" placeholder="1–${n}">
          <span class="tc-hint">题（上限 ${n}）</span>
        </div></div>
        <div style="margin-top:18px"><button class="btn" id="start">开始练习</button></div>`;
      main.querySelectorAll("[data-tier]").forEach(el => el.onclick = () => {
        state.tier = +el.dataset.tier; state.custom = null; renderMain();
      });
      const inp = document.getElementById("tier-input");
      inp.oninput = () => {
        const v = parseInt(inp.value, 10);
        if (Number.isFinite(v)) { state.custom = v; state.tier = null; main.querySelectorAll("[data-tier]").forEach(b => b.classList.remove("on")); }
        else state.custom = null;
        document.getElementById("start").disabled = !(state.custom != null || state.tier != null);
      };
      const startBtn = document.getElementById("start");
      startBtn.onclick = () => runDraw(startBtn);
      return;
    }
    // 答题
    const q = S.set[S.idx];
    main.innerHTML = `
      <div class="q-block">${qHTML(q)}</div>
      <div class="b-actions">
        <button class="btn ghost" id="back">‹ 返回</button>
        <button class="btn ghost" id="prev" ${S.idx === 0 ? "disabled" : ""}>上一题</button>
        <span class="spacer"></span>
        <button class="btn confirm" id="confirm" ${canConfirm(q) ? "" : "hidden"}>确认答案</button>
        <span style="font-size:13px;color:var(--muted)">${S.idx + 1} / ${S.set.length}</span>
        <button class="btn" id="next">${S.idx < S.set.length - 1 ? "下一题" : "交卷"}</button>
      </div>`;
    bindOptions(main);
    // 返回上一层：回到选题型/题量屏，而不是直接回到真题练习入口
    document.getElementById("back").onclick = backToSetup;
    document.getElementById("prev").onclick = () => { S.idx--; collapseSide(); renderMain(); window.scrollTo(0, 0); };
    // 确认后判定与解析就长在选项下方，滚到顶部反而把它藏起来
    document.getElementById("confirm").onclick = () => { S.locked[q.id] = true; renderMain(); };
    document.getElementById("next").onclick = () => {
      if (S.idx < S.set.length - 1) { S.idx++; collapseSide(); renderMain(); window.scrollTo(0, 0); }
      else finish();
    };
  }

  // 切题会滚到窗口顶部：窄屏下先收起侧栏，顶部才是题目而不是选题列表
  function collapseSide() {
    if (isNarrow() && state.sideOpen) { state.sideOpen = false; setupSide(); }
  }

  function bindOptions(root) {
    root.querySelectorAll(".opts").forEach(box => {
      const qid = box.dataset.qid;
      if (box.dataset.locked) return; // 已确认，锁定
      const q = S.set.find(x => x.id === qid);
      box.querySelectorAll(".opt").forEach(el => el.onclick = () => {
        pick(q, box, +el.dataset.idx);
        document.getElementById("confirm").hidden = !canConfirm(q);
      });
    });
    root.querySelectorAll("audio[data-once]").forEach(a =>
      a.addEventListener("ended", () => a.setAttribute("controls", "controlsdisabled")));
  }

  // 回到上一层（选题型/题量屏），保留已选等级与子题型
  function backToSetup() {
    // 优先走 history.back()，让 popstate 统一处理，页内按钮与浏览器返回键行为一致
    if (history.length > 1 && state.screen !== "setup") {
      try { history.back(); return; } catch (_) {}
    }
    state.screen = "setup";
    state.sideOpen = false;
    setupSide();
    renderMain();
    window.scrollTo(0, 0);
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
        <button class="btn ghost" id="back3">‹ 返回上一层</button>
      </div>`;
    document.getElementById("rlist").innerHTML = S.set.map(q => reviewItem(q)).join("");
    document.getElementById("back3").onclick = backToSetup;
    const againBtn = document.getElementById("again");
    againBtn.onclick = () => runDraw(againBtn);   // 再练一组同样占一层历史，返回键仍能退回设置屏
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