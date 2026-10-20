/* 个人工作站 主题切换（浅色/深色）＋ PDF 下载
 * 所有页面共用：在 <head> 中以普通 <script> 引入，
 * 会立即根据 localStorage 恢复主题以避免闪烁；DOM 就绪后把三档外观控件（图标）挂到
 * [data-theme-slot]（没有就退回左下角固定），PDF 导出按钮单独留在右上角。
 *
 * PDF 下载走浏览器打印（用户在打印框选「另存为 PDF」），文字可选可搜、振假名不走样。
 * 页面侧接口 window.LibPdf：
 *   setState('enabled' | 'hidden' | 'disabled', 提示)  —— 交互页按当前屏决定可否导出
 *   setTitle(标题)        —— 覆盖文件名与页脚里的页面标题（默认 document.title）
 *   setBuilder(fn)        —— fn() 返回 HTML：打印时只输出这段（真题即时生成整卷）
 * 事件：导出前 document 派发 'libpdf:before'，结束后派发 'libpdf:after'，
 *       各模块借此临时补出打印专用内容（完整词表、生词表等）。 */
(function () {
  var KEY = 'jp-lib-theme';

  function getSaved() {
    try { return localStorage.getItem(KEY) || 'light'; } catch (e) { return 'light'; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }
  function apply(v) {
    document.documentElement.setAttribute('data-theme', v);
  }

  var current = getSaved();
  apply(current);

  /* ====================== PDF 下载：配置 ======================
   * 这一段必须声明在 ready() 之前：ready() 在 document.readyState !== 'loading' 时
   * 会同步执行回调，回调里调用 pdfMount() → pdfSync()，用到 pdf / PDF_PAGES；
   * 若声明晚于 ready()，同步路径会读到 undefined 而抛 TypeError。 */
  var PDF_KEY = 'jp-lib-pdf-theme';
  /* base：打印时 data-theme 取值；pdf：额外的 data-pdf（PDF 专用主题，令牌见 style.css） */
  var PDF_THEMES = [
    { id: 'washi', label: '和纸教科书', note: '明朝体 · 白纸朱线', base: 'light', pdf: 'washi' },
    { id: 'compact', label: '紧凑速查', note: '小字号 · 省页数', base: 'light', pdf: 'compact' },
    { id: 'light', label: '浅色', note: '与网页浅色一致', base: 'light' },
    { id: 'eye', label: '护眼', note: '柔绿底色', base: 'eye' },
    { id: 'dark', label: '深色', note: '深底浅字 · 适合屏幕', base: 'dark' }
  ];
  /* 覆盖范围：学习资料单元页 / 课堂单词单元 / 英语词表单元 / 英语阅读文章 / 真题（由页面自行切换状态）。
     其余页面（门户、索引、听写、打字）不出按钮。 */
  var PDF_PAGES = [
    /\/n[1-5]\/[^/]+\/[^/]+\.html$/,
    /\/jp-vocab\/[^/]+\/(index\.html)?$/,
    /\/en\/[1-4]k\/\d+\.html$/,
    /\/en\/reading\/[1-4]k\/\d+\.html$/
  ];
  function pdfCovered() {
    var p = decodeURIComponent(location.pathname);
    for (var i = 0; i < PDF_PAGES.length; i++) if (PDF_PAGES[i].test(p)) return true;
    return false;
  }
  var pdf = { state: pdfCovered() ? 'enabled' : 'hidden', msg: '', title: '', builder: null, btn: null, pop: null, busy: false };

  function ready(fn) {
    if (document.readyState !== 'loading') { fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  }

  /* 三档外观：照 MyHOT 的 radiogroup —— 图标 + sr-only 文字 + 滑动指示块。
     挂在页面给的 [data-theme-slot]（门户左栏底部 / 子页 56px 条底部）；
     没给 slot 的页面退回左下角固定。 */
  var MODES = [
    { id: 'light', label: '浅色', icon: 'sun' },
    { id: 'eye', label: '护眼', icon: 'eye' },
    { id: 'dark', label: '深色', icon: 'moon' }
  ];

  function mountToggle() {
    var slot = document.querySelector('[data-theme-slot]');
    var box = document.createElement('div');
    box.className = 'theme-toggle';
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', '外观');

    var html = '<span class="tt-thumb" aria-hidden="true"></span>';
    for (var i = 0; i < MODES.length; i++) {
      html += '<button type="button" role="radio" data-v="' + MODES[i].id + '"' +
        ' title="' + MODES[i].label + '" aria-checked="false" tabindex="-1">' +
        '<span class="im im-' + MODES[i].icon + '" aria-hidden="true"></span>' +
        '<span class="sr-only">' + MODES[i].label + '</span></button>';
    }
    box.innerHTML = html;
    (slot || document.body).appendChild(box);
    if (!slot) box.classList.add('is-floating');

    var btns = box.querySelectorAll('button');
    function sync() {
      var idx = 0;
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-v') === current;
        btns[i].classList.toggle('on', on);
        btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
        btns[i].setAttribute('tabindex', on ? '0' : '-1');
        if (on) idx = i;
      }
      box.style.setProperty('--i', idx);
    }
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function () {
        current = this.getAttribute('data-v');
        save(current);
        apply(current);
        sync();
      });
    }
    /* radiogroup 的键盘规矩：左右方向键在档位间移动 */
    box.addEventListener('keydown', function (ev) {
      var delta = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      ev.preventDefault();
      var at = 0;
      for (var i = 0; i < MODES.length; i++) if (MODES[i].id === current) at = i;
      var next = MODES[(at + delta + MODES.length) % MODES.length];
      current = next.id;
      save(current);
      apply(current);
      sync();
      var focusBtn = box.querySelector('button[data-v="' + current + '"]');
      if (focusBtn) focusBtn.focus();
    });
    sync();
  }

  function mountPdfDock() {
    var dock = document.createElement('div');
    dock.className = 'pdf-dock';
    document.body.appendChild(dock);
    pdfMount(dock);
  }

  ready(function () {
    mountToggle();
    mountPdfDock();
  });

  /* ====================== PDF 下载：运行时接口 ====================== */
  window.LibPdf = {
    setState: function (s, msg) {
      pdf.state = s || 'enabled';
      pdf.msg = msg || '';
      pdfSync();
    },
    setTitle: function (t) { pdf.title = t || ''; },
    setBuilder: function (fn) { pdf.builder = typeof fn === 'function' ? fn : null; }
  };

  function pdfTheme(id) {
    for (var i = 0; i < PDF_THEMES.length; i++) if (PDF_THEMES[i].id === id) return PDF_THEMES[i];
    return PDF_THEMES[0];
  }
  function pdfSaved() {
    try { return pdfTheme(localStorage.getItem(PDF_KEY)).id; } catch (e) { return PDF_THEMES[0].id; }
  }

  function pdfMount(box) {
    var sep = document.createElement('span');
    sep.className = 'ts-sep';
    sep.setAttribute('aria-hidden', 'true');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ts-pdf';
    btn.textContent = '下载 PDF';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    box.appendChild(sep);
    box.appendChild(btn);
    pdf.btn = btn;

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pdf.pop) pdfClose(); else pdfOpen();
    });
    document.addEventListener('click', function (ev) {
      if (pdf.pop && !pdf.pop.contains(ev.target)) pdfClose();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && pdf.pop) { pdfClose(); btn.focus(); }
    });
    pdfSync();
  }

  function pdfSync() {
    var b = pdf.btn;
    if (!b) return;
    var hide = pdf.state === 'hidden';
    b.hidden = hide;
    if (b.previousSibling) b.previousSibling.hidden = hide;
    if (b.parentNode && b.parentNode.classList.contains('pdf-dock')) b.parentNode.hidden = hide;
    b.classList.toggle('is-off', pdf.state === 'disabled');
    b.title = pdf.state === 'disabled' ? pdf.msg : '把当前页面导出为 PDF';
    if (hide || pdf.state === 'disabled') pdfClose();
  }

  function pdfOpen() {
    var pop = document.createElement('div');
    pop.className = 'pdf-pop';
    pop.setAttribute('role', 'menu');
    if (pdf.state === 'disabled') {
      pop.innerHTML = '<p class="pdf-pop-msg">' + escHtml(pdf.msg || '当前不可导出') + '</p>';
    } else {
      var last = pdfSaved(), h = '<p class="pdf-pop-h">选择 PDF 主题</p>';
      for (var i = 0; i < PDF_THEMES.length; i++) {
        var t = PDF_THEMES[i];
        h += '<button type="button" role="menuitem" data-pdf="' + t.id + '"' +
          (t.id === last ? ' class="on"' : '') + '><b>' + t.label + '</b><small>' + t.note +
          (t.id === last ? ' · 上次使用' : '') + '</small></button>';
      }
      h += '<p class="pdf-pop-tip">在打印对话框中选择「另存为 PDF」</p>';
      pop.innerHTML = h;
      pop.addEventListener('click', function (ev) {
        var el = ev.target.closest ? ev.target.closest('button[data-pdf]') : null;
        if (!el) return;
        pdfClose();
        pdfExport(el.getAttribute('data-pdf'));
      });
    }
    pdf.btn.parentNode.appendChild(pop);
    pdf.pop = pop;
    pdf.btn.setAttribute('aria-expanded', 'true');
    var on = pop.querySelector('button.on');
    if (on) on.focus();
  }

  function pdfClose() {
    if (!pdf.pop) return;
    pdf.pop.parentNode.removeChild(pdf.pop);
    pdf.pop = null;
    if (pdf.btn) pdf.btn.setAttribute('aria-expanded', 'false');
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function cssStr(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
  }
  function fileName(title, themeLabel) {
    var t = String(title).replace(/[\\\/:*?"<>|]/g, '').replace(/[\s\u3000]+/g, '')
      .replace(/[·・]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return 'JLPT_' + t + '_' + themeLabel;
  }

  function pdfExport(id) {
    if (pdf.busy || pdf.state !== 'enabled') return;
    var t = pdfTheme(id);
    try { localStorage.setItem(PDF_KEY, t.id); } catch (e) {}
    var root = document.documentElement;
    var pageTitle = pdf.title || document.title;
    var saved = { title: document.title, theme: root.getAttribute('data-theme') };
    var opened = [];
    var extra = null;
    pdf.busy = true;

    root.setAttribute('data-theme', t.base);
    if (t.pdf) root.setAttribute('data-pdf', t.pdf);
    root.classList.add('pdf-printing');
    document.dispatchEvent(new CustomEvent('libpdf:before', { detail: { theme: t.id } }));

    if (pdf.builder) {
      extra = document.createElement('div');
      extra.id = 'pdf-root';
      extra.className = 'wrap';
      extra.innerHTML = pdf.builder();
      document.body.appendChild(extra);
      root.classList.add('pdf-has-root');
    }

    /* 答案与解析等折叠块一律展开，导出后还原 */
    var ds = document.querySelectorAll('details:not([open])');
    for (var i = 0; i < ds.length; i++) { ds[i].open = true; opened.push(ds[i]); }

    var page = document.createElement('style');
    page.id = 'pdf-page-style';
    var compact = t.id === 'compact';
    page.textContent = '@page{size:A4;margin:' + (compact ? '8mm 9mm 12mm' : '14mm 13mm 16mm') + ';' +
      '@top-left{content:none}@top-center{content:none}@top-right{content:none}' +
      '@bottom-left{content:none}@bottom-right{content:none}' +
      '@bottom-center{content:' + cssStr(pageTitle + ' · 第 ') + ' counter(page) " / " counter(pages) " 页";' +
      'font-size:8.5pt;color:#777;font-family:"Noto Sans JP","Yu Gothic","Microsoft YaHei",sans-serif}}';
    document.head.appendChild(page);
    document.title = fileName(pageTitle, t.label);

    var done = false;
    function restore() {
      if (done) return;
      done = true;
      window.removeEventListener('afterprint', restore);
      for (var j = 0; j < opened.length; j++) opened[j].open = false;
      if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
      if (page.parentNode) page.parentNode.removeChild(page);
      root.classList.remove('pdf-printing', 'pdf-has-root');
      root.removeAttribute('data-pdf');
      if (saved.theme) root.setAttribute('data-theme', saved.theme);
      document.title = saved.title;
      document.dispatchEvent(new CustomEvent('libpdf:after'));
      pdf.busy = false;
    }
    window.addEventListener('afterprint', restore);
    /* 等一帧让主题与补出的内容完成布局，再弹打印框 */
    setTimeout(function () {
      try { window.print(); } catch (e) { restore(); }
      /* 部分移动浏览器不派发 afterprint：回到页面（重新获得焦点）时兜底还原 */
      setTimeout(function () { window.addEventListener('focus', restore, { once: true }); }, 1000);
    }, 60);
  }
})();
