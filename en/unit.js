/* ============================================================================
   英语词表单元页的视图层
   ----------------------------------------------------------------------------
   单元页 HTML 里只有一个空的 <main id="enUnit">（见 tools/en-vocab.mjs 的模板），
   结构全部由这里建。原因：77 个页面各内联一套结构会有约 600 KB 重复，且后续切片
   要逐页改 77 处。
   数据来自 en/data/vocab.js（window.EN_VOCAB），本页范围来自 window.EN_UNIT。
   票 03 只做「列表 + 翻转卡」两态，且翻面即记一次自评 —— 测验与复习队列是票 05。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- SM-2：与 jp-vocab/vocab.js 的 sm2() 同参数、同式子 ----------
     决策 170「参数照抄」：日粒度（due 是「第几天」而不是时间戳），
     评分 ≥3 视为答对（reps 1→1 天、2→6 天、之后 interval×ef），评分 <3 回炉。
     导出给票 05 的复习队列复用，避免两处各写一遍。 */
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
  var idx = 0;
  var flipped = false;

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

  /* ---------- 进度存取：词表 SRS 自己的 key，与 jlpt-progress 分开 ---------- */
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
      '<span class="en-note">翻面即记一次「会」；' + words.length + ' 张都评过，本页自动盖章</span>' +
      '</p>' +
      '</div>';
  }

  function ratedCount() {
    var n = 0;
    for (var i = 0; i < words.length; i++) if (srs[words[i].w]) n += 1;
    return n;
  }

  /* 页级完成 = 本单元每张卡都有过一次评分（PRD 决策 173）；门户靠这个显示「已看 n」 */
  function syncDone() {
    var n = ratedCount();
    var full = words.length > 0 && n === words.length;
    var el = document.getElementById('enRated');
    if (el) {
      el.textContent = '已评 ' + n + '/' + words.length;
      el.classList.toggle('is-full', full);
    }
    /* 票 05 在这里再补一个「已掌握 n/N」 */
    if (window.LibProgress) {
      if (full) window.LibProgress.markDone(pageKey);
      else window.LibProgress.unmark(pageKey);
    }
    var pos = document.getElementById('enDeckPos');
    if (pos && view === 'card') pos.textContent = (idx + 1) + ' / ' + words.length + ' · 已评 ' + n + '/' + words.length;
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

  /* ---------- 翻转卡视图 ---------- */
  function cardHtml() {
    if (!words.length) return '<p class="en-empty">本单元没有词。</p>';
    var w = words[idx];
    return '<div class="en-deck">' +
      '<button class="en-deck-nav" type="button" data-nav="-1"' + (idx === 0 ? ' disabled' : '') + ' aria-label="上一张">‹</button>' +
      '<div class="en-card' + (flipped ? ' is-flipped' : '') + '" id="enCard" role="button" tabindex="0" aria-label="点击翻转">' +
      '<div class="en-card-inner">' +
      '<div class="en-card-face en-card-front">' +
      '<span class="en-card-rank">#' + num(w.rank) + '</span>' +
      '<p class="en-word" lang="en">' + esc(w.w) + '</p>' +
      '<p class="en-card-ph">' + esc(w.ph) + '</p>' +
      '<button class="en-say" type="button" data-say="' + esc(w.w) + '">发音</button>' +
      '<span class="en-flip-hint">点击卡片看释义</span>' +
      '</div>' +
      '<div class="en-card-face en-card-back">' +
      '<span class="en-card-rank">#' + num(w.rank) + '</span>' +
      '<p class="en-word" lang="en">' + esc(w.w) + '</p>' +
      '<p class="en-card-ph">' + esc(w.ph) + '</p>' +
      '<p class="en-card-pos">' + esc(w.pos) + '</p>' +
      '<p class="en-card-tr">' + esc(lines(w.tr)) + '</p>' +
      (w.def ? '<p class="en-card-def" lang="en">' + esc(lines(w.def)) + '</p>' : '') +
      badges(w, 0) +
      '</div>' +
      '</div>' +
      '</div>' +
      '<button class="en-deck-nav" type="button" data-nav="1"' + (idx === words.length - 1 ? ' disabled' : '') + ' aria-label="下一张">›</button>' +
      '</div>' +
      '<p class="en-deck-pos" id="enDeckPos"></p>';
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!words.length) {
      host.innerHTML = headHtml() + '<p class="en-empty">这个单元没有词。</p>';
      return;
    }
    var tabs = '<div class="en-tabs" role="tablist">' +
      '<button type="button" role="tab" data-view="list"' + (view === 'list' ? ' class="on" aria-selected="true"' : ' aria-selected="false"') + '>列表</button>' +
      '<button type="button" role="tab" data-view="card"' + (view === 'card' ? ' class="on" aria-selected="true"' : ' aria-selected="false"') + '>翻转卡</button>' +
      '</div>';
    host.innerHTML = headHtml() + tabs + '<div id="enView">' + (view === 'list' ? listHtml() : cardHtml()) + '</div>';
    syncDone();
  }

  function setView(v) {
    if (v === view) return;
    view = v;
    render();
  }

  function go(step) {
    var next = idx + step;
    if (next < 0 || next >= words.length) return;
    idx = next;
    flipped = false;
    render();
  }

  /* 翻面 = 自评「会(4)」；票 05 会用显式的「不会 / 会」两个按钮取代它 */
  function flip() {
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

  /* ---------- 交互 ---------- */
  host.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== host) {
      if (t.getAttribute && t.hasAttribute && t.hasAttribute('data-say')) {
        e.stopPropagation();
        say(t.getAttribute('data-say'));
        return;
      }
      if (t.getAttribute && t.hasAttribute) {
        if (t.hasAttribute('data-view')) { setView(t.getAttribute('data-view')); return; }
        if (t.hasAttribute('data-nav')) { go(parseInt(t.getAttribute('data-nav'), 10) || 0); return; }
        if (t.id === 'enCard') { flip(); return; }
      }
      t = t.parentNode;
    }
  });

  host.addEventListener('keydown', function (e) {
    if (!words.length) return;
    if (view === 'card' && (e.key === 'Enter' || e.key === ' ')) {
      if (document.activeElement && document.activeElement.id === 'enCard') {
        e.preventDefault();
        flip();
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
    flip: flip,
    go: go,
    setView: setView,
    say: say
  };
})();
