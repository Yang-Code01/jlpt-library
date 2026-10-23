/* ============================================================================
   日语阅读 · 视图层
   只读 window.JP_READING 渲染，不做任何「这词算不算生词」的判断 ——
   那是生成器的活（页面上的 data-o 已经标好了）。判据分叉过一次就会对不上，
   所以这里连词表都不改写。
   ========================================================================== */
(function () {
  'use strict';

  var P = window.JP_READING;
  var main = document.getElementById('jpRead');
  if (!main || !P) return;

  var w = P.work;
  var x = P.excerpt;

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function pageKey() { return location.pathname; }

  /* ------------------------------------------------------------- 页头 */

  function headHtml() {
    var band = w.band.toUpperCase();
    return '' +
      '<header class="jp-head">' +
        '<p class="jp-eyebrow">日语阅读 · ' + band + ' 档</p>' +
        '<h1 class="jp-title">' + esc(w.title) +
          '<span class="jp-yomi">' + esc(w.kana) + '</span>' +
        '</h1>' +
        '<p class="jp-sub">' + esc(w.author) +
          '　·　节选 ' + x.chars + ' 字 / ' + P.body.length + ' 段' +
          '　·　非高频词 ' + P.oov.length + ' 个' +
        '</p>' +
        '<p class="jp-note">非高频词已高亮（判据：词典里没有频率标签）。正文任意词都可以点开看读音、词性与释义；' +
          '每段下面的「注」里有中文译文、语法点与背景。</p>' +
      '</header>';
  }

  function introHtml() {
    if (!P.notes.intro) return '';
    var paras = String(P.notes.intro).split('\n').filter(function (l) { return l.trim(); });
    return '<section class="jp-card jp-intro" aria-label="作品背景">' +
      '<h2 class="jp-card-h">读之前</h2>' +
      paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') +
      '</section>';
  }

  /* ------------------------------------------------------------- 正文 */

  function noteHtml(n) {
    var h = '<div class="jp-note-sec"><h3>译文</h3><p>' + esc(n.tr) + '</p></div>';
    if (n.sen && n.sen.length) {
      h += '<div class="jp-note-sec"><h3>语法点</h3><ul>' +
        n.sen.map(function (s) {
          return '<li><span class="jp-sen-jp">' + esc(s.jp) + '</span>' + esc(s.zh) + '</li>';
        }).join('') + '</ul></div>';
    }
    if (n.pt && n.pt.length) {
      h += '<div class="jp-note-sec"><h3>语言点・背景</h3><ul>' +
        n.pt.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
    }
    return h;
  }

  function paraHtml(i) {
    return '<div class="jp-para" data-i="' + i + '">' +
      '<p class="jp-line">' + P.body[i] + '</p>' +
      '<button class="jp-note-btn" type="button" data-i="' + i + '" aria-expanded="false" aria-controls="jpNote' + i + '">注</button>' +
      '<div class="jp-note-body" id="jpNote' + i + '" hidden>' + noteHtml(P.notes.paras[i] || {}) + '</div>' +
      '</div>';
  }

  function bodyHtml() {
    return '<section class="jp-body" aria-label="正文">' +
      P.body.map(function (_, i) { return paraHtml(i); }).join('') +
      '</section>';
  }

  /* ------------------------------------------------------------- 页脚 */

  function bibRow(label, value) {
    if (!value) return '';
    return '<div class="jp-bib-row"><dt>' + label + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function footHtml() {
    var done = !!(window.LibProgress && window.LibProgress.isDone(pageKey()));
    return '' +
      '<section class="jp-foot">' +
        '<div class="jp-actions">' +
          '<button class="jp-btn" type="button" id="jpMarkDone"' + (done ? ' data-done="1"' : '') + '>' +
            (done ? '已读完（点击取消）' : '标记为已读完') +
          '</button>' +
          '<a class="jp-btn jp-btn-quiet" href="../index.html">返回篇目</a>' +
          '<span class="jp-tip">读完点左边盖章；门户与篇目页的数字会跟着变。</span>' +
        '</div>' +
        '<dl class="jp-bib">' +
          bibRow('作品', w.title + '（' + w.kana + '）') +
          bibRow('著者', w.author) +
          bibRow('节选', '第 ' + (x.from + 1) + '–' + x.to + ' 段 / 全文 ' + x.fullParas + ' 段、' + x.fullChars + ' 字') +
          bibRow('底本', w.bib) +
          bibRow('底本の親本', w.parentBib) +
          bibRow('入力', w.input) +
          bibRow('校正', w.proof) +
          bibRow('文字遣い', w.kanaType) +
          bibRow('公開', w.released) +
          bibRow('最終修正', w.revised) +
        '</dl>' +
        '<p class="jp-credit">' +
          '正文来自<a href="' + esc(w.cardUrl) + '" rel="noopener">青空文庫 図書カード</a>（公有领域，原文一字未改；' +
          '抬头与尾注已移入本栏）。词典数据派生自 JMdict（CC BY-SA 4.0），中文释义为本页注释的一部分。' +
          '站点整体 CC BY-NC 4.0。' +
        '</p>' +
      '</section>';
  }

  /* ------------------------------------------------------------- 弹层 */

  var pop = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'jp-pop';
    pop.id = 'jpPop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '词语释义');
    pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  }

  function hidePop() {
    if (pop) pop.hidden = true;
  }

  function place(span) {
    var el = ensurePop();
    var r = span.getBoundingClientRect ? span.getBoundingClientRect() : { left: 0, bottom: 0 };
    var vw = window.innerWidth || 1024;
    el.hidden = false;
    var pw = el.offsetWidth || 240;
    var left = Math.min(Math.max(8, r.left - 8), Math.max(8, vw - pw - 8));
    el.style.left = left + 'px';
    el.style.top = (r.bottom + (window.pageYOffset || 0) + 6) + 'px';
  }

  function showPop(span) {
    var lemma = span.getAttribute('data-l');
    var t = P.terms[lemma] || {};
    var surface = (span.textContent || '').trim();
    var miss = span.classList.contains('u') || (!t.pos && !t.en && !t.zh);
    var h = '<div class="jp-pop-h">' + esc(lemma);
    if (t.kana && t.kana !== lemma) h += '<span class="jp-pop-kana">' + esc(t.kana) + '</span>';
    h += '</div>';
    if (surface && surface !== lemma) h += '<p class="jp-pop-form">文中の形：' + esc(surface) + '</p>';
    h += '<p class="jp-pop-pos">' + esc(t.pos || '—') + '</p>';
    if (t.zh) h += '<p class="jp-pop-zh">' + esc(t.zh) + '</p>';
    if (t.en) h += '<p class="jp-pop-en">' + esc(t.en) + '</p>';
    if (miss) {
      h += '<p class="jp-pop-miss">' +
        (span.classList.contains('u') ? '词典里没有这一条（多为专名或方言词），中文释义未収録。' : '中文释义未収録，先看上面的读音与英文释义。') +
        '</p>';
    }
    var el = ensurePop();
    el.innerHTML = h;
    place(span);
  }

  /* ------------------------------------------------------------- 事件 */

  function bindNotes() {
    main.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.jp-note-btn') : null;
      if (!btn) return;
      var i = btn.getAttribute('data-i');
      var body = document.getElementById('jpNote' + i);
      if (!body) return;
      var open = body.hasAttribute('hidden');
      if (open) body.removeAttribute('hidden');
      else body.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? '收起' : '注';
    });
  }

  function bindWords() {
    main.addEventListener('click', function (e) {
      var span = e.target.closest ? e.target.closest('.w') : null;
      if (!span || !main.contains(span)) { hidePop(); return; }
      e.stopPropagation();
      showPop(span);
    });
    document.addEventListener('click', function (e) {
      if (pop && !pop.hidden && e.target !== pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest('.w'))) hidePop();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hidePop(); });
  }

  function syncDone() {
    var btn = document.getElementById('jpMarkDone');
    if (!btn) return;
    var done = !!(window.LibProgress && window.LibProgress.isDone(pageKey()));
    btn.textContent = done ? '已读完（点击取消）' : '标记为已读完';
    if (done) btn.setAttribute('data-done', '1');
    else btn.removeAttribute('data-done');
  }

  function bindDone() {
    var btn = document.getElementById('jpMarkDone');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var LP = window.LibProgress;
      if (!LP) return;
      if (LP.isDone(pageKey())) LP.unmark(pageKey());
      else LP.markDone(pageKey());
      syncDone();
    });
  }

  /* ------------------------------------------------------------- 启动 */

  main.innerHTML = headHtml() + introHtml() + bodyHtml() + footHtml();
  bindNotes();
  bindWords();
  bindDone();
  syncDone();
})();
