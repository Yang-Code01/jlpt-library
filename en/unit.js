/* ============================================================================
   英语词表单元页的视图层
   ----------------------------------------------------------------------------
   单元页 HTML 里只有一个空的 <main id="enUnit">（见 tools/en-vocab.mjs 的模板），
   结构全部由这里建。原因：77 个页面各内联一套结构会有约 600 KB 重复，且后续切片
   要逐页改 77 处。
   数据来自 en/data/vocab.js（window.EN_VOCAB），本页范围来自 window.EN_UNIT。

   四态：列表（速览）/ 翻转卡（顺序过一遍）/ 测验（英→中四选一）/ 复习（到期队列）。
   后两态是票 05 加的。四态共用同一份复习记录（localStorage 的 en-vocab-srs-<档>-<NN>），
   所以「在测验里答对」与「在翻转卡里翻面」写的是同一条记录，不会互相打架。

   页级完成 = 本单元每个词都有过一次评分（无论对错），达成即自动盖章进 jlpt-progress。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- SM-2：与 jp-vocab/vocab.js 的 sm2() 同参数、同式子 ----------
     决策 170「参数照抄」：日粒度（due 是「第几天」而不是时间戳），
     评分 ≥3 视为答对（reps 1→1 天、2→6 天、之后 interval×ef），评分 <3 回炉。
     导出的 window.EnSrs 也给别的英语页复用，避免两处各写一遍。 */
  var DAY = 86400000;

  function today() {
    return Math.floor(Date.now() / DAY);
  }

  function sm2(rec, q) {
    var s = rec
      ? { ef: rec.ef, interval: rec.interval, reps: rec.reps, due: rec.due, n: rec.n || 0, last: rec.last || 0 }
      : { ef: 2.5, interval: 0, reps: 0, due: today(), n: 0, last: 0 };
    if (q >= 3) {
      s.reps += 1;
      if (s.reps === 1) s.interval = 1;
      else if (s.reps === 2) s.interval = 6;
      else s.interval = Math.round(s.interval * s.ef);
      s.ef = Math.max(1.3, s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
      s.due = today() + s.interval;
    } else {
      s.reps = 0;
      s.interval = 1;
      s.due = today() + 1;
      s.ef = Math.max(1.3, s.ef - 0.2);
    }
    s.n += 1;
    s.last = today();
    return s;
  }

  function isDue(rec) {
    return !rec || rec.due <= today();
  }

  window.EnSrs = { sm2: sm2, isDue: isDue, today: today, DAY: DAY };

  /* ---------- 徽标文案（与 tools/en-vocab.mjs 的 TAG_ORDER / TAG_TEXT 一致） ---------- */
  var TAG_ORDER = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'toefl', 'ielts', 'gre'];
  var TAG_TEXT = {
    zk: '中考', gk: '高考', cet4: '四级', cet6: '六级',
    ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE'
  };

  /* ---------- 取数据 ---------- */
  var V = window.EN_VOCAB;
  var U = window.EN_UNIT;
  var host = document.getElementById('enUnit');
  if (!V || !U || !host || !V.words) return;

  var band = U.band;
  var unitNo = U.unit;
  var words = V.words.slice((U.from || 1) - 1, U.to || U.from);
  var meta = bandMeta(band);
  var pageKey = 'en/' + band + '/' + pad2(unitNo) + '.html';
  var SRS_KEY = 'en-vocab-srs-' + band + '-' + pad2(unitNo);   /* 决策 18 */

  var srs = loadSrs();
  var view = 'list';
  var idx = 0;                 /* 翻转卡的牌位 */
  var flipped = false;
  var reviewQueue = [];        /* 复习队列，元素是 words 的下标 */
  var revFlipped = false;
  var qOrder = [];             /* 测验的题序（打乱后的下标） */
  var qIdx = 0;
  var qOpts = [];              /* 当前题的选项 [{text, ok}]，只在换题时重建 */
  var qPicked = null;          /* 当前题选中的选项下标，null = 未答 */
  var qRight = 0;
  var qWrong = 0;
  var qDone = false;

  var TABS = [
    { id: 'list', label: '列表' },
    { id: 'card', label: '翻转卡' },
    { id: 'quiz', label: '测验' },
    { id: 'review', label: '复习' }
  ];

  /* ---------- 小工具 ---------- */
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function bandMeta(id) {
    var bs = (V.meta && V.meta.bands) || [];
    for (var i = 0; i < bs.length; i++) if (bs[i].id === id) return bs[i];
    return { id: id, label: id, sub: '', from: 0, to: 0 };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* translation / definition 里的换行是字面量 \n，转成真换行后交给 pre-line */
  function lines(s) {
    return String(s == null ? '' : s).replace(/\\n/g, '\n').trim();
  }

  function firstLine(s) {
    return lines(s).split('\n')[0];
  }

  function num(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function range(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(i);
    return a;
  }

  function shuffle(a) {
    var r = a.slice();
    for (var i = r.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = r[i];
      r[i] = r[j];
      r[j] = t;
    }
    return r;
  }

  /* ---------- 中释清洗：把多行长文本压成能当选项的单行短释 ----------
     实测（research/sample-tr.mjs）：首行前缀只有 15 种形态，全是 [a-z]{1,5}. ；
     另有十几个是 [计] / [医] 这类领域标记，以及一条 o'clock 的 "n. ...点钟"。
     短释长度 p50 11 / p90 23 / p99 42，超 24 字的 308 条 —— 只截这批。
     去重键就是这里返回的最终文本，所以被截成同一个短释的两个词不会同时出现在一道题里。 */
  var RE_POS = /^\s*(?:[a-z]{1,5}\.\s*)+/i;
  var RE_DOMAIN = /^\[[^\]]{1,12}\]\s*/;
  var SHORT_MAX = 24;

  function shortTr(s) {
    var t = firstLine(s).replace(RE_POS, '').replace(RE_DOMAIN, '').trim();
    t = t.replace(/^[.…]{2,}\s*/, '');
    var head = t.split(/[;；]/)[0].trim();
    if (head) t = head;
    if (t.length > SHORT_MAX) {
      var cut = t.slice(0, SHORT_MAX);
      var at = Math.max(cut.lastIndexOf(','), cut.lastIndexOf('，'), cut.lastIndexOf('、'));
      if (at >= 4) cut = cut.slice(0, at);
      t = cut.replace(/[\s,，、;；]+$/, '') + '…';
    }
    return t;
  }

  /* ---------- 复习记录存取：词表自己的 key，与 jlpt-progress 分开 ---------- */
  function loadSrs() {
    try {
      var o = JSON.parse(window.localStorage.getItem(SRS_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch (e) {
      return {};
    }
  }

  function saveSrs() {
    try {
      window.localStorage.setItem(SRS_KEY, JSON.stringify(srs));
    } catch (e) { /* 隐私模式写入失败就只留在内存里 */ }
  }

  /* 答错时把词打回「今天到期」，不罚易度因子（与 jp-vocab 的 forceReview 同一手法）。
     它也算一次评分，所以会进「已评」计数。 */
  function forceReview(word) {
    var rec = srs[word] || { ef: 2.5, interval: 0, reps: 0, due: today(), n: 0, last: 0 };
    rec.reps = 0;
    rec.interval = 1;
    rec.due = today();
    rec.n = (rec.n || 0) + 1;
    rec.last = today();
    srs[word] = rec;
    saveSrs();
  }

  /* ---------- 发音：浏览器自带 TTS，不预生成音频 ---------- */
  var VOICES = [];

  function loadVoices() {
    try {
      VOICES = window.speechSynthesis.getVoices() || [];
    } catch (e) {
      VOICES = [];
    }
  }

  function say(word) {
    if (!word || !window.speechSynthesis) return;
    try {
      var u = new window.SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.9;
      var best = null;
      for (var i = 0; i < VOICES.length; i++) {
        var l = VOICES[i].lang || '';
        if (/^en[-_]US$/i.test(l)) { best = VOICES[i]; break; }
        if (!best && /^en/i.test(l)) best = VOICES[i];
      }
      if (best) {
        u.voice = best;
        u.lang = best.lang;
      }
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* 没有可用语音就静默 */ }
  }

  /* ---------- 徽标 ---------- */
  function badges(w, limit) {
    var out = '';
    var tags = [];
    var own = w.tag || [];
    for (var i = 0; i < TAG_ORDER.length; i++) {
      if (own.indexOf(TAG_ORDER[i]) >= 0) tags.push(TAG_ORDER[i]);
    }
    if (limit) tags = tags.slice(0, limit);
    for (var j = 0; j < tags.length; j++) {
      out += '<span class="en-badge en-badge-tag">' + esc(TAG_TEXT[tags[j]] || tags[j]) + '</span>';
    }
    if (!limit && w.oxford) out += '<span class="en-badge en-badge-ox">牛津三千</span>';
    if (!limit && w.collins) {
      out += '<span class="en-badge en-badge-star" title="柯林斯 ' + w.collins + ' 星">' +
        '★'.repeat(w.collins) + '</span>';
    }
    return out ? '<span class="en-badges">' + out + '</span>' : '';
  }

  /* ---------- 页头与计量 ---------- */
  function headHtml() {
    return '<div class="en-head">' +
      '<p class="en-eyebrow">英语词表 · ' + esc(band) + '</p>' +
      '<h1 class="en-title">' + esc(meta.sub || meta.label) + ' · 单元 ' + pad2(unitNo) + '</h1>' +
      '<p class="en-sub">' + (words.length ? '词频位次 ' + num(U.from) + '–' + num(U.to) : '本单元为空') +
      (words.length ? ' · ' + words.length + ' 词' : '') + '</p>' +
      '<p class="en-meters">' +
      '<span class="en-meter" id="enRated">已评 0/' + words.length + '</span>' +
      '<span class="en-meter" id="enKnown">已掌握 0/' + words.length + '</span>' +
      '<span class="en-note">翻面即记一次「会」；四态共用同一份记录；' +
      words.length + ' 张都评过，本页自动盖章</span>' +
      '</p>' +
      '</div>';
  }

  /* 已评 = 该词有记录（无论对错）；已掌握 = 答对过至少一次（reps > 0） */
  function ratedCount() {
    var n = 0;
    for (var i = 0; i < words.length; i++) if (srs[words[i].w]) n += 1;
    return n;
  }

  function masteredCount() {
    var n = 0;
    for (var i = 0; i < words.length; i++) {
      var r = srs[words[i].w];
      if (r && r.reps > 0) n += 1;
    }
    return n;
  }

  /* 页级完成 = 本单元每张卡都有过一次评分（PRD 决策 173）；门户靠这个显示「已看 n」 */
  function syncDone() {
    var n = ratedCount();
    var k = masteredCount();
    var full = words.length > 0 && n === words.length;
    var el = document.getElementById('enRated');
    if (el) {
      el.textContent = '已评 ' + n + '/' + words.length;
      el.classList.toggle('is-full', full);
    }
    var ke = document.getElementById('enKnown');
    if (ke) {
      ke.textContent = '已掌握 ' + k + '/' + words.length;
      ke.classList.toggle('is-full', words.length > 0 && k === words.length);
    }
    if (window.LibProgress) {
      if (full) window.LibProgress.markDone(pageKey);
      else window.LibProgress.unmark(pageKey);
    }
    var pos = document.getElementById('enDeckPos');
    if (pos && view === 'card') pos.textContent = (idx + 1) + ' / ' + words.length + ' · 已评 ' + n + '/' + words.length;
    var left = document.getElementById('enRevLeft');
    if (left) left.textContent = '待复习 ' + reviewQueue.length;
  }

  /* ---------- 列表视图 ---------- */
  function listHtml() {
    if (!words.length) return '<p class="en-empty">本单元没有词。</p>';
    var h = '<ul class="en-list">';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      h += '<li class="en-row">' +
        '<span class="en-row-no">' + (i + 1) + '</span>' +
        '<span class="en-row-word" lang="en">' + esc(w.w) + '</span>' +
        '<span class="en-row-ph">' + esc(w.ph) + '</span>' +
        '<span class="en-row-tr">' + esc(firstLine(w.tr)) + '</span>' +
        badges(w, 2) +
        '<button class="en-say" type="button" data-say="' + esc(w.w) + '">发音</button>' +
        '</li>';
    }
    return h + '</ul>';
  }

  /* ---------- 卡片的两面：翻转卡与复习卡共用 ---------- */
  function cardFront(w) {
    return '<div class="en-card-face en-card-front">' +
      '<span class="en-card-rank">#' + num(w.rank) + '</span>' +
      '<p class="en-word" lang="en">' + esc(w.w) + '</p>' +
      '<p class="en-card-ph">' + esc(w.ph) + '</p>' +
      '<button class="en-say" type="button" data-say="' + esc(w.w) + '">发音</button>' +
      '<span class="en-flip-hint">点击卡片看释义</span>' +
      '</div>';
  }

  function cardBack(w) {
    return '<div class="en-card-face en-card-back">' +
      '<span class="en-card-rank">#' + num(w.rank) + '</span>' +
      '<p class="en-word" lang="en">' + esc(w.w) + '</p>' +
      '<p class="en-card-ph">' + esc(w.ph) + '</p>' +
      '<p class="en-card-pos">' + esc(w.pos) + '</p>' +
      '<p class="en-card-tr">' + esc(lines(w.tr)) + '</p>' +
      (w.def ? '<p class="en-card-def" lang="en">' + esc(lines(w.def)) + '</p>' : '') +
      badges(w, 0) +
      '</div>';
  }

  function cardBox(w, flippedNow, id) {
    return '<div class="en-card' + (flippedNow ? ' is-flipped' : '') + '" id="' + id +
      '" role="button" tabindex="0" aria-label="点击翻转">' +
      '<div class="en-card-inner">' + cardFront(w) + cardBack(w) + '</div>' +
      '</div>';
  }

  /* ---------- 翻转卡视图 ---------- */
  function cardHtml() {
    if (!words.length) return '<p class="en-empty">本单元没有词。</p>';
    return '<div class="en-deck">' +
      '<button class="en-deck-nav" type="button" data-nav="-1"' + (idx === 0 ? ' disabled' : '') + ' aria-label="上一张">‹</button>' +
      cardBox(words[idx], flipped, 'enCard') +
      '<button class="en-deck-nav" type="button" data-nav="1"' + (idx === words.length - 1 ? ' disabled' : '') + ' aria-label="下一张">›</button>' +
      '</div>' +
      '<p class="en-deck-pos" id="enDeckPos"></p>';
  }

  /* ---------- 测验视图：英 → 中四选一 ----------
     题干是整单元的每个词各一次（打乱顺序），所以一轮测验有终点、有成绩。
     干扰项只从本单元其余词的「清洗后短释」里抽，去重后不足 3 个就按实际数量出题。 */
  function buildOpts() {
    var w = words[qOrder[qIdx]];
    var answer = shortTr(w.tr);
    var seen = {};
    seen[answer] = 1;
    var pool = [];
    for (var i = 0; i < words.length; i++) {
      if (i === qOrder[qIdx]) continue;
      var t = shortTr(words[i].tr);
      if (!t || seen[t]) continue;
      seen[t] = 1;
      pool.push(t);
    }
    var picked = shuffle(pool).slice(0, 3);
    var opts = [{ text: answer, ok: true }];
    for (var j = 0; j < picked.length; j++) opts.push({ text: picked[j], ok: false });
    qOpts = shuffle(opts);
  }

  function newQuiz() {
    qOrder = shuffle(range(words.length));
    qIdx = 0;
    qPicked = null;
    qRight = 0;
    qWrong = 0;
    qDone = false;
    buildOpts();
  }

  function quizHtml() {
    if (!words.length) return '<p class="en-empty">本单元没有词。</p>';
    if (qDone) {
      var total = qRight + qWrong;
      var pct = total ? Math.round(qRight / total * 100) : 0;
      return '<div class="en-quiz">' +
        '<p class="en-quiz-sum">本轮 ' + total + ' 题 · 答对 <b>' + qRight + '</b> · 答错 <b>' + qWrong +
        '</b> · 正确率 <b>' + pct + '%</b></p>' +
        '<p class="en-quiz-tip">答错的词已经回到复习队列（今天到期）。</p>' +
        '<div class="en-quiz-foot"><button class="en-btn" type="button" data-quiz="restart">重新测验</button>' +
        '<button class="en-btn en-btn-quiet" type="button" data-view="review">去复习</button></div>' +
        '</div>';
    }
    var w = words[qOrder[qIdx]];
    var h = '<div class="en-quiz">' +
      '<p class="en-quiz-pos">第 ' + (qIdx + 1) + ' / ' + qOrder.length + ' 题' +
      '<span class="en-quiz-tally">答对 ' + qRight + ' · 答错 ' + qWrong + '</span></p>' +
      '<div class="en-quiz-stage">' +
      '<span class="en-card-rank">#' + num(w.rank) + '</span>' +
      '<p class="en-quiz-word" lang="en">' + esc(w.w) + '</p>' +
      '<p class="en-card-ph">' + esc(w.ph) + '</p>' +
      '<button class="en-say" type="button" data-say="' + esc(w.w) + '">发音</button>' +
      '<div class="en-quiz-opts">';
    for (var i = 0; i < qOpts.length; i++) {
      var cls = 'en-opt';
      if (qPicked !== null) {
        if (qOpts[i].ok) cls += ' correct';
        else if (i === qPicked) cls += ' wrong';
      }
      h += '<button class="' + cls + '" type="button" data-opt="' + i + '"' +
        (qPicked !== null ? ' disabled' : '') + '>' + esc(qOpts[i].text) + '</button>';
    }
    h += '</div>';
    if (qPicked !== null) {
      var isRight = qOpts[qPicked].ok;
      h += '<p class="en-quiz-fb ' + (isRight ? 'is-ok' : 'is-bad') + '">' +
        (isRight ? '✓ 对了' : '✗ 正确答案：<b>' + esc(shortTr(w.tr)) + '</b>') + '</p>' +
        '<div class="en-quiz-foot"><button class="en-btn" type="button" data-quiz="next">' +
        (qIdx >= qOrder.length - 1 ? '看结果' : '下一题 ›') + '</button></div>';
    }
    return h + '</div></div>';
  }

  function answer(i) {
    if (qPicked !== null || qDone || !words.length) return;
    if (!(i >= 0 && i < qOpts.length)) return;
    var w = words[qOrder[qIdx]];
    qPicked = i;
    if (qOpts[i].ok) {
      srs[w.w] = sm2(srs[w.w], 4);
      qRight += 1;
    } else {
      forceReview(w.w);
      qWrong += 1;
    }
    saveSrs();
    syncDone();
    render();
  }

  function quizNext() {
    if (qPicked === null) return;
    if (qIdx >= qOrder.length - 1) {
      qDone = true;
    } else {
      qIdx += 1;
      qPicked = null;
      buildOpts();
    }
    render();
  }

  /* ---------- 复习视图：到期队列，翻面后自评「不会 / 会」 ----------
     队列口径三条任一满足即入队：没记录、还没学会（reps 归零）、已到期。
     第三条不能只写 due<=today —— 评了「不会」的词 due 被 sm2 推到明天，但它的 reps
     是 0（就是还没学会），拿 due 比会把它从队列里弄丢。
     答错的排到队尾而不是队首：队首等于同一张卡立刻再来一次，近距离重复没有回忆价值。 */
  function needsReview(w) {
    var r = srs[w.w];
    return !r || !r.reps || r.due <= today();
  }

  function buildQueue() {
    reviewQueue = [];
    for (var i = 0; i < words.length; i++) if (needsReview(words[i])) reviewQueue.push(i);
  }

  function reviewHtml() {
    if (!words.length) return '<p class="en-empty">本单元没有词。</p>';
    if (!reviewQueue.length) {
      return '<p class="en-empty">今日无待复习项。</p>' +
        '<p class="en-note">新单元一打开，全部词都算到期；评过「会」的按间隔推后（1 天 → 6 天 → 乘以易度因子）。</p>';
    }
    var w = words[reviewQueue[0]];
    return '<div class="en-rev">' +
      cardBox(w, revFlipped, 'enRevCard') +
      '<div class="en-rev-ctl">' +
      '<button class="en-btn en-btn-bad" type="button" data-rate="1">不会</button>' +
      '<button class="en-btn" type="button" data-say="' + esc(w.w) + '">发音</button>' +
      '<button class="en-btn" type="button" data-rate="4">会</button>' +
      '</div>' +
      '<p class="en-rev-left" id="enRevLeft"></p>' +
      '</div>';
  }

  function rate(q) {
    if (!reviewQueue.length) return;
    var i = reviewQueue.shift();
    var w = words[i];
    srs[w.w] = sm2(srs[w.w], q);
    if (q < 3) reviewQueue.push(i);
    saveSrs();
    revFlipped = false;
    syncDone();
    render();
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!words.length) {
      host.innerHTML = headHtml() + '<p class="en-empty">这个单元没有词。</p>';
      return;
    }
    var tabs = '<div class="en-tabs" role="tablist">';
    for (var i = 0; i < TABS.length; i++) {
      tabs += '<button type="button" role="tab" data-view="' + TABS[i].id + '"' +
        (view === TABS[i].id ? ' class="on" aria-selected="true"' : ' aria-selected="false"') + '>' +
        TABS[i].label + '</button>';
    }
    tabs += '</div>';
    var body = view === 'list' ? listHtml()
      : view === 'card' ? cardHtml()
      : view === 'quiz' ? quizHtml()
      : reviewHtml();
    host.innerHTML = headHtml() + tabs + '<div id="enView">' + body + '</div>';
    syncDone();
  }

  function setView(v) {
    if (v === view) return;
    for (var i = 0; i < TABS.length; i++) if (TABS[i].id === v) break;
    if (i === TABS.length) return;
    view = v;
    flipped = false;
    revFlipped = false;
    if (v === 'quiz' && (qDone || !qOrder.length)) newQuiz();
    if (v === 'review') buildQueue();
    render();
  }

  function go(step) {
    var next = idx + step;
    if (next < 0 || next >= words.length) return;
    idx = next;
    flipped = false;
    render();
  }

  /* 翻面 = 自评「会(4)」（复习视图用显式的不会 / 会，不走这里） */
  function flipCard() {
    if (!words.length) return;
    flipped = !flipped;
    if (flipped) {
      var w = words[idx];
      srs[w.w] = sm2(srs[w.w], 4);
      saveSrs();
    }
    var card = document.getElementById('enCard');
    if (card) card.classList.toggle('is-flipped', flipped);
    syncDone();
  }

  function flipReview() {
    if (!reviewQueue.length) return;
    revFlipped = !revFlipped;
    var card = document.getElementById('enRevCard');
    if (card) card.classList.toggle('is-flipped', revFlipped);
  }

  /* ---------- 交互 ---------- */
  host.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== host) {
      if (t.getAttribute && t.hasAttribute) {
        if (t.hasAttribute('data-say')) {
          e.stopPropagation();
          say(t.getAttribute('data-say'));
          return;
        }
        if (t.hasAttribute('data-view')) { setView(t.getAttribute('data-view')); return; }
        if (t.hasAttribute('data-nav')) { go(parseInt(t.getAttribute('data-nav'), 10) || 0); return; }
        if (t.hasAttribute('data-opt')) { answer(parseInt(t.getAttribute('data-opt'), 10)); return; }
        if (t.hasAttribute('data-rate')) { rate(parseInt(t.getAttribute('data-rate'), 10)); return; }
        if (t.hasAttribute('data-quiz')) {
          if (t.getAttribute('data-quiz') === 'restart') { newQuiz(); render(); }
          else quizNext();
          return;
        }
        if (t.id === 'enCard') { flipCard(); return; }
        if (t.id === 'enRevCard') { flipReview(); return; }
      }
      t = t.parentNode;
    }
  });

  host.addEventListener('keydown', function (e) {
    if (!words.length) return;
    var active = document.activeElement && document.activeElement.id;
    if (e.key === 'Enter' || e.key === ' ') {
      if (view === 'card' && active === 'enCard') {
        e.preventDefault();
        flipCard();
      } else if (view === 'review' && active === 'enRevCard') {
        e.preventDefault();
        flipReview();
      }
    } else if (view === 'card' && e.key === 'ArrowRight') {
      go(1);
    } else if (view === 'card' && e.key === 'ArrowLeft') {
      go(-1);
    }
  });

  /* ---------- 启动 ---------- */
  loadVoices();
  if (window.speechSynthesis && typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
  render();

  /* 给冒烟与后续切片留一个可读的把手 */
  window.EnUnit = {
    pageKey: pageKey,
    srsKey: SRS_KEY,
    total: words.length,
    rated: ratedCount,
    known: masteredCount,
    flip: flipCard,
    go: go,
    setView: setView,
    say: say,
    shortTr: shortTr,
    needsReview: needsReview,
    forceReview: forceReview,
    rate: rate,
    answer: answer,
    state: function () {
      return {
        view: view,
        idx: idx,
        flipped: flipped,
        revFlipped: revFlipped,
        queue: reviewQueue.length,
        qIdx: qIdx,
        qPicked: qPicked,
        qRight: qRight,
        qWrong: qWrong,
        qDone: qDone,
        opts: qOpts.map(function (o) { return o.text; })
      };
    }
  };
})();
