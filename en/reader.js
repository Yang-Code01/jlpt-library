/* ============================================================================
   英语阅读页的视图层（正文页 + 篇目页共用这一个文件）
   ----------------------------------------------------------------------------
   正文页 en/reading/<档>/NN.html 里只有一个空的 <main id="enRead">，结构与词表
   单元页同一思路（见 tools/en-reading.mjs 的 articlePage 模板）：内容由这里建，
   免得 30 个页面各内联一份。数据来自 window.EN_VOCAB（词表）与 window.EN_ARTICLE
   （本篇正文、超纲词词典）。

   三件事：
     1 正文渲染 + 超纲词高亮（词表里查不到、且不是专有名词的词标红）
     2 点词查义：中释 / 英释 / 发音。四级兜底与生成器 tools/en-reading.mjs 的
       resolve() 逐字同口径 —— 小写词形 → 词形还原 → 词形变化反查 → 静默
     3 页底「标记为已读完」（可取消）→ jlpt-progress 的 reading/<档>/<NN>.html

   判「超纲」只看词表（与生成器的 oovSetOf 同判据，不看本篇词典），所以页面里
   标红的不同词数必须等于 payload 的 oovTypes。
   ========================================================================== */
(function () {
  'use strict';

  var main = document.getElementById('enRead');
  var listHost = document.getElementById('enReadIndex');
  var A = window.EN_ARTICLE;

  /* ---------- 小工具（与 en/unit.js 同口径） ---------- */
  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ECDICT 的释义字段里换行是字面量 \n，展示时换成真换行（配 white-space:pre-line） */
  function lines(t) {
    return String(t == null ? '' : t).replace(/\\n/g, '\n');
  }

  function num(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* ---------- 分词与词形：与 tools/en-reading.mjs 逐字同口径 ----------
     正则必须一模一样，否则「页面上标红的词」与「生成器统计的超纲词」会对不上。 */
  var WORDS_RE = /[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'-]*/g;

  function wordsOf(s) {
    WORDS_RE.lastIndex = 0;
    return String(s == null ? '' : s).match(WORDS_RE) || [];
  }

  function lemmaForms(w) {
    var c = [];
    function add(x) { if (x && x.length > 1 && c.indexOf(x) < 0) c.push(x); }
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/es$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w)) add(w.slice(0, -1));
    if (/ed$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
    if (/ing$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); }
    if (/ly$/.test(w)) add(w.slice(0, -2));
    return c;
  }

  /* exchange 字段（d:worried/p:wore/3:wears/i:wearing）→ 候选词形；两字母前缀直接切掉 */
  function formsOf(ex) {
    var out = [], parts = String(ex == null ? '' : ex).split('/');
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].slice(2).trim();
      if (t) out.push(t);
    }
    return out;
  }

  /* ---------- 索引：惰性建一次 ---------- */
  var IDX = null;

  function index() {
    if (IDX) return IDX;
    var byWord = {}, vocabForms = {}, glossForms = {}, i, j, f, g, w;
    var words = (window.EN_VOCAB && window.EN_VOCAB.words) || [];
    for (i = 0; i < words.length; i++) {
      w = words[i];
      byWord[w.w] = w;
      var fs = formsOf(w.ex);
      for (j = 0; j < fs.length; j++) if (!vocabForms[fs[j]]) vocabForms[fs[j]] = w.w;
    }
    var gloss = (A && A.gloss) || {};
    for (g in gloss) {
      if (!Object.prototype.hasOwnProperty.call(gloss, g)) continue;
      var gs = formsOf(gloss[g].ex);
      for (j = 0; j < gs.length; j++) if (!glossForms[gs[j]]) glossForms[gs[j]] = g;
    }
    IDX = { byWord: byWord, vocabForms: vocabForms, gloss: gloss, glossForms: glossForms };
    return IDX;
  }

  /* 只看词表（判超纲用）：小写词形 → 词形还原 → 词形变化反查 */
  function inVocab(w) {
    var x = index(), c = lemmaForms(w), i, b;
    if (x.byWord[w]) return true;
    for (i = 0; i < c.length; i++) if (x.byWord[c[i]]) return true;
    b = x.vocabForms[w];
    return !!(b && x.byWord[b]);
  }

  /* 四级兜底：查不到返回 null（点了什么都不弹，专有名词走这条） */
  function lookup(w) {
    var x = index(), c = lemmaForms(w), i, b;
    if (x.byWord[w]) return x.byWord[w];
    if (x.gloss[w]) return x.gloss[w];
    for (i = 0; i < c.length; i++) {
      if (x.byWord[c[i]]) return x.byWord[c[i]];
      if (x.gloss[c[i]]) return x.gloss[c[i]];
    }
    b = x.vocabForms[w] || x.glossForms[w];
    if (b) return x.byWord[b] || x.gloss[b] || null;
    return null;
  }

  /* 专有名词判据：该词形从没出现过全小写 → 一次也不标红、不入词典（与生成器一致） */
  function lowerSeen(paras) {
    var seen = {}, i, j, toks, t;
    for (i = 0; i < paras.length; i++) {
      toks = wordsOf(paras[i]);
      for (j = 0; j < toks.length; j++) {
        t = toks[j];
        if (t === t.toLowerCase()) seen[t] = 1;
      }
    }
    return seen;
  }

  /* ---------- 发音：浏览器自带 TTS，与 en/unit.js 同一套挑选 ---------- */
  var VOICES = [];

  function loadVoices() {
    try {
      VOICES = window.speechSynthesis.getVoices() || [];
    } catch (e) {
      VOICES = [];
    }
  }

  function say(word) {
    if (!word || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
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
      if (best) { u.voice = best; u.lang = best.lang; }
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* 没有可用语音就静默 */ }
  }

  /* ---------- 查义气泡 ---------- */
  var pop = null, active = null;

  function rectOf(el) {
    var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return r || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'en-pop';
    pop.setAttribute('role', 'dialog');
    document.body.appendChild(pop);
    pop.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest('.en-pop-say') && active) say(active.getAttribute('data-w'));
    });
    return pop;
  }

  function hidePop() {
    if (pop) pop.classList.remove('is-on');
    if (active) active.classList.remove('is-active');
    active = null;
  }

  function place(span) {
    var r = rectOf(span);
    var w = pop.offsetWidth || 300;
    var h = pop.offsetHeight || 150;
    var vw = window.innerWidth || 1024;
    var vh = window.innerHeight || 768;
    var left = r.left + r.width / 2 - w / 2;
    left = Math.max(10, Math.min(left, vw - w - 10));
    var top = r.bottom + 8;
    if (top + h > vh - 10) top = Math.max(10, r.top - h - 8);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }

  function showPop(span) {
    var low = span.getAttribute('data-w');
    var e = lookup(low);
    if (!e) return;
    var oov = span.classList.contains('is-oov');
    ensurePop();
    pop.innerHTML =
      '<div class="en-pop-top">' +
        '<b class="en-pop-word" lang="en">' + esc(span.textContent) + '</b>' +
        (e.ph ? '<span class="en-pop-ph">/' + esc(e.ph) + '/</span>' : '') +
        '<button class="en-pop-say" type="button" title="朗读这个词">发音</button>' +
      '</div>' +
      (oov ? '<p class="en-pop-tag">超纲词 · 不在四档 3,766 词表内</p>' : '') +
      '<p class="en-pop-tr">' + esc(lines(e.tr)) + '</p>' +
      (e.def ? '<p class="en-pop-def" lang="en">' + esc(lines(e.def)) + '</p>' : '');
    active = span;
    span.classList.add('is-active');
    pop.classList.add('is-on');
    place(span);
  }

  /* ---------- 正文渲染 ---------- */
  function markPara(p, seen) {
    var out = '', last = 0, m, tok, low, oov;
    WORDS_RE.lastIndex = 0;
    while ((m = WORDS_RE.exec(p))) {
      tok = m[0];
      low = tok.toLowerCase();
      if (!seen[low]) continue;                     /* 只大写出现 = 专有名词 */
      if (!lookup(low)) continue;                    /* 词典里也没有 → 静默，不包成可点词 */
      oov = !inVocab(low);
      out += esc(p.slice(last, m.index)) +
        '<span class="en-w' + (oov ? ' is-oov' : '') + '" data-w="' + esc(low) + '">' + esc(tok) + '</span>';
      last = m.index + tok.length;
    }
    return out + esc(p.slice(last));
  }

  /* ---------- 长段句界切块 ---------- */
  /* 超过 CHUNK_WORDS 词的段落按句子边界切成 .chunk 块，第 2 块起带 .cont
     （⸻ 弱衔接，样式见 reader.css）。只影响渲染，不动 payload.paras 数据。 */
  var CHUNK_WORDS = 55;
  /* 句界正则：句末标点 + 收尾引号，向前多吞一个可能是缩写/破折号残段的
     「. + --」边界（Stoker 体里有 clever!--in 这类），避免切丢词。 */
  var SENT_RE = /[^.!?…]+[.!?…]+[”’"']*(?:--)?(?:\s+|$)|[^.!?…]+$/g;
  var CHUNK_SEEN = null;   /* 当前篇的小写词形集合 */

  function chunkPara(text, host, no) {
    var badge = no ? '<button type="button" class="en-pno" data-no="' + no + '" title="查看本段详解">' + no + '</button>' : '';
    var sentences = [], m, last = 0;
    SENT_RE.lastIndex = 0;
    while ((m = SENT_RE.exec(text))) {
      if (m.index > last) sentences.push(text.slice(last, m.index));  /* 匹配间隙（嵌套引号等）并入前句 */
      sentences.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) sentences.push(text.slice(last));
    var blocks = [], cur = '', curN = 0, i, n;
    for (i = 0; i < sentences.length; i++) {
      n = wordsOf(sentences[i]).length;
      if (curN > 0 && curN + n > CHUNK_WORDS) { blocks.push(cur); cur = ''; curN = 0; }
      cur += sentences[i]; curN += n;
    }
    if (cur) blocks.push(cur);
    if (blocks.length < 2) { host.innerHTML = badge + markPara(text, CHUNK_SEEN); return; }
    for (i = 0; i < blocks.length; i++) {
      var sp = document.createElement('span');
      sp.className = 'chunk' + (i ? ' cont' : '');
      /* 段号小标只钉在段首块开头，续块不重复 */
      sp.innerHTML = (i === 0 ? badge : '') + markPara(blocks[i], CHUNK_SEEN);
      host.appendChild(sp);
    }
  }

  /* ---------- 超纲词三态开关 ---------- */
  /* off（无痕）/ soft（浅虚线）/ full（全标记）；默认 soft，用户切档写
     localStorage（无痕模式静默失败）。data-oov 属性驱动 CSS。 */
  var OOV_KEY = 'en-reading-oov';
  var OOV_MODES = ['off', 'soft', 'full'];

  function oovMode() {
    try {
      var v = localStorage.getItem(OOV_KEY);
      return OOV_MODES.indexOf(v) >= 0 ? v : 'soft';
    } catch (e) { return 'soft'; }
  }

  function setOovMode(m) {
    try { localStorage.setItem(OOV_KEY, m); } catch (e) { }
    var host = main.querySelector('.en-ws');
    if (host) host.setAttribute('data-oov', m);
  }

  function articleHead(a) {
    /* 标红的是「查得到释义的超纲词」。ECDICT 里完全没收录的超纲词查不到，
       静默不标（票 06 的四级兜底第 5 步），所以计量写的是**实际标红的个数**。 */
    var red = Math.max(0, (a.oovTypes || 0) - (a.missing || 0));
    return '<header class="en-head en-read-head">' +
      '<p class="en-eyebrow">英语阅读 · ' + esc(a.band) + ' 档 · 第 ' + pad2(a.no) + ' 篇</p>' +
      '<h1 class="en-title" lang="en">' + esc(a.title) + '</h1>' +
      '<p class="en-sub">' + esc(a.author) + ' · ' + num(a.words) + ' 词 · 超纲词 ' + red + ' · ' +
        'Gutenberg #' + esc(a.bookId) + ' · <span id="enReadState">未读完</span></p>' +
      '</header>';
  }

  /* ---------- 工具栏 / 导读 / 段卡 ---------- */
  function toolbar() {
    return '<div class="en-ws-bar">' +
      '<span class="en-ws-bar-title">精读工具</span>' +
      '<span class="en-ws-oov" role="group" aria-label="超纲词标记">' +
        '<button type="button" class="en-oov-btn" data-m="off">无痕</button>' +
        '<button type="button" class="en-oov-btn" data-m="soft">浅标</button>' +
        '<button type="button" class="en-oov-btn" data-m="full">全标</button>' +
      '</span>' +
    '</div>';
  }

  function guideCard(intro) {
    return '<section class="en-guide"><h3>篇首导读</h3>' +
      '<p>' + esc(intro || '本篇暂无导读。') + '</p></section>';
  }

  /* 段卡：notes.paras[i] = { tr, sen:[{en,zh}], pt:[...] }，三字段都可缺省。 */
  /* 段卡：默认折叠，点头部展开/收起；由正文联动打开时自动滚到位。 */
  function noteCard(no, n) {
    n = n || {};
    var body = '';
    if (n.tr) body += '<p class="tr">' + esc(n.tr) + '</p>';
    var i;
    if (n.sen && n.sen.length) {
      for (i = 0; i < n.sen.length; i++) {
        body += '<p class="sen"><span class="en" lang="en">' + esc(n.sen[i].en) + '</span>' + esc(n.sen[i].zh) + '</p>';
      }
    }
    if (n.pt && n.pt.length) {
      body += '<ul class="pt">';
      for (i = 0; i < n.pt.length; i++) body += '<li>' + esc(n.pt[i]) + '</li>';
      body += '</ul>';
    }
    if (!n.tr && !(n.sen && n.sen.length) && !(n.pt && n.pt.length)) {
      body += '<p class="tr en-pcard-empty">本段暂无详解。</p>';
    }
    return '<section class="en-pcard" data-no="' + no + '">' +
      '<button class="en-pcard-h" type="button" aria-expanded="false">' +
      '<span class="no">段 ' + no + '</span><span class="tidy" aria-hidden="true"></span></button>' +
      '<div class="en-pcard-b">' + body + '</div></section>';
  }

  /* 展开/收起某张段卡；open 缺省 = 切换。返回是否已展开。 */
  function toggleCard(card, open) {
    if (!card || !card.classList.contains('en-pcard')) return false;
    var willOpen = typeof open === 'boolean' ? open : !card.classList.contains('open');
    card.classList.toggle('open', willOpen);
    var h = card.querySelector('.en-pcard-h');
    if (h) h.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    return willOpen;
  }

  /* 联动打开：展开段卡并让它在右栏内可见（不拽动整页滚动）。 */
  function openCard(no) {
    var side = document.getElementById('enSide');
    if (!side || !no) return;
    var card = side.querySelector('.en-pcard[data-no="' + no + '"]');
    if (!card) return;
    if (card.classList.contains('open')) {
      /* 已展开 → 再点 = 折叠回去（滚动联动只改高亮，不动开合） */
      toggleCard(card, false);
    } else {
      toggleCard(card, true);
      if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
    }
  }

  function articleFoot() {
    return '<div class="en-read-foot">' +
      '<button class="en-btn" type="button" id="enMarkDone">标记为已读完</button>' +
      '<a class="en-btn en-btn-quiet" href="../index.html">返回篇目</a>' +
      '<span class="en-foot-tip" id="enFootTip">读完点左边盖章；门户与篇目页的数字会跟着变。</span>' +
      '</div>';
  }

  function renderArticle() {
    var paras = A.paras || [];
    CHUNK_SEEN = lowerSeen(paras);
    var notes = A.notes;

    var out = toolbar() +
      '<div class="en-ws" data-oov="' + oovMode() + '">' +
      '<div class="en-ws-main">' + articleHead(A) +
      '<article class="en-article" id="enArticle" lang="en">';
    var i;
    for (i = 0; i < paras.length; i++) out += '<p class="en-para" data-no="' + (i + 1) + '"></p>';
    out += '</article>' + articleFoot() + '</div>';

    /* 右栏：导读 + 段卡（sticky）。无详解时优雅降级，不报错。 */
    out += '<aside class="en-ws-side" id="enSide">';
    if (notes) {
      out += guideCard(notes.intro);
      for (i = 0; i < (notes.paras || []).length; i++) out += noteCard(i + 1, notes.paras[i]);
    } else {
      out += guideCard(null) +
        '<section class="en-pcard open"><h4><span class="no">逐段详解</span></h4>' +
        '<p class="tr en-pcard-empty">本篇的逐段详解还在编写中，完成后会自动出现在这里。</p></section>';
    }
    out += '</aside></div>';

    main.innerHTML = out;

    /* 正文切块渲染（占位后逐段填充） */
    var ps = main.querySelectorAll('.en-para');
    for (i = 0; i < paras.length && i < ps.length; i++) chunkPara(paras[i], ps[i], i + 1);

    bindArticle();
  }

  /* 段卡联动：点正文段 → 右栏对应段卡高亮。 */
  function highlightCard(no) {
    var side = document.getElementById('enSide');
    if (!side || !no) return;
    var cards = side.querySelectorAll('.en-pcard');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('hit', cards[i].getAttribute('data-no') === no);
    }
  }

  /* 滚动联动：正文段落进入视口 → 段卡高亮（不抢滚动） */
  function bindScrollSpy() {
    if (!window.IntersectionObserver) return;
    var paras = main.querySelectorAll('.en-para');
    var spy = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) highlightCard(entries[i].target.getAttribute('data-no'));
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    for (var i = 0; i < paras.length; i++) spy.observe(paras[i]);
  }

  /* 段卡点击：展开/收起；展开时高亮自身并同步正文段（若在视口附近） */
  function bindSideCards() {
    var side = document.getElementById('enSide');
    if (!side) return;
    side.addEventListener('click', function (ev) {
      var h = ev.target && ev.target.closest ? ev.target.closest('.en-pcard-h') : null;
      if (!h) return;
      var card = h.closest('.en-pcard');
      toggleCard(card);
      if (card.classList.contains('open')) highlightCard(card.getAttribute('data-no'));
    });
  }

  /* 页级完成：jlpt-progress 的 reading/<档>/<NN>.html（progress.js 会取末三段） */
  function pageKey() {
    return 'en/reading/' + A.band + '/' + pad2(A.no) + '.html';
  }

  function syncDone() {
    var btn = document.getElementById('enMarkDone');
    var meter = document.getElementById('enReadState');
    var tip = document.getElementById('enFootTip');
    var LP = window.LibProgress;
    var done = !!(LP && LP.isDone(pageKey()));
    if (btn) btn.textContent = done ? '已读完（点击取消）' : '标记为已读完';
    if (btn) btn.classList.toggle('is-done', done);
    if (meter) {
      meter.textContent = done ? '已读完' : '未读完';
      meter.classList.toggle('is-full', done);
    }
    if (tip) tip.textContent = done ? '已记进学习进度，门户与篇目页的「已读」都算上了。'
      : '读完点左边盖章；门户与篇目页的数字会跟着变。';
  }

  function bindArticle() {
    var art = document.getElementById('enArticle');
    var btn = document.getElementById('enMarkDone');
    ensurePop();
    if (art) {
      art.addEventListener('click', function (ev) {
        var t = ev.target;
        var span = t && t.closest ? t.closest('.en-w') : null;
        if (!span) {
          /* 段号小标：展开右栏对应段卡并滚到可见；点段落其它空白处同样定位 */
          var badge = t && t.closest ? t.closest('.en-pno') : null;
          var para = t && t.closest ? t.closest('.en-para') : null;
          if (para) { highlightCard(para.getAttribute('data-no')); openCard(para.getAttribute('data-no')); }
          return;
        }
        if (span === active) { hidePop(); return; }   /* 再点同一个词 = 收起 */
        hidePop();
        showPop(span);
      });
    }
    /* 超纲词三态按钮 */
    var group = main.querySelector('.en-ws-oov');
    if (group) {
      syncOovBtns();
      group.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('.en-oov-btn') : null;
        if (!b) return;
        setOovMode(b.getAttribute('data-m'));
        syncOovBtns();
      });
    }
    /* 点别处、按 Esc 都收起 */
    document.addEventListener('click', function (ev) {
      if (!active) return;
      var t = ev.target;
      if (t && t.closest && (t.closest('.en-w') || t.closest('.en-pop'))) return;
      hidePop();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') hidePop();
    });
    if (btn) {
      btn.addEventListener('click', function () {
        var LP = window.LibProgress;
        if (!LP) return;
        if (LP.isDone(pageKey())) LP.unmark(pageKey());
        else LP.markDone(pageKey());
        syncDone();
      });
    }
    syncDone();
    bindScrollSpy();
    bindSideCards();
  }

  function syncOovBtns() {
    var mode = oovMode();
    var btns = main.querySelectorAll('.en-oov-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-m') === mode);
    }
  }

  /* ---------- 篇目页：只做「已读」状态与计数 ---------- */
  function renderIndex() {
    var LP = window.LibProgress;
    var rows = listHost.querySelectorAll('[data-en-key]');
    var seen = {}, keys = [], i, k, n = 0;
    for (i = 0; i < rows.length; i++) {
      k = rows[i].getAttribute('data-en-key');
      if (!seen[k]) { seen[k] = 1; keys.push(k); }
      rows[i].classList.toggle('is-done', !!(LP && LP.isDone(k)));
    }
    for (i = 0; i < keys.length; i++) if (LP && LP.isDone(keys[i])) n++;
    var meter = document.getElementById('enReadDone');
    if (meter) {
      meter.textContent = '已读 ' + n + '/' + keys.length;
      meter.classList.toggle('is-full', n > 0 && n === keys.length);
    }
    /* 每档标题上补一个「已读 x/n」（幂等：只建一次） */
    var blocks = listHost.querySelectorAll('.en-band-block');
    for (i = 0; i < blocks.length; i++) {
      var bl = blocks[i];
      var h = bl.querySelector('.en-band-h');
      var list = bl.querySelectorAll('[data-en-key]');
      if (!h || !list.length) continue;
      var c = 0;
      for (var j = 0; j < list.length; j++) {
        var kk = list[j].getAttribute('data-en-key');
        if (LP && LP.isDone(kk)) c++;
      }
      var sp = h.querySelector('.en-band-done');
      if (!sp) {
        sp = document.createElement('span');
        sp.className = 'en-band-done';
        h.appendChild(sp);
      }
      sp.textContent = '已读 ' + c + '/' + list.length;
      sp.classList.toggle('is-full', c === list.length);
    }
  }

  /* ---------- 对外接缝（测试与调试用） ---------- */
  window.EnReader = {
    wordsOf: wordsOf,
    lemmaForms: lemmaForms,
    formsOf: formsOf,
    inVocab: inVocab,
    lookup: lookup,
    markPara: function (p) { return markPara(p, lowerSeen([p])); },
    index: index,
    say: say,
    hidePop: hidePop,
    state: function () {
      return {
        page: main && A ? 'article' : (listHost ? 'list' : 'none'),
        active: active ? active.getAttribute('data-w') : null,
        popped: !!(pop && pop.classList.contains('is-on')),
        done: !!(window.LibProgress && A && window.LibProgress.isDone(pageKey())),
        red: redTypes()
      };
    }
  };

  function redTypes() {
    var seen = {}, out = [];
    var els = document.querySelectorAll('.en-w.is-oov');
    for (var i = 0; i < els.length; i++) {
      var w = els[i].getAttribute('data-w');
      if (!seen[w]) { seen[w] = 1; out.push(w); }
    }
    return out.sort();
  }

  /* ---------- 启动 ---------- */
  loadVoices();
  if (window.speechSynthesis && window.speechSynthesis.addEventListener) {
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
  }
  if (main && A && A.paras) renderArticle();
  else if (listHost) renderIndex();
})();
