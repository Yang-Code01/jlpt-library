/* 日语学习资料库 · 学习进度
 *
 * 单元页：每个知识点模块一个勾选框；本页模块全部勾完 → 顶部「已看过」自动勾选，
 *        并显示本页勾选百分比（如 4/10 · 40%）。
 * 索引页：汇总显示——单元卡盖朱印、分组计数、级别计数、总进度条。
 *
 * 数据存 localStorage（单设备、单浏览器），可导出 / 导入 JSON 备份。
 * 与 theme.js 一样以普通 <script> 引入，无依赖。
 *
 * 存储结构：
 *   { v: 2,
 *     done: { "n5/grammar/01.html":        1757152320000 },   页面级
 *     mod:  { "n5/grammar/01.html#gp1":    1757152320000 } }  模块级
 *   页面级由模块级推导：模块全勾完才写 done，取消任一模块即删除。
 */
(function () {
  'use strict';

  var KEY = 'jlpt-progress';
  var VERSION = 2;

  /* ====================== 存储 ====================== */
  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && typeof o === 'object' && o.done && typeof o.done === 'object') {
        if (!o.mod || typeof o.mod !== 'object') o.mod = {};
        o.v = VERSION;          // 旧数据读入即升版（模块记录由 refresh 惰性补齐）
        return o;
      }
    } catch (e) {}
    return { v: VERSION, done: {}, mod: {} };
  }
  var data = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }
  function count() { return Object.keys(data.done).length; }
  function countMod() { return Object.keys(data.mod).length; }

  /* ====================== 单元标识 ======================
     key 取路径末三段（级别/分类/文件），与索引页 <a href> 完全一致，
     因此不受 GitHub Pages 子目录影响。模块 key 再加 "#模块id"。   */
  function keyOf(p) {
    return String(p || '').split(/[?#]/)[0].split('/').filter(Boolean).slice(-3).join('/');
  }
  function isUnit(k) { return /^n[1-5]\/[^/]+\/[^/]+\.html$/.test(k); }
  function isMod(k) { return /^n[1-5]\/[^/]+\/[^/]+\.html#.+$/.test(k); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtShort(ts) {
    var d = new Date(ts);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function stamp() {
    var d = new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  /* ====================== 知识点模块识别 ======================
     两类页面，取其一：
       语法/基础页  div.gp[id]                        （966 个，每页 4–19 个）
       词汇页       section.card[id]（排除 #quiz）    （458 个）
     两者 id 在页内均唯一，故 "页面key#id" 可作稳定标识。 */
  function moduleEls() {
    var gp = document.querySelectorAll('div.gp[id]');
    if (gp.length) return gp;
    var out = [], secs = document.querySelectorAll('section.card[id]'), i;
    for (i = 0; i < secs.length; i++) if (secs[i].id !== 'quiz') out.push(secs[i]);
    return out;
  }
  /* ====================== 单元页：模块勾选框 + 页面总控 ====================== */
  var pageKey = null;
  var mods = [];
  var controls = [];

  function syncMod(m) {
    var ts = data.mod[m.key];
    m.input.checked = !!ts;
    m.wrap.classList.toggle('is-done', !!ts);
  }

  function syncControl(c, done, total) {
    var ts = data.done[c.key];
    var full = total > 0 && done === total;
    c.input.checked = total > 0 ? full : !!ts;
    c.wrap.classList.toggle('is-done', c.input.checked);
    c.pct.textContent = total ? done + '/' + total + ' · ' + Math.round(done / total * 100) + '%' : '';
    if (ts) {
      c.time.textContent = fmtShort(ts);
      c.time.setAttribute('datetime', new Date(ts).toISOString());
      c.time.title = '勾选于 ' + new Date(ts).toLocaleString();
    } else {
      c.time.textContent = '';
      c.time.removeAttribute('datetime');
      c.time.removeAttribute('title');
    }
  }

  /* 该页是否已有任何模块记录 */
  function hasAnyMod(key) {
    for (var k in data.mod) {
      if (Object.prototype.hasOwnProperty.call(data.mod, k) && k.indexOf(key + '#') === 0) return true;
    }
    return false;
  }

  /* 由模块状态推导页面状态，再回写全部控件 */
  function refresh() {
    var i, done = 0, total = mods.length;
    for (i = 0; i < mods.length; i++) if (data.mod[mods[i].key]) done++;

    if (total > 0) {
      if (done === total) { if (!data.done[pageKey]) data.done[pageKey] = Date.now(); }
      else delete data.done[pageKey];
    }
    save();

    for (i = 0; i < mods.length; i++) syncMod(mods[i]);
    for (i = 0; i < controls.length; i++) syncControl(controls[i], done, total);
  }

  function makeControl(key) {
    var wrap = document.createElement('label');
    wrap.className = 'pg-check';
    wrap.title = '本页知识点全部勾完后自动勾选；点此可一键标记／取消本页全部知识点。';
    wrap.innerHTML =
      '<input type="checkbox" class="pg-input">' +
      '<span class="pg-seal" aria-hidden="true">済</span>' +
      '<span class="pg-text">已看过</span>' +
      '<span class="pg-pct"></span>' +
      '<time class="pg-time"></time>';
    var c = {
      key: key,
      wrap: wrap,
      input: wrap.querySelector('.pg-input'),
      pct: wrap.querySelector('.pg-pct'),
      time: wrap.querySelector('.pg-time')
    };
    c.input.addEventListener('change', function () {
      var want = c.input.checked, now = Date.now(), i;
      if (!mods.length) {                       // 无模块的页面：退回手工标记
        if (want) data.done[key] = now; else delete data.done[key];
      } else {
        for (i = 0; i < mods.length; i++) {
          if (want) { if (!data.mod[mods[i].key]) data.mod[mods[i].key] = now; }
          else delete data.mod[mods[i].key];
        }
      }
      refresh();
    });
    controls.push(c);
    return wrap;
  }

  function makeMod(key, el) {
    var wrap = document.createElement('label');
    wrap.className = 'pg-check pg-mod';
    wrap.title = '标记这个知识点已看过';
    wrap.innerHTML =
      '<input type="checkbox" class="pg-input">' +
      '<span class="pg-seal" aria-hidden="true">済</span>' +
      '<span class="pg-text">已看过</span>';
    var m = { key: key, wrap: wrap, input: wrap.querySelector('.pg-input') };
    m.input.addEventListener('change', function () {
      if (m.input.checked) data.mod[key] = Date.now();
      else delete data.mod[key];
      refresh();
    });

    // 挂在模块末尾（右下角）：模块内容长时，读完正好在底部，不用再滚回顶部。
    el.appendChild(wrap);

    mods.push(m);
    return m;
  }

  function mountUnit(key) {
    pageKey = key;

    var els = moduleEls(), i;
    for (i = 0; i < els.length; i++) makeMod(key + '#' + els[i].id, els[i]);

    var navs = document.querySelectorAll('nav.pagenav');
    if (!navs.length) {
      // 兜底：没有导航条就挂一条到底部，保证功能不消失
      var dock = document.createElement('div');
      dock.className = 'pg-dock';
      document.body.appendChild(dock);
      navs = [dock];
    }
    for (i = 0; i < navs.length; i++) navs[i].appendChild(makeControl(key));

    // 迁移 v1 旧数据：只记了页面级。若本页标了「已看过」却无任何模块记录，
    // 就把该页模块补成已勾，否则下面的推导会判定「没勾完」而静默清掉进度。
    // 只在挂载时跑一次——放进 refresh() 会让「手动取消全部模块」被误判成旧数据又补回来。
    if (data.done[key] && !hasAnyMod(key)) {
      for (i = 0; i < mods.length; i++) data.mod[mods[i].key] = data.done[key];
    }

    refresh();
  }

  /* ====================== 索引页：汇总渲染 ====================== */
  function renderIndex() {
    var i, j, blocks = document.querySelectorAll('details.mod');
    var total = 0, doneTotal = 0;

    // 分组：单元卡盖章 + 「已看 n/m」
    for (i = 0; i < blocks.length; i++) {
      var as = blocks[i].querySelectorAll('ul.unit-list a[href]');
      var c = 0;
      for (j = 0; j < as.length; j++) {
        var on = !!data.done[keyOf(as[j].getAttribute('href'))];
        as[j].classList.toggle('is-done', on);
        if (on) c++;
      }
      total += as.length;
      doneTotal += c;

      var sum = blocks[i].querySelector('summary');
      var tag = sum && sum.querySelector('.mod-done');
      if (sum && !tag) {
        tag = document.createElement('span');
        tag.className = 'mod-done';
        sum.appendChild(tag);
      }
      if (tag) {
        tag.textContent = '已看 ' + c + '/' + as.length;
        tag.classList.toggle('is-full', as.length > 0 && c === as.length);
      }
    }

    // 级别：在统计药丸行追加一枚「已看 n/m」
    var lv = document.querySelectorAll('.level-block');
    for (i = 0; i < lv.length; i++) {
      var las = lv[i].querySelectorAll('ul.unit-list a[href]');
      var lc = 0;
      for (j = 0; j < las.length; j++) if (las[j].classList.contains('is-done')) lc++;
      var stats = lv[i].querySelector('.stats');
      if (!stats) continue;
      var pill = stats.querySelector('.lv-done');
      if (!pill) {
        pill = document.createElement('span');
        pill.className = 'lv-done';
        stats.appendChild(pill);
      }
      pill.textContent = '已看 ' + lc + '/' + las.length;
      pill.classList.toggle('is-full', las.length > 0 && lc === las.length);
    }

    renderOverall(doneTotal, total);
  }

  function renderOverall(done, total) {
    var bar = document.querySelector('.pg-overall');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'pg-overall';
      bar.innerHTML =
        '<div class="pg-track"><i class="pg-fill"></i></div>' +
        '<p class="pg-num"></p>' +
        '<button type="button" class="pg-manage">进度管理</button>';
      var hero = document.querySelector('header.top');
      if (hero && hero.parentNode) hero.parentNode.insertBefore(bar, hero.nextSibling);
      else document.body.insertBefore(bar, document.body.firstChild);
      bar.querySelector('.pg-manage').addEventListener('click', openDialog);
    }
    bar.querySelector('.pg-fill').style.width = (total ? done / total * 100 : 0).toFixed(1) + '%';
    bar.querySelector('.pg-num').innerHTML = '已看 <b>' + done + '</b> / ' + total + ' 单元';
  }

  /* ====================== 进度管理面板 ====================== */
  var dlg = null;

  function buildDialog() {
    var d = document.createElement('dialog');
    d.className = 'pg-dialog';
    d.innerHTML =
      '<h3>进度管理</h3>' +
      '<p class="pg-dlg-num"></p>' +
      '<p class="pg-dlg-note">数据保存在本浏览器的 localStorage：换设备、换浏览器或清除缓存都会丢失，建议定期导出备份。</p>' +
      '<div class="pg-dlg-actions">' +
        '<button type="button" data-act="export">导出 JSON</button>' +
        '<button type="button" data-act="import">导入 JSON</button>' +
        '<button type="button" data-act="clear" class="danger">清空进度</button>' +
      '</div>' +
      '<p class="pg-dlg-msg" role="status"></p>' +
      '<button type="button" class="pg-dlg-close" data-act="close">关闭</button>' +
      '<input type="file" class="pg-file" accept="application/json,.json" hidden>';

    d.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'export') doExport(d);
      else if (act === 'import') d.querySelector('.pg-file').click();
      else if (act === 'clear') doClear(d);
      else if (act === 'close') closeDialog(d);
    });

    d.querySelector('.pg-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) doImport(f, d);
      this.value = '';
    });
    return d;
  }

  function msg(d, text) {
    var m = d.querySelector('.pg-dlg-msg');
    if (m) m.textContent = text || '';
  }
  function statLine() {
    return '已看 <b>' + count() + '</b> 个单元 · 已掌握 <b>' + countMod() + '</b> 个知识点';
  }

  function openDialog() {
    if (!dlg) { dlg = buildDialog(); document.body.appendChild(dlg); }
    msg(dlg, '');
    dlg.querySelector('.pg-dlg-num').innerHTML = statLine();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (typeof d.close === 'function' && d.open) d.close();
    else d.removeAttribute('open');
  }

  function doExport(d) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'jlpt-progress-' + stamp() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    msg(d, '已导出 jlpt-progress-' + stamp() + '.json');
  }

  function doImport(file, d) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var o = JSON.parse(r.result);
        var src = (o && o.done && typeof o.done === 'object') ? o.done : o;
        var srcMod = (o && o.mod && typeof o.mod === 'object') ? o.mod : {};
        if (!src || typeof src !== 'object') { msg(d, '文件格式不对，需要本功能导出的 JSON。'); return; }

        var add = 0, upd = 0, addM = 0, updM = 0, skip = 0, k, ts;

        for (k in src) {
          if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
          if (!isUnit(k)) { skip++; continue; }
          ts = typeof src[k] === 'number' ? src[k] : Date.now();
          if (data.done[k]) upd++; else add++;
          data.done[k] = ts;
        }
        for (k in srcMod) {
          if (!Object.prototype.hasOwnProperty.call(srcMod, k)) continue;
          if (!isMod(k)) { skip++; continue; }
          ts = typeof srcMod[k] === 'number' ? srcMod[k] : Date.now();
          if (data.mod[k]) updM++; else addM++;
          data.mod[k] = ts;
        }

        save();
        if (mods.length || controls.length) refresh();
        if (document.querySelector('ul.unit-list')) renderIndex();
        d.querySelector('.pg-dlg-num').innerHTML = statLine();
        msg(d, '导入完成：单元 新增 ' + add + '／更新 ' + upd +
               '，知识点 新增 ' + addM + '／更新 ' + updM +
               (skip ? '，忽略 ' + skip + ' 条无法识别' : ''));
      } catch (e) {
        msg(d, '解析失败：' + e.message);
      }
    };
    r.readAsText(file);
  }

  function doClear(d) {
    if (!window.confirm('确定清空全部学习进度？此操作不可撤销，建议先导出备份。')) return;
    data.done = {};
    data.mod = {};
    save();
    if (mods.length || controls.length) refresh();
    if (document.querySelector('ul.unit-list')) renderIndex();
    d.querySelector('.pg-dlg-num').innerHTML = statLine();
    msg(d, '已清空。');
  }

  /* ====================== 启动 ====================== */
  function boot() {
    var unitKey = keyOf(location.pathname);
    if (isUnit(unitKey)) mountUnit(unitKey);
    if (document.querySelector('ul.unit-list')) renderIndex();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
