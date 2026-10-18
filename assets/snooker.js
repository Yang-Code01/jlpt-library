/* 斯诺克信息区 · 渲染脚本（门户用，随 index.html 一起加载）
 *
 * 数据来自 assets/snooker-data.js（window.SNOOKER，由 tools/snooker.mjs 生成）。
 * 这里只做「读数据 → 生成 DOM」，不联网、不发请求 —— index.html 要能 file:// 直开。
 *
 * 两块：
 *   1. 赛程进度：当前这一站走到第几天（没有进行中的站就退化成「赛季进度 + 下一站倒数」）
 *   2. 世界排名：Top 16 常驻 / 中国球员高亮 / ± 名次变动 / 搜索框 / 展开全部
 */
(function () {
  'use strict';

  var D = window.SNOOKER;
  var host = document.getElementById('snk');
  if (!host) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  /* 'YYYY-MM-DD' 按本地时间解析：直接 new Date(str) 会被当 UTC，东八区会差一天 */
  function parse(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function gap(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function md(s) { var p = String(s).split('-'); return p[1] + '-' + p[2]; }
  function wd(s) { return '日一二三四五六'.charAt(parse(s).getDay()); }
  function money(n) { return '£' + (n || 0).toLocaleString('en-GB'); }
  function span(e) { return gap(e.s, e.e) + 1; }

  if (!D || !D.ranking || !D.ranking.length) {
    host.innerHTML = '<p class="snk-empty">排名数据还没生成。在仓库根目录跑一次 <code>node tools/snooker.mjs</code> 即可。</p>';
    return;
  }

  var CAL = D.calendar || [];
  var NAMES = D.names || {};
  var NATS = D.nats || {};
  var today = ymd(new Date());
  var cal = CAL.filter(function (e) { return e.s <= today && today <= e.e; });
  var live = cal.length ? cal[0] : null;
  var next = null, prev = null, i;
  for (i = 0; i < CAL.length; i++) {
    if (CAL[i].s > today && !next) next = CAL[i];
    if (CAL[i].e < today) prev = CAL[i];
  }
  function nameOf(e) { return e.cn || e.en; }

  /* ---------------- 1. 赛程进度 ---------------- */
  var season = D.season || {};
  var sTot = season.start && season.end ? gap(season.start, season.end) + 1 : 0;
  var sPass = season.start ? Math.min(sTot, Math.max(0, gap(season.start, today) + 1)) : 0;
  var done = CAL.filter(function (e) { return e.e < today; }).length;
  var stamp = String(D.updated || '').replace('T', ' ').replace('Z', '');
  var UPDATE_URL = 'https://github.com/Yang-Code01/jlpt-library/actions/workflows/snooker.yml';


  /* ---- 轮次轨道：一列一轮，场次与日期都来自单站对阵页（--local-ev / 线上 event=ID） ---- */
  function roundsOf(ev) { return ev && ev.rounds && ev.rounds.length ? ev.rounds : null; }

  function railHtml(ev) {
    var rs = roundsOf(ev);
    if (!rs) return '';
    /* 今天落在哪一轮：优先用该轮的日期区间；没排期的按「前面都打完了」推断 */
    var at = -1, k;
    for (k = 0; k < rs.length; k++) {
      if (rs[k].s && rs[k].s <= today && today <= rs[k].e) { at = k; break; }
    }
    if (at < 0) {
      for (k = 0; k < rs.length; k++) { if (rs[k].played < rs[k].n) { at = k; break; } }
    }
    /* 还没开打的站（休赛期看下一站）不该有「进行中」那一轮 */
    if (ev !== live) at = -1;
    var out = '<div class="snk-rail">';
    rs.forEach(function (r, idx) {
      var st = idx < at ? 'done' : (idx === at ? 'now' : 'next');
      if (at < 0 && r.n && r.played >= r.n) st = 'done';
      var dt = r.s ? (r.s === r.e ? md(r.s) : md(r.s) + '–' + md(r.e)) : '待排';
      out += '<div class="rn ' + st + '" style="--i:' + idx + '">' +
        '<span class="rn-dot"></span>' +
        '<b class="rn-t">' + esc(r.cn) + '</b>' +
        '<span class="rn-c">' + r.n + ' 场' + (r.bo ? '<i> · ' + r.bo + ' 局制</i>' : '') + '</span>' +
        '<span class="rn-d">' + dt + '</span>' +
      '</div>';
    });
    return out + '</div>';
  }

  /* 场次进度：本轮还剩几场 → 还剩几人 */
  function footHtml(ev) {
    var rs = roundsOf(ev);
    if (!rs) return '';
    var totM = 0, doneM = 0, at = -1, k;
    rs.forEach(function (r) { totM += r.n; doneM += r.played; });
    for (k = 0; k < rs.length; k++) { if (rs[k].played < rs[k].n) { at = k; break; } }
    var left = '<b>已打 ' + doneM + ' / ' + totM + ' 场</b>';
    if (at >= 0) {
      var r = rs[at];
      left += '<span>' + esc(r.cn) + '还剩 ' + (r.n - r.played) + ' 场 · ' + (r.n - r.played) * 2 + ' 人</span>';
    } else {
      left += '<span>本站比赛已全部结束</span>';
    }
    var right = next ? '<em>下一站 ' + esc(nameOf(next)) + ' · <b>' + gap(today, next.s) + '</b>天后（' + md(next.s) + '）</em>' : '';
    return '<div class="snk-foot">' + left + right + '</div>';
  }

  var html = '';
  var pctS = Math.round(sPass / (sTot || 1) * 100);
  html += '<div class="snk-sec">' +
    '<div class="zone-head zone-first">' +
      '<div class="zone-head-main">' +
        '<h2 class="zone-title">赛程进度 <span class="zone-en">Season Progress</span></h2>' +
        '<p class="zone-sub">' + esc(season.label || '') + ' 赛季 · 共 ' + CAL.length + ' 站 · 已完赛 ' + done +
        ' 站 · 数据每日抓取（最近一次 ' + esc(stamp) + ' UTC）</p>' +
      '</div>' +
      '<div class="zone-aside"><span class="zone-count">赛季 ' + pctS + '%</span>' +
        /* 静态页不能自己触发抓取：链到 GitHub Actions，登录后按 Run workflow */
        '<a class="snk-upd" href="' + UPDATE_URL + '" target="_blank" rel="noopener" ' +
          'title="打开 GitHub Actions，点右上 Run workflow 立刻抓一次">手动更新 <span aria-hidden="true">↗</span></a>' +
      '</div>' +
    '</div>';

  /* ---- 当前站：赛事头 + 轮次轨道 + 场次进度 ---- */
  var card = '<div class="snk-now' + (live ? '' : ' rest') + '">';
  if (live) {
    var day = gap(live.s, today) + 1;
    var totD = span(live);
    card += '<div class="snk-now-top">' +
        '<span class="snk-pill">进行中</span>' +
        '<span class="snk-ev">' + esc(nameOf(live)) + '<small>' + esc(live.en) + '</small></span>' +
        '<span class="snk-day">第 ' + day + ' 天<em> / 共 ' + totD + ' 天</em></span>' +
      '</div>' +
      '<div class="snk-meta">' +
        '<span>📍 ' + esc(live.city) + (live.nat_cn ? ' · ' + esc(live.nat_cn) : '') + '</span>' +
        '<span>' + md(live.s) + ' – ' + md(live.e) + '</span>' +
        (live.field ? '<span>' + live.field + ' 人参赛</span>' : '') +
        (live.prize ? '<span>冠军 ' + money(live.prize) + '</span>' : '') +
      '</div>';
  } else {
    card += '<div class="snk-now-top">' +
        '<span class="snk-pill rest">休赛期</span>' +
        '<span class="snk-ev">' + (next ? esc(nameOf(next)) + '<small>' + esc(next.en) + '</small>' : '本赛季已结束') + '</span>' +
        (next ? '<span class="snk-day">' + gap(today, next.s) + ' 天后开赛</span>' : '') +
      '</div>' +
      '<div class="snk-meta">' +
        (next ? '<span>📍 ' + esc(next.city) + (next.nat_cn ? ' · ' + esc(next.nat_cn) : '') + '</span>' +
          '<span>' + md(next.s) + ' – ' + md(next.e) + ' · 共 ' + span(next) + ' 天</span>' +
          (next.prize ? '<span>冠军 ' + money(next.prize) + '</span>' : '') : '') +
        (prev ? '<span>上一站 ' + md(prev.e) + ' 收官 · ' + esc(nameOf(prev)) + '</span>' : '') +
      '</div>';
  }
  card += railHtml(live || next) + footHtml(live || next) + '</div>';

  /* ---- 赛季轨道：一根竖线串起「最近完赛 → 今天 → 接下来」----
     指针靠近哪一站，那一站放大（邻居按距离渐次放大），右侧详情跟着换；
     按住可在轨道上拖动，松手吸附最近一站；↑↓ 也能切。默认露出前后各 5 站 + 今天。 */
  var order = CAL.slice().sort(function (a, b) { return a.s < b.s ? -1 : 1; });
  var at = live ? order.indexOf(live) : order.filter(function (e) { return e.e < today; }).length;
  /* 窄屏一列放不下 11 站（详情会被推到看不到的地方），前后各收成 3 站 */
  var side = window.innerWidth && window.innerWidth < 700 ? 3 : 4;
  var from = Math.max(0, at - side), to = Math.min(order.length, at + side + 1);
  var view = order.slice(from, to);

  function stState(e) { return e.e < today ? 'done' : (e.s <= today && today <= e.e ? 'live' : 'fut'); }

  var track = '<div class="snk-trk-wrap">' +
    '<div class="snk-trk" id="snk-trk" tabindex="0" aria-label="赛季轨道：指针扫过或上下方向键切换，按住可拖动">' +
      '<span class="snk-trk-cur" id="snk-trk-cur" aria-hidden="true"></span>' +
      (from > 0 ? '<div class="snk-fade">更早的 ' + from + ' 站</div>' : '') +
      view.map(function (e, i) {
        return '<div class="snk-st ' + stState(e) + '" data-i="' + i + '">' +
          '<span class="st-dot"></span>' +
          '<span class="st-tx"><b>' + esc(nameOf(e)) + '</b><em>' + md(e.s) + '–' + md(e.e) + ' · ' + esc(e.city) + '</em></span>' +
        '</div>';
      }).join('') +
      (to < order.length ? '<div class="snk-fade b">更远的 ' + (order.length - to) + ' 站</div>' : '') +
    '</div>' +
    '<aside class="snk-det" id="snk-det"></aside>' +
  '</div>';

  html += card + track + '</div>';

  /* ---------------- 2. 世界排名 ---------------- */
  function chgCell(c) {
    if (!c || c === '0' || c === '=' || c === '-') return '<span class="snk-chg">—</span>';
    var up = c.charAt(0) === '+';
    return '<span class="snk-chg ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + Math.abs(parseInt(c, 10)) + '</span>';
  }
  function rowHtml(r, idx) {
    var en = r[2], cn = NAMES[en] || '';
    var nat = NATS[r[3]] || r[3] || '';
    var isCn = r[3] === 'China' || r[3] === 'Hong Kong';
    return '<div class="snk-row' + (isCn ? ' cn' : '') + '" data-k="' +
        /* 搜索键同时含英文原名与英文国籍，输入 english/china 也能命中 */
        esc((en + ' ' + cn + ' ' + nat + ' ' + (r[3] || '')).toLowerCase()) + '"' + (idx > 15 ? ' hidden' : '') + '>' +
      '<span class="snk-pos">' + r[0] + '</span>' +
      chgCell(r[1]) +
      '<span class="snk-nm"><b>' + esc(cn || en) + '</b>' + (cn ? '<span>' + esc(en) + '</span>' : '') + '</span>' +
      '<span class="snk-nat">' + esc(nat) + '</span>' +
      '<span class="snk-pts">' + money(r[4]) + '</span>' +
    '</div>';
  }

  html += '<div class="snk-sec">' +
    '<div class="zone-head">' +
      '<div class="zone-head-main">' +
        '<h2 class="zone-title">世界排名 <span class="zone-en">World Ranking</span></h2>' +
        '<p class="zone-sub">两年滚动积分 · 中国球员高亮 · ▲▼ 为本次抓取的名次变动。默认只看前 16。</p>' +
      '</div>' +
      '<div class="zone-aside"><input type="search" id="snk-q" class="snk-q" placeholder="搜球员 / 国家" aria-label="搜索球员或国家" autocomplete="off"></div>' +
    '</div>' +
    '<div class="snk-rank" id="snk-rank">' +
      '<div class="snk-row snk-row-h"><span>名次</span><span>变动</span><span>球员</span><span>国家</span><span>积分</span></div>' +
      D.ranking.map(rowHtml).join('') +
    '</div>' +
    '<button type="button" class="snk-more" id="snk-more">展开全部 ' + D.ranking.length + ' 人</button>' +
  '</div>';

  host.innerHTML = html;

  /* ---------------- 赛季轨道：悬停放大 + 拖动吸附 + 详情联动 ---------------- */
  (function () {
    var trk = host.querySelector('#snk-trk');
    var det = host.querySelector('#snk-det');
    var cur = host.querySelector('#snk-trk-cur');
    if (!trk || !det) return;
    var nodes = [].slice.call(trk.querySelectorAll('.snk-st'));
    var R = 104, K = 0.62;
    var sel = Math.max(0, view.map(stState).indexOf('live'));
    /* 休赛期没有 live：默认停在「最近一个已结束的站」，而不是窗口第一站 */
    if (stState(view[sel]) !== 'live') {
      view.forEach(function (e, i) { if (stState(e) === 'done') sel = i; });
    }

    function detHtml(i) {
      var e = view[i], st = stState(e), w = e.winner, pv = order[order.indexOf(e) - 1], rs, k, out;
      out = '<div class="snk-det-main"><div class="snk-det-top">' +
        (st === 'done' ? '<span class="snk-bge">已结束</span>' :
         st === 'live' ? '<span class="snk-bge live">进行中 · 第 ' + (gap(e.s, today) + 1) + '/' + span(e) + ' 天</span>' :
         '<span class="snk-bge">还有 ' + gap(today, e.s) + ' 天</span>') +
        '<span class="snk-bge">' + (e.level === 'invitational' ? '邀请赛' : '排名赛') + '</span></div>' +
        '<h3 class="snk-det-t">' + esc(nameOf(e)) + '</h3><span class="snk-det-en">' + esc(e.en) + '</span>' +
        '<dl class="snk-kv">' +
          '<dt>地点</dt><dd>' + esc(e.city) + (e.nat_cn ? ' · ' + esc(e.nat_cn) : '') + '</dd>' +
          '<dt>赛期</dt><dd>' + e.s + ' → ' + e.e + '（' + span(e) + ' 天）</dd>' +
          '<dt>奖金</dt><dd>' + (e.prize ? money(e.prize) : '—') + (e.field ? ' · ' + e.field + ' 人参赛' : '') + '</dd>' +
        '</dl></div>';

      out += '<div class="snk-det-bot">';
      if (st === 'done') {
        /* 该站已结束但快照早于决赛：不拿「上一站冠军」充数 */
        out += '<div class="snk-win"><span class="k">冠军</span>' + (w
          ? '<span class="v">' + esc(w.cn || w.en) + '</span><span class="s">' + esc(w.score || '') + '</span>' +
            (w.runner_cn ? '<span class="r">胜 ' + esc(w.runner_cn) + '</span>' : '')
          : '<span class="v">未收录</span><span class="r">这份快照生成于本站决赛之前</span>') + '</div>';
      } else if (st === 'live') {
        rs = roundsOf(e);
        k = -1;
        if (rs) {
          for (var j = 0; j < rs.length; j++) { if (rs[j].s && rs[j].s <= today && today <= rs[j].e) { k = j; break; } }
          if (k < 0) { for (var m = 0; m < rs.length; m++) { if (rs[m].played < rs[m].n) { k = m; break; } } }
        }
        out += '<div class="snk-win"><span class="k">今天</span><span class="v">' +
          (rs && k >= 0 ? esc(rs[k].cn) + ' · ' + rs[k].n + ' 场 · ' + rs[k].bo + ' 局制' : '资格赛轮次') + '</span></div>';
        if (rs) {
          var tot = 0;
          rs.forEach(function (r) { tot += r.n; });
          out += '<div class="snk-rd"><div class="t">' + rs.length + ' 轮 · 从首轮到决赛共 ' + tot + ' 场</div><ol>' +
            rs.map(function (r, idx) {
              var cls = k < 0 ? '' : (idx < k ? 'dn' : (idx === k ? 'on' : ''));
              return '<li class="' + cls + '">' + esc(r.cn) + '<br>' + (r.played || 0) + '/' + r.n + '</li>';
            }).join('') + '</ol></div>';
        }
      } else {
        out += '<div class="snk-win"><span class="k">' + (pv && pv.winner ? '上一站冠军' : '签表') + '</span>' +
          '<span class="v">' + (pv && pv.winner ? esc(pv.winner.cn || pv.winner.en) + '（' + esc(nameOf(pv)) + '）' : '未出') + '</span>' +
          '<span class="r">' + (pv && pv.winner ? '站末 ' + pv.e : '待定') + '</span></div>';
      }
      return out + '<div class="snk-hint">指针扫过即预览 · 按住可拖动 · <kbd>↑</kbd><kbd>↓</kbd> 切换</div></div>';
    }

    function paint(i) {
      sel = i;
      det.innerHTML = detHtml(i);
      nodes.forEach(function (n, k) { n.classList.toggle('sel', k === i); });
    }

    /* 距离衰减：scale = 1 + K·(1-d/R)²，越远越小 */
    function sizes(y) {
      var best = 0, bestD = 1e9;
      nodes.forEach(function (n, i) {
        var cy = n.offsetTop + n.offsetHeight / 2, d = Math.abs(cy - y);
        var f = Math.max(0, 1 - d / R);
        n.querySelector('.st-dot').style.transform = 'scale(' + (1 + K * f * f).toFixed(3) + ')';
        n.classList.toggle('near', f > 0.55);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }
    function plain() {
      nodes.forEach(function (n) {
        n.querySelector('.st-dot').style.transform = '';
        n.classList.remove('near');
      });
    }

    /* 「已过去」那段轨道涂实：末个已结束站的圆心 */
    function paintPast() {
      var last = -1;
      view.forEach(function (e, i) { if (stState(e) === 'done') last = i; });
      if (last < 0) { trk.style.setProperty('--past', '0px'); return; }
      var n = nodes[last];
      trk.style.setProperty('--past', (n.offsetTop + n.offsetHeight / 2 - 14) + 'px');
    }

    var dragging = false;
    function relY(ev) { return ev.clientY - trk.getBoundingClientRect().top; }
    function move(ev) {
      var y = relY(ev);
      cur.style.top = y + 'px';
      var i = sizes(y);
      if (i !== sel) paint(i);
    }
    trk.addEventListener('pointermove', move);
    trk.addEventListener('pointerdown', function (ev) {
      dragging = true; trk.classList.add('drag');
      if (trk.setPointerCapture) { try { trk.setPointerCapture(ev.pointerId); } catch (err) {} }
      move(ev);
    });
    trk.addEventListener('pointerup', function (ev) {
      dragging = false; trk.classList.remove('drag');
      if (trk.releasePointerCapture) { try { trk.releasePointerCapture(ev.pointerId); } catch (err) {} }
    });
    trk.addEventListener('pointerleave', function () {
      if (dragging) return;
      plain();
      var n = nodes[sel];
      sizes(n.offsetTop + n.offsetHeight / 2);
    });
    trk.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      var i = Math.max(0, Math.min(nodes.length - 1, sel + (ev.key === 'ArrowDown' ? 1 : -1)));
      plain();
      paint(i);
      var n = nodes[i];
      cur.style.top = (n.offsetTop + n.offsetHeight / 2) + 'px';
      cur.style.opacity = '.22';
    });

    paintPast();
    paint(sel);
    /* 首屏让「今天」那格略放大，暗示可交互 */
    var ln = nodes[sel] && nodes[sel].querySelector('.st-dot');
    if (ln) ln.style.transform = 'scale(1.45)';
    window.addEventListener('resize', paintPast);
  })();

  /* ---------------- 交互 ---------------- */
  /* 不用 :not() —— tools/tests/dom.js 的迷你 DOM 只认后代选择器，遇到伪类直接抛错 */
  var rows = [].slice.call(host.querySelectorAll('.snk-row')).filter(function (el) {
    return String(el.className).indexOf('snk-row-h') < 0;
  });
  var more = document.getElementById('snk-more');
  var q = document.getElementById('snk-q');
  var expanded = false;

  function apply(keepExpand) {
    var kw = (q && q.value || '').trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (el, idx) {
      var hit = !kw || el.getAttribute('data-k').indexOf(kw) >= 0;
      var visible = hit && (kw || expanded || idx < 16);
      el.hidden = !visible;
      if (visible) shown++;
    });
    if (more) {
      /* 搜索时「展开全部」没有意义，直接收起来 */
      more.hidden = !!kw;
      if (expanded && !keepExpand) more.textContent = '收起，只看前 16';
    }
    var blank = host.querySelector('.snk-blank');
    if (!shown) {
      if (!blank) {
        blank = document.createElement('p');
        blank.className = 'snk-blank';
        blank.textContent = '没有匹配的球员。';
        document.getElementById('snk-rank').appendChild(blank);
      }
      blank.hidden = false;
    } else if (blank) {
      blank.hidden = true;
    }
  }

  if (more) {
    more.addEventListener('click', function () {
      expanded = !expanded;
      more.textContent = expanded ? '收起，只看前 16' : '展开全部 ' + D.ranking.length + ' 人';
      apply(true);
    });
  }
  if (q) {
    q.addEventListener('input', function () { apply(); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { q.value = ''; apply(); }
    });
  }
  apply(true);
})();
