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
        ' 站 · 定时抓取（最近一次 ' + esc(stamp) + ' UTC）</p>' +
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

  /* ---- 赛季轨道：一根竖线串起全部 22 站，指针靠近放大、右侧详情联动 ----
     以前只渲染「今天前后各 4 站」，窗口外写成不可点的「更早的 N 站」，那 14 站等于没有信息；
     现在全展开（容器自己滚），每一站都能点开看赛程与天梯图。 */
  var order = CAL.slice().sort(function (a, b) { return a.s < b.s ? -1 : 1; });

  function stState(e) { return e.e < today ? 'done' : (e.s <= today && today <= e.e ? 'live' : 'fut'); }

  var track = '<div class="snk-trk-wrap">' +
    '<div class="snk-trk" id="snk-trk" tabindex="0" aria-label="赛季轨道：点击某站查看该站详情，上下方向键逐站浏览">' +

      order.map(function (e, i) {
        return '<div class="snk-st ' + stState(e) + '" data-i="' + i + '">' +
          '<span class="st-dot"></span>' +
          '<span class="st-tx"><b>' + esc(nameOf(e)) + '</b><em>' + md(e.s) + '–' + md(e.e) +
            ' · ' + esc(e.city_cn || e.city) + '</em></span>' +
        '</div>';
      }).join('') +
    '</div>' +
    '<aside class="snk-det" id="snk-det"></aside>' +
  '</div>' +
  /* 通栏块：天梯图与赛程表放不进 240px 轨道 + 880px 详情列里，
     8 张卡一行要 ~1100px，32 张要横滚 —— 所以跑到栅格下面独占一行。 */
  '<div class="snk-wide" id="snk-wide"></div>';

  html += card + track + '</div>';

  /* ---------------- 2. 排名：两个口径（两年滚动 / 本赛季） ---------------- */
  function chgCell(c) {
    if (!c || c === '0' || c === '=' || c === '-') return '<span class="snk-chg">—</span>';
    var up = c.charAt(0) === '+';
    return '<span class="snk-chg ' + (up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + Math.abs(parseInt(c, 10)) + '</span>';
  }
  function tableHtml(id, list, hidden) {
    return '<div class="snk-rank" id="' + id + '"' + (hidden ? ' hidden' : '') + '>' +
      '<div class="snk-row snk-row-h"><span>名次</span><span>变动</span><span>球员</span><span>国家</span><span>积分</span></div>' +
      (list.length
        ? list.map(rowHtml).join('')
        : '<p class="snk-blank" data-static="1">暂无本赛季榜数据：生成器还没成功抓到 One-Year List。</p>') +
    '</div>';
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

  /* 单赛季（One-Year List）榜：上游抓不到时是空数组，页面照样给出开关与占位 */
  var ONE = D.ranking1y || [];
  var rankSites = CAL.filter(function (e) { return e.level === 'ranking'; });
  var rankDone = rankSites.filter(function (e) { return !!e.winner; }).length;
  var STAMP = String(D.updated || '').slice(0, 10);
  var STAMP_1Y = String(D.updated1y || D.updated || '').slice(0, 10);
  /* 两个时间戳来自同一台机器的两次抓取，单赛季榜那次没抓到就会停在上回的时间 */
  var STALE_1Y = !!(D.updated1y && D.updated && D.updated1y < D.updated);
  var SEASON_LABEL = (D.season && D.season.label) || '';
  var SUB_TWO = '两年滚动积分 · 数据 ' + STAMP + ' · 中国球员高亮 · 默认只看前 16。';
  var SUB_ONE =
    (STALE_1Y ? '⚠ 本次抓取失败，沿用 ' + STAMP_1Y + ' 的榜 · ' : '') +
    (SEASON_LABEL ? SEASON_LABEL + ' 赛季 · ' : '') +
    '已计入 ' + rankDone + ' / ' + rankSites.length + ' 站 · 数据 ' + STAMP_1Y + ' · 默认只看前 16。';

  html += '<div class="snk-sec" id="snk-rank-sec">' +
    '<div class="zone-head">' +
      '<div class="zone-head-main">' +
        '<h2 class="zone-title">' +
          '<span class="snk-tabs" role="tablist" aria-label="排名口径">' +
            '<button type="button" class="snk-tab on" id="snk-tab-two" role="tab" data-tab="two" aria-selected="true" aria-controls="snk-rank">世界排名</button>' +
            '<button type="button" class="snk-tab" id="snk-tab-one" role="tab" data-tab="one" aria-selected="false" aria-controls="snk-rank-1y">本赛季</button>' +
          '</span> ' +
          '<span class="zone-en" id="snk-rank-en">World Ranking</span>' +
        '</h2>' +
        '<p class="zone-sub" id="snk-sub">' + esc(SUB_TWO) + '</p>' +
      '</div>' +
      '<div class="zone-aside"><input type="search" id="snk-q" class="snk-q" placeholder="搜球员 / 国家" aria-label="搜索球员或国家" autocomplete="off"></div>' +
    '</div>' +
    tableHtml('snk-rank', D.ranking, false) +
    '<button type="button" class="snk-more" id="snk-more">展开全部 ' + D.ranking.length + ' 人</button>' +
    tableHtml('snk-rank-1y', ONE, true) +
    (ONE.length ? '<button type="button" class="snk-more" id="snk-more-1y" hidden>展开全部 ' + ONE.length + ' 人</button>' : '') +
  '</div>';

  host.innerHTML = html;

  /* ---------------- 赛季轨道：悬停放大 + 拖动吸附 + 详情联动 ---------------- */
  (function () {
    var trk = host.querySelector('#snk-trk');
    var det = host.querySelector('#snk-det');
    var wide = host.querySelector('#snk-wide');
    if (!trk || !det) return;
    var nodes = [].slice.call(trk.querySelectorAll('.snk-st'));
    var R = 104, K = 0.62;
    /* 默认停在「进行中」那站；休赛期停在最近一个已结束的站 */
    var sel = 0;
    order.forEach(function (e, i) { if (stState(e) === 'done') sel = i; });
    if (live) sel = Math.max(0, order.indexOf(live));

    /* ---- 天梯图：调用 assets/snooker-tree.js（纯函数，返回 HTML 片段） ---- */
    var TREE = window.SnookerTree || null;

    /* 起点轮：优先 64 强（用户定的默认），其次 32 强 / 16 强，再退到最深的「8 场以上」轮。
       轮次 id 逐站变，只能从 cn 反推，不能写死。 */
    function treeFrom(e) {
      var rs = e.rounds || [], want = ['64 强', '32 强', '16 强'], w, i;
      for (w = 0; w < want.length; w++) {
        for (i = 0; i < rs.length; i++) if (rs[i].cn === want[w] && rs[i].n) return rs[i].id;
      }
      var deep = null;
      for (i = 0; i < rs.length; i++) if (rs[i].n >= 8 && (!deep || rs[i].n > deep.n)) deep = rs[i];
      if (deep) return deep.id;
      return rs.length ? rs[0].id : null;
    }

    function nilOrMoney(n) { return n === null || n === undefined ? '<span class="nil">—</span>' : money(n); }

    /* 奖金三格：冠军 / 亚军 读 roundinfo，总奖金读人工表（缺就 —，不编） */
    function purseHtml(e) {
      var p = e.purse || {};
      var win = (p.win === null || p.win === undefined) ? (e.prize || null) : p.win;
      /* 总奖金来自手工表；p.fundFrom 有值 = 本站本赛季还没开打，数值沿用上届 → 加 ≈ 并说明 */
      var approx = p.fundFrom
        ? '<u class="snk-approx" title="数值取自 ' + esc(p.fundFrom) + ' 赛季，本站本赛季的奖金尚未公布">≈</u>'
        : '';
      var fundTitle = p.fundFrom ? ' title="上届（' + esc(p.fundFrom) + '）数值"' : '';
      return '<dl class="snk-purse">' +
        '<div><dt>冠军</dt><dd>' + nilOrMoney(win) + '</dd></div>' +
        '<div><dt>亚军</dt><dd>' + nilOrMoney(p.run) + '</dd></div>' +
        '<div><dt>总奖金</dt><dd' + fundTitle + '>' + approx + nilOrMoney(p.fund) + '</dd></div>' +
      '</dl>' +
      (p.fundFrom ? '<p class="snk-purse-note">≈ 上届数值（本站本赛季奖金尚未公布）</p>' : '');
    }

    function treeDir() { return TREE ? TREE.prefDir() : 'v'; }
    function treeBody(e, dir) {
      if (!TREE) return '<p class="tn-note">天梯图脚本没加载。</p>';
      /* 树在详情列里，宽度不等于页宽：把可用宽度交进去，让 8 行那站刚好一屏放得下 */
      var avail = wide ? wide.clientWidth : 0;
      return TREE.render(e, { fromId: treeFrom(e), dir: dir, avail: avail });
    }
    function treeBlock(e) {
      if (!e.matches || !e.matches.length) return '';
      var dir = treeDir();
      return '<div class="snk-treepane">' +
        '<div class="snk-tree-bar">' +
          '<span class="cap">天梯图</span>' +
          '<span class="snk-seg" id="snk-dir">' +
            '<button type="button" data-dir="v" aria-pressed="' + (dir === 'v') + '">↓ 纵向 轮次自上而下</button>' +
            '<button type="button" data-dir="h" aria-pressed="' + (dir === 'h') + '">→ 横向 轮次自左向右</button>' +
          '</span>' +
        '</div>' +
        '<div id="snk-tree-body">' + treeBody(e, dir) + '</div>' +
      '</div>';
    }

    /* ---- 赛程表：一行一节，按北京时间的日子分组；当地时刻交给 Intl ---- */
    function utcDate(s) {
      var d = new Date(String(s).replace(' ', 'T'));
      return isNaN(d.getTime()) ? null : d;
    }
    function bjShift(d) { return new Date(d.getTime() + 8 * 3600 * 1000); }
    function localHH(s, tz) {
      var d = utcDate(s);
      if (!d) return '';
      try {
        return new Intl.DateTimeFormat('zh-CN', { timeZone: tz || 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
      } catch (err) { return ''; }
    }
    function schHtml(e) {
      var ms = e.matches || [], rows = [], i, j;
      for (i = 0; i < ms.length; i++) {
        var ses = ms[i].ses || [];
        for (j = 0; j < ses.length; j++) rows.push({ t: ses[j], m: ms[i], part: ses.length > 1 ? j + 1 : 0 });
      }
      if (!rows.length) return '';
      rows.sort(function (a, b) { return a.t < b.t ? -1 : 1; });
      var cn = {};
      (e.rounds || []).forEach(function (r) { cn[r.id] = r.cn; });
      var days = [], cur = '';
      rows.forEach(function (r) {
        var d = utcDate(r.t); if (!d) return;
        var b = bjShift(d);
        var day = b.getUTCFullYear() + '-' + pad(b.getUTCMonth() + 1) + '-' + pad(b.getUTCDate());
        if (day !== cur) { cur = day; days.push({ day: day, items: [] }); }
        days[days.length - 1].items.push(r);
      });
      if (!days.length) return '';
      var nm = function (p) { return (p && p.n) ? (NAMES[p.n] || p.n) : '待定'; };
      var out = '<div class="snk-sch"><div class="t">赛程 · 北京时间（小字为比赛地时间）</div>';
      days.forEach(function (g) {
        out += '<div class="day"><div class="dh">' + md(g.day) + ' 周' + wd(g.day) + '</div><div>' +
          g.items.map(function (r) {
            var b = bjShift(utcDate(r.t));
            var hh = pad(b.getUTCHours()) + ':' + pad(b.getUTCMinutes());
            var lo = localHH(r.t, e.tz);
            var m = r.m, done = m.s1 !== null && m.s2 !== null;
            return '<div class="sl">' +
              '<span class="t2">' + hh + '</span>' +
              '<span class="rnd">' + esc(cn[m.r] || '') + (r.part ? ' 第' + r.part + '节' : '') + '</span>' +
              '<span class="nm">' + esc(nm(m.p1)) + '</span><span class="vs">v</span>' +
              '<span class="nm">' + esc(nm(m.p2)) + '</span>' +
              (done ? '<b>' + m.s1 + '–' + m.s2 + '</b>' : '') +
              (lo ? '<span class="t2">当地 ' + esc(lo) + '</span>' : '') +
            '</div>';
          }).join('') + '</div></div>';
      });
      return out + '</div>';
    }

    function detHtml(i) {
      var e = order[i], st = stState(e), w = e.winner, pv = order[order.indexOf(e) - 1], rs, k, out;
      out = '<div class="snk-det-main"><div class="snk-det-top">' +
        (st === 'done' ? '<span class="snk-bge">已结束</span>' :
         st === 'live' ? '<span class="snk-bge live">进行中 · 第 ' + (gap(e.s, today) + 1) + '/' + span(e) + ' 天</span>' :
         '<span class="snk-bge">还有 ' + gap(today, e.s) + ' 天</span>') +
        '<span class="snk-bge">' + (e.level === 'invitational' ? '邀请赛' : '排名赛') + '</span></div>' +
        '<h3 class="snk-det-t">' + esc(nameOf(e)) + '</h3><span class="snk-det-en">' + esc(e.en) + '</span>' +
        '<dl class="snk-kv">' +
          '<dt>地点</dt><dd>' + esc(e.city_cn || e.city) +
            (e.city_cn && e.city ? ' <span class="snk-cityen">' + esc(e.city) + '</span>' : '') +
            (e.nat_cn ? ' · ' + esc(e.nat_cn) : '') + '</dd>' +
          '<dt>赛期</dt><dd>' + e.s + ' → ' + e.e + '（' + span(e) + ' 天）' +
            (e.field ? ' · ' + e.field + ' 人参赛' : '') + '</dd>' +
        '</dl>' + purseHtml(e) + '</div>';

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
        /* 还没有对阵页快照的站：别说「未出 / 待定」两个词叠在一起，直接把「什么时候会有」讲清 */
        out += '<div class="snk-win"><span class="k">' + (pv && pv.winner ? '上一站冠军' : '签表') + '</span>' +
          '<span class="v">' + (pv && pv.winner ? esc(pv.winner.cn || pv.winner.en) + '（' + esc(nameOf(pv)) + '）' : '未公布') + '</span>' +
          '<span class="r">' + (pv && pv.winner ? '站末 ' + pv.e : '开赛 ' + (e.s || '')) + '</span></div>';
      }
      return out + '</div>';
    }

    /* 通栏：天梯图 + 赛程（一行一节，按北京时间的日子分组） */
    function wideHtml(i) {
      var e = order[i];
      /* 还没开赛、或者这一站的结构不适合对阵树（冠军联赛是小组循环）：别留一块空白 */
      if (!e.matches || !e.matches.length) {
        return '<div class="snk-wide-in"><p class="snk-wide-empty">' +
          (stState(e) === 'fut'
            ? '本站还没开赛 —— 签表与天梯图在开赛前一周开始抓取（还有 ' + Math.max(0, gap(today, e.s)) + ' 天）。'
            : '本站的对阵页还没抓到（下一轮抓取会补上）。') +
          '</p></div>';
      }
      return '<div class="snk-wide-in">' + treeBlock(e) + schHtml(e) +
        '<div class="snk-hint">指针悬停在轨道上看摘要 · 点击切换 · <kbd>↑</kbd><kbd>↓</kbd> 逐站翻</div></div>';
    }

    function paint(i) {
      sel = i;
      det.innerHTML = detHtml(i);
      wide.innerHTML = wideHtml(i);
      nodes.forEach(function (n, k) {
        n.classList.toggle('sel', k === i);
        var d = n.querySelector('.st-dot');
        if (d) d.style.transform = k === i ? 'scale(1.45)' : '';
      });
      /* 方向开关：只重渲树体，不动整个详情区（否则拖拽/滚动状态会被抹掉） */
      var seg = wide.querySelector('#snk-dir');
      if (seg && TREE) {
        var btns = [].slice.call(seg.querySelectorAll('button'));
        btns.forEach(function (b) {
          b.addEventListener('click', function () {
            var d = TREE.setDir(b.getAttribute('data-dir'));
            btns.forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-dir') === d)); });
            var body = wide.querySelector('#snk-tree-body');
            if (body) body.innerHTML = treeBody(order[sel], d);
          });
        });
      }
    }

    /* 轨道现在装 22 站，选中的那站要自己滚进可视区 */
    function reveal(i) {
      var n = nodes[i];
      if (!n || !trk.clientHeight) return;
      var top = n.offsetTop, h = n.offsetHeight, ch = trk.clientHeight;
      if (top < trk.scrollTop || top + h > trk.scrollTop + ch) {
        trk.scrollTop = Math.max(0, Math.round(top - ch / 2 + h / 2));
      }
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
        n.classList.remove('hov');
      });
    }

    /* 「已过去」那段轨道涂实：末个已结束站的圆心 */
    function paintPast() {
      var last = -1;
      order.forEach(function (e, i) { if (stState(e) === 'done') last = i; });
      if (last < 0) { trk.style.setProperty('--past', '0px'); return; }
      var n = nodes[last];
      trk.style.setProperty('--past', (n.offsetTop + n.offsetHeight / 2 - 14) + 'px');
    }

    /* ---------------- 指针：只高亮 + 摘要气泡，绝不切内容 ----------------
       以前是 pointermove 直接 paint()，从页面顶部走到天梯图必然扫过轨道 → 内容乱跳；
       滚轮在轨道上滚也会切站。现在只有「点击 / Enter / ↑↓」才切，
       指针只负责：圆点磁吸放大、行底色、右侧浮出一张摘要卡。 */
    var peek = null;
    function peekEl() {
      if (peek) return peek;
      if (!document.body) return null;
      peek = document.createElement('div');
      peek.className = 'snk-peek';
      peek.setAttribute('aria-hidden', 'true');
      document.body.appendChild(peek);
      return peek;
    }
    function showPeek(i, row) {
      var el = peekEl();
      if (!el) return;
      var e = order[i];
      var p = e.purse || {};
      var win = (p.win === null || p.win === undefined) ? (e.prize || null) : p.win;
      var st = stState(e);
      el.innerHTML = '<b>' + esc(e.cn || e.en) + '</b>' +
        '<span class="k">' + esc(e.s) + (e.s === e.e ? '' : ' → ' + esc(e.e)) +
          (e.city_cn || e.city ? ' · ' + esc(e.city_cn || e.city) : '') + '</span>' +
        '<div class="money"><i>冠军 ' + nilOrMoney(win) + '</i><i>总 ' + (p.fundFrom ? '≈' : '') + nilOrMoney(p.fund) + '</i></div>' +
        '<div class="k">' + (st === 'done' ? '已结束' : st === 'live' ? '进行中' : '还有 ' + Math.max(0, gap(today, e.s)) + ' 天') +
          ' · 点击查看天梯图</div>';
      el.classList.add('on');
      var r = row.getBoundingClientRect();
      var w = el.offsetWidth || 236, h = el.offsetHeight || 88;
      var x, y;
      var below = false;
      if (window.innerWidth < 900) {   /* 窄屏轨道占满一行：气泡放到行的下面，箭头朝上 */
        x = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        y = Math.min(window.innerHeight - h - 8, r.bottom + 8);
        below = true;
      } else {
        x = r.right + 12;
        if (x + w > window.innerWidth - 8) { x = Math.max(8, r.left - w - 12); below = false; }
        y = Math.min(window.innerHeight - h - 8, Math.max(8, r.top - 4));
      }
      el.classList.toggle('below', below);   /* 下方气泡：箭头朝上 */
      el.style.left = Math.round(x) + 'px';
      el.style.top = Math.round(y) + 'px';
      /* 箭头尖端对准这一行的垂直中心 */
      el.style.setProperty('--ay', Math.round(r.top + r.height / 2 - y - 5) + 'px');
    }
    function hidePeek() { if (peek) peek.classList.remove('on'); }

    function move(ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('.snk-st') : null;
      if (!row) return;
      var i = nodes.indexOf(row);
      if (i < 0) return;
      nodes.forEach(function (n) { n.classList.toggle('hov', n === row); });
      sizes(row.offsetTop + row.offsetHeight / 2);   /* 圆点磁吸：纯视觉，不影响选中 */
      showPeek(i, row);
    }
    trk.addEventListener('pointermove', move);
    trk.addEventListener('pointerleave', function () {
      plain();
      hidePeek();
      var n = nodes[sel];
      if (n) sizes(n.offsetTop + n.offsetHeight / 2);
      var d = n && n.querySelector('.st-dot');
      if (d) d.style.transform = 'scale(1.45)';
    });
    /* 滚轮只是滚列表：气泡跟着收起来，免得停在半空 */
    trk.addEventListener('wheel', hidePeek, { passive: true });
    trk.addEventListener('click', function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('.snk-st') : null;
      if (!row) return;
      var i = nodes.indexOf(row);
      if (i < 0 || i === sel) return;
      plain();
      paint(i);
      reveal(i);
      hidePeek();   /* 轨道会滚一下，气泡留在原地会跟行脱开；指针再动一下就回来 */
    });
    trk.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter') return;
      ev.preventDefault();
      var step = ev.key === 'ArrowDown' ? 1 : (ev.key === 'ArrowUp' ? -1 : 0);
      var i = step ? Math.max(0, Math.min(nodes.length - 1, sel + step)) : sel;
      if (i !== sel) { plain(); paint(i); }
      reveal(i);
    });

    paintPast();
    paint(sel);
    reveal(sel);
    /* 首屏让「今天」那格略放大，暗示可交互 */
    var ln = nodes[sel] && nodes[sel].querySelector('.st-dot');
    if (ln) ln.style.transform = 'scale(1.45)';
    window.addEventListener('resize', paintPast);
  })();

  /* ---------------- 交互 ---------------- */
  /* 不用 :not() —— tools/tests/dom.js 的迷你 DOM 只认后代选择器，遇到伪类直接抛错 */
  var q = document.getElementById('snk-q');
  var subEl = document.getElementById('snk-sub');
  var enEl = document.getElementById('snk-rank-en');
  var TABS = { two: document.getElementById('snk-tab-two'), one: document.getElementById('snk-tab-one') };
  var SUB = { two: SUB_TWO, one: SUB_ONE };
  var EN = { two: 'World Ranking', one: 'One-Year List' };

  /* 两个口径共用一个搜索词；每张表各有自己的「展开」状态 */
  function panelOf(id, moreId, total) {
    var panel = document.getElementById(id);
    return {
      panel: panel,
      more: moreId ? document.getElementById(moreId) : null,
      total: total,
      expanded: false,
      rows: [].slice.call(panel ? panel.querySelectorAll('.snk-row') : []).filter(function (el) {
        return String(el.className).indexOf('snk-row-h') < 0;
      })
    };
  }
  var panels = {
    two: panelOf('snk-rank', 'snk-more', D.ranking.length),
    one: panelOf('snk-rank-1y', ONE.length ? 'snk-more-1y' : null, ONE.length)
  };
  var cur = 'two';

  function apply() {
    var kw = (q && q.value || '').trim().toLowerCase();
    Object.keys(panels).forEach(function (key) {
      var p = panels[key];
      var shown = 0;
      p.rows.forEach(function (el, idx) {
        var hit = !kw || el.getAttribute('data-k').indexOf(kw) >= 0;
        var visible = hit && (kw || p.expanded || idx < 16);
        el.hidden = !visible;
        if (visible) shown++;
      });
      if (p.more) {
        /* 搜索时「展开全部」没有意义；切走的那个面板连它的按钮一起藏 */
        p.more.hidden = !!kw || p.panel.hidden;
        p.more.textContent = p.expanded ? '收起，只看前 16' : '展开全部 ' + p.total + ' 人';
      }
      /* 空榜占位是渲染期写死的（data-static），只处理搜索落空的那条 */
      var blank = null;
      [].slice.call(p.panel.querySelectorAll('.snk-blank')).forEach(function (el) {
        if (!el.getAttribute('data-static')) blank = el;
      });
      if (!shown && kw && p.rows.length) {
        if (!blank) {
          blank = document.createElement('p');
          blank.className = 'snk-blank';
          blank.textContent = '没有匹配的球员。';
          p.panel.appendChild(blank);
        }
        blank.hidden = false;
      } else if (blank) {
        blank.hidden = true;
      }
    });
  }

  function setTab(key) {
    if (!panels[key]) return;
    cur = key;
    Object.keys(panels).forEach(function (k) {
      var on = k === key;
      if (TABS[k]) {
        TABS[k].className = 'snk-tab' + (on ? ' on' : '');
        TABS[k].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      panels[k].panel.hidden = !on;
    });
    if (subEl) subEl.textContent = SUB[key];
    if (enEl) enEl.textContent = EN[key];
    apply();
  }

  Object.keys(panels).forEach(function (key) {
    var p = panels[key];
    if (p.more) {
      p.more.addEventListener('click', function () {
        p.expanded = !p.expanded;
        apply();
      });
    }
    if (TABS[key]) {
      TABS[key].addEventListener('click', function () { setTab(key); });
    }
  });
  if (q) {
    q.addEventListener('input', function () { apply(); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { q.value = ''; apply(); }
    });
  }
  setTab(cur);
})();
