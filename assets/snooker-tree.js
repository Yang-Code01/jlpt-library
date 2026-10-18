/* 斯诺克天梯图（对阵树）· 渲染组件（门户用，随 index.html 一起加载）
 *
 * 数据来自 assets/snooker-data.js（window.SNOOKER，由 tools/snooker.mjs 生成）。
 * 这里只做「读数据 → 拼 HTML」，不联网、不发请求 —— index.html 要能 file:// 直开。
 *
 * 对外四个：
 *   buildTree(ev)               建父子关系（只用「子场胜者必在父场」这一条事实）
 *   geometry(tree, fromId)     摊成「列 × slot 行」的绝对行坐标系
 *   render(ev, opts)           出完整自包含 HTML 片段（内联 style + 内联 svg 连线）
 *   html(ev, opts)             render 的别名
 *
 * 硬约束：ES5（var / function）、不 import、不 fetch、全中文注释、LF 行尾。
 * 样式类名必须与 index.html 里已有的 .snk-tree* / .tn-* CSS 对齐（那边不归本文件管）。
 */
(function () {
  'use strict';

  /* 数据容器实时读（测试里 window.SNOOKER 可能晚于本脚本赋值），故不缓存 */
  var D = null;
  var BJ = 8 * 3600 * 1000;        /* 北京时间固定 UTC+8（无夏令时），不走机器本地时区 */
  var DIR_KEY = 'snk.tree.dir';     /* 方向偏好持久化键 */
  var DEF_TZ = 'Europe/London';    /* 缺 tz 时回退 */

  /* 纵向常量：左侧轮次名栏宽度由 CSS 定死（124px），这里只排树本体的像素 */
  var U = 140, RH = 72, VG = 46, VCAP = 320;   /* RH 要装得下：2 个名字行 + 2 行时间（北京时间 / 当地） */
  /* 纵向左栏（轮次名 + 场次 + 奖金）宽度：必须与 index.html 里 .snk-vlabels 的 width 一致，
     否则「可用宽度 → 行宽」会算不准，最右几张卡又被挤出去。 */
  var PADL = 124;
  /* 横向常量：列宽与行高固定 */
  var ROW = 58, CARD = 200, GAP = 40, HH = 30;

  /* 每张片段自带的一小段样式：补 index.html 那份 CSS 里没有的「按槽位分胜负」规则
     （那边只给了 .tn-card.lose 的卡片级淡出，这里要按球员分胜负，只能自己补） */
  var SLOT_CSS = '<style>' +
    '.tn-card .sl.win .nm{font-weight:700;}' +
    '.tn-card .sl.win .sc{color:var(--ink);}' +
    '.tn-card .sl.lose .nm{color:var(--sumi-5);font-weight:400;}' +
    '.tn-card .sl.lose .sc{color:var(--sumi-5);font-weight:400;}' +
    '</style>';

  /* ---------------- 小工具 ---------------- */

  /* 数据来自外网，所有动态文本都要过这一道 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  /* '2026-10-18 12:00:00Z' → Date；把 Z 换成 +00:00，免得某些实现当本地时间解析 */
  function utc(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return null;
    var d = new Date(t.replace(' ', 'T').replace(/Z$/, '') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  /* 北京时间：加 8 小时后取 UTC 分量 */
  function bjWhen(s) {
    var d = utc(s);
    if (!d) return '';
    var b = new Date(d.getTime() + BJ);
    return pad2(b.getUTCHours()) + ':' + pad2(b.getUTCMinutes()) + ' ' +
      pad2(b.getUTCMonth() + 1) + '-' + pad2(b.getUTCDate()) +
      ' 周' + '日一二三四五六'.charAt(b.getUTCDay());
  }
  /* 比赛地时间交给 Intl 处理夏令时，绝不自己加减小时数 */
  function localWhen(s, tz) {
    var d = utc(s);
    if (!d || !tz) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(d);
    } catch (e) { return ''; }
  }
  function tzOf(ev) {
    var t = ev && ev.tz;
    return typeof t === 'string' && t ? t : DEF_TZ;
  }
  /* 数据容器读时解析一次；测试/截图里 window.SNOOKER 可能晚于本脚本赋值，故每次读一遍 */
  function data() { if (D !== window.SNOOKER) D = window.SNOOKER || null; return D; }
  function nameTable() { return (data() && data().names) || {}; }
  /* 中文名优先，查不到就显示英文（英文同时进 title，不并排显示，实测会挤爆并裁切） */
  function cnOf(en) { return en ? (nameTable()[en] || en) : ''; }

  function lsGet(k) {
    try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (window.localStorage) window.localStorage.setItem(k, v); } catch (e) {}
  }
  function prefDir() {
    var d = lsGet(DIR_KEY);
    return d === 'h' || d === 'v' ? d : 'v';   /* 纵向为默认 */
  }
  function setDir(d) {
    d = d === 'h' ? 'h' : 'v';
    lsSet(DIR_KEY, d);
    return d;
  }

  /* ---------------- 场次读数 ---------------- */

  function num(v) { return typeof v === 'number' && !isNaN(v) ? v : null; }
  function isDone(m) {
    if (!m) return false;
    var a = num(m.s1), b = num(m.s2);
    return a !== null && b !== null && a !== b;
  }
  function pname(p) { return p && typeof p.n === 'string' && p.n ? p.n : null; }
  /* 胜者名：双方比分齐备且不相等才算，否则没有胜者可依 */
  function winnerOf(m) {
    if (!isDone(m)) return null;
    return m.s1 > m.s2 ? pname(m.p1) : pname(m.p2);
  }

  /* 轮次按深度排序：最浅（决赛，场数最少）在前，最深（场数最多）在最后。
     场数相同时用轮次 id 大的在前 —— 页面自上而下就是 id 由小到大。 */
  function roundsByDepth(ev) {
    var rs = (ev && ev.rounds) || [];
    return rs.slice().sort(function (a, b) {
      var na = num(a.n), nb = num(b.n);
      if (na === null) na = 0;
      if (nb === null) nb = 0;
      if (na !== nb) return na - nb;
      return (num(b.id) || 0) - (num(a.id) || 0);
    });
  }

  /* 主签表链：从决赛（场数最少）往下，只收「场数正好减半」的轮次。
     资格赛那种场数不变、也不与正赛成 2:1 的轮次（北爱的 Last 128/Last 96）收不进这条链，
     它们只是同页并列的另一张表，不参与父子配对。 */
  function mainChain(ev) {
    var depth = roundsByDepth(ev), chain = [], r = null;
    for (var i = 0; i < depth.length; i++) {
      if (r === null) {
        r = depth[i].id;                 /* 最浅的那轮 = 决赛 */
      } else {
        var prev = null;
        for (var j = 0; j < chain.length; j++) if (chain[j].id === r) prev = chain[j];
        if (!prev || num(depth[i].n) !== prev.n * 2) continue;
        r = depth[i].id;
      }
      chain.push(depth[i]);
    }
    return chain;
  }

  /* ---------------- 1. buildTree：父子关系 ----------------
   *
   * 上游不给 bracket 槽位映射，唯一可用的事实是：
   *   「子场已完赛且有比分 ⇒ 它的胜者必然出现在父场（下一轮那场）的某个位置上」。
   * 页序配对：父场第 i 场吃子场第 2i、2i+1 场（页面本来就按签表顺序自上而下列比赛）。
   * 命中数恰好 1 才连（事实边存 n.fact）；连不上且又没有胜者可依 → 留给 geometry
   * 按页序两两配对并标 inferred。不猜、不硬凑。
   */
  function buildTree(ev) {
    ev = ev || {};
    var ms = ev.matches;
    var out = {
      ev: ev, nodes: [], edges: [], cols: [], byKey: {}, byRound: {},
      order: [], depthIdx: {}, rootRound: null, deepestRound: null,
      linked: 0, inferred: 0, orphans: 0, champion: null, empty: true
    };
    if (!ms || !ms.length) return out;

    /* 1) 节点化：按轮次分组，组内按页序编号 idx */
    var ridx = {};
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i] || {};
      var r = m.r;
      if (!out.byRound[r]) out.byRound[r] = [];
      var idx = ridx[r] || 0;
      ridx[r] = idx + 1;
      var n = {
        m: m, r: r, idx: idx, key: r + '#' + idx,
        fact: null,     /* buildTree 阶段核实出来的父场 */
        parent: null,   /* geometry 阶段最终生效的父场 */
        side: -1,       /* buildTree 阶段：本场是父场的第 0 还是第 1 位 */
        kids: [], slot: -1, abs: 0, mid: 0,
        inferred: false, champ: false, col: -1
      };
      out.byRound[r].push(n);
      out.byKey[n.key] = n;
      out.nodes.push(n);
    }

    /* 2) 轮次深度序：order[0] 最浅（决赛），order[len-1] 最深。只取主签表链，
          资格赛那几轮（场数不成 2:1 倍数关系）不入树。 */
    var depth = mainChain(ev), seen = {};
    for (var d = 0; d < depth.length; d++) {
      var id = depth[d].id;
      if (out.byRound[id] && out.byRound[id].length && !seen[id]) {
        seen[id] = 1;
        out.depthIdx[id] = out.order.length;
        out.order.push(id);
      }
    }
    if (!out.order.length) return out;   /* 主签表链在 matches 里一场都找不到 → 整棵树空 */
    out.rootRound = out.order[0];
    out.deepestRound = out.order[out.order.length - 1];

    /* 3) 父子事实：每个深轮 c 与它的浅轮 p。主签表链里场数天然是 2:1，
          「父场第 i 场吃子场第 2i、2i+1 场」才成立；这里再加一道字段校验兜底。 */
    for (d = 0; d < out.order.length - 1; d++) {
      var cid = out.order[d + 1], pid = out.order[d];
      var kids = out.byRound[cid], pars = out.byRound[pid];
      if (!kids || !pars || kids.length !== pars.length * 2) continue;
      for (var pi = 0; pi < pars.length; pi++) {
        var p = pars[pi], pm = p.m || {};
        for (var half = 0; half < 2; half++) {
          var c = kids[2 * pi + half];
          if (!c) continue;
          var w = winnerOf(c.m);
          if (!w) continue;                             /* 无胜者 → 无从核实 */
          var side = -1;
          if (pname(pm.p1) === w) side = 0;
          else if (pname(pm.p2) === w) side = 1;
          if (side < 0) continue;                       /* 父场这一场的两个位置都不是它 */
          c.fact = p;
          c.side = side;
          out.edges.push({ parent: p, child: c, side: side });
        }
      }
    }

    /* 4) 口径（三数一把尺子）：
          只有主签表链里的轮次入树；资格赛那几轮（不成 2:1）算 offTree，不计。
          树根（决赛）没有父场，不计。其余节点：
            有事实边                  → linked    画实线
            无事实边、也没胜者可依     → inferred  画虚线（只能按页序配对）
            连页序位置都没有（结构坏） → orphans   既无边也无页序位置可落
       数据自相矛盾（本该能核实却核实不上）按 inferred 算，不虚报孤儿。 */
    /* 页序配对位置自检：最深轮的父场是 order[k-1]（更浅一层）。rootRound 自己就是父场，不查。 */
    var parN = {};
    for (var k = 1; k < out.order.length; k++) {
      parN[out.order[k]] = (out.byRound[out.order[k - 1]] || []).length;
    }
    var inf = 0, orp = 0, lk = 0;
    out.nodes.forEach(function (n) {
      if (out.depthIdx[n.r] === undefined) { n.off = true; return; }   /* 资格赛等轮次：offTree，不计任何口径 */
      n.off = false;
      if (n.r === out.rootRound) { n.linked = false; n.inferred = false; return; }   /* 树根没有父场 */
      n.linked = !!n.fact;
      if (n.linked) { lk++; return; }
      var slotOK = parN[n.r] !== undefined && Math.floor(n.idx / 2) < parN[n.r];
      if (winnerOf(n.m) || !slotOK) { n.inferred = false; orp++; }
      else { n.inferred = true; inf++; }
    });
    out.linked = lk;
    out.inferred = inf;
    out.orphans = orp;
    out.offTree = out.nodes.filter(function (n) { return n.off; }).length;
    out.champion = winnerOf((out.byRound[out.rootRound] || [])[0] ? out.byRound[out.rootRound][0].m : null);
    out.empty = false;
    return out;
  }

  /* ---------------- 2. geometry：摊成「列 × slot 行」 ----------------
   *
   * cols[] 自深到浅：cols[0] = 树起点（最深轮），cols[last] = 决赛。
   *   span[ci] = 1 << ci            最深列每场占 1 行，每往浅一层占的行数翻倍
   *   列容量自洽：c.n * c.span === 1 << last（否则该列不可信）
   *   rows = cols[0].n = 1 << last  最深列场数
   *   最深列：slot = abs = idx（页序即签表顺序），mid = abs + span/2
   *   父场：取两个子场中心行的均值 → abs = 中心 - span/2，slot = abs / span
   *         （这样决赛中心行必然落在 rows/2）
   * fromRoundId 指定树起点：只渲染它及其更浅的轮次，列索引重排。
   * 起点轮 id 不能硬编码（Last 16/32/64 的 id 逐站变），由调用方传入。
   */
  function geometry(tree, fromRoundId) {
    tree = tree || buildTree(null);
    var byRound = tree.byRound || {}, order = tree.order || [];

    /* 起点轮：id 不存在（或该轮没场次）→ 退到最浅的轮（决赛） */
    var fromId = null, i;
    for (i = 0; i < order.length; i++) {
      if (order[i] === fromRoundId) { fromId = order[i]; break; }
    }
    if (fromId === null) fromId = order.length ? order[0] : null;

    var fromDepth = fromId === null ? 0 : (tree.depthIdx[fromId] || 0);
    /* depthIdx：0 = 决赛（最浅），越大越深。从 fromId 起展树 = 保留「不比它更深」的那些轮，
       也就是 depthIdx <= fromDepth。（曾经写成 >= 把树倒着截了：只留下更深的轮、决赛反而丢了。） */
    var rids = order.filter(function (r) {
      return (tree.depthIdx[r] || 0) <= fromDepth && byRound[r] && byRound[r].length;
    });
    rids.sort(function (x, y) { return (tree.depthIdx[y] || 0) - (tree.depthIdx[x] || 0); });  /* 深 → 浅 */
    if (!rids.length) {
      return {
        tree: tree, cols: [], nodes: [], rows: 0, byRoundId: {}, last: -1, fromId: fromId,
        linked: 0, inferred: 0, orphans: 0, champion: null, finalCenter: 0
      };
    }

    var last = rids.length - 1;
    var cols = rids.map(function (r, ci) {
      return {
        r: r, ri: ci, span: 1 << ci, n: 0, nodes: (byRound[r] || []).slice(),
        head: roundHead(r, tree.ev, (byRound[r] || []).length)
      };
    });
    var rows = cols[0].nodes.length;
    var byRoundId = {};
    cols.forEach(function (c) { byRoundId[c.r] = c; });

    /* 恢复干净：同一棵树可能被 geometry 反复调用（换方向、换起点），派生状态必须可重入 */
    cols.forEach(function (c) {
      c.nodes.forEach(function (n) {
        n.kids = []; n.inferred = false; n.champ = false; n.slot = -1; n.col = c.ri;
        n.parent = null;
      });
    });

    /* 最深列：页序 = slot = abs */
    cols[0].nodes.forEach(function (n) { n.slot = n.idx; n.abs = n.idx; });

    /* 从深往浅逐层落 slot：cols[d-1] 是孩子列，cols[d] 是父场列。
       有事实父场就用事实，没有就按页序 2i/2i+1 猜（标 inferred）。 */
    var orphans = 0;
    for (var d = 1; d <= last; d++) {
      var kidCol = cols[d - 1], parCol = cols[d];
      var kidSpan = kidCol.span, parSpan = parCol.span;
      var inPar = {};
      parCol.nodes.forEach(function (p) { inPar[p.key] = 1; });

      /* 孩子挂父场：只认事实边，且事实父场必须就在这一层 */
      kidCol.nodes.forEach(function (n) {
        if (!n.fact || !inPar[n.fact.key]) return;
        n.parent = n.fact;
        n.inferred = false;
        if (n.fact.kids.indexOf(n) < 0) n.fact.kids.push(n);
      });

      /* 父场落 slot：取已落实的孩子中心行均值 → 决赛中心必落在 rows/2 */
      parCol.nodes.forEach(function (p, pi) {
        var mine = kidCol.nodes.filter(function (k) { return k.parent === p; });
        var use = mine.length ? mine : [kidCol.nodes[2 * pi], kidCol.nodes[2 * pi + 1]];
        var cnt = 0, sum = 0;
        for (var q = 0; q < use.length; q++) {
          if (!use[q] || use[q].slot < 0) continue;
          sum += use[q].abs + kidSpan / 2;
          cnt++;
        }
        var center = cnt ? sum / cnt : (pi + 0.5) * rows / parCol.nodes.length;
        p.abs = center - parSpan / 2;
        p.slot = p.abs / parSpan;
      });

      /* 仍无父场的孩子 → 按页序挂到对应父场；无胜者可依的标 inferred（虚线） */
      kidCol.nodes.forEach(function (n, ci) {
        if (n.parent) return;
        var p = parCol.nodes[Math.floor(ci / 2)];
        if (!p) { orphans++; return; }
        n.parent = p;
        n.inferred = !winnerOf(n.m);
        if (p.kids.indexOf(n) < 0) p.kids.push(n);
      });
    }

    /* 列元信息：按 abs 排序、算中心行、查容量是否自洽 */
    cols.forEach(function (c) {
      c.nodes.sort(function (a, b) { return a.abs - b.abs; });
      c.nodes.forEach(function (n) { n.mid = n.abs + c.span / 2; });
      c.n = c.nodes.length;
      c.trusted = c.n * c.span === rows;
    });

    /* 冠军路径：决赛有比分 → 胜者名 → 参与的场次链全部标 champ */
    var root = cols[last].nodes[0] || null;
    var champion = root ? winnerOf(root.m) : null;
    if (champion) {
      var seen = {}, mark = function (n) {
        if (!n || seen[n.key]) return;
        seen[n.key] = 1;
        var mine = pname(n.m.p1) === champion || pname(n.m.p2) === champion;
        var won = winnerOf(n.m) === champion;
        if (mine || won) n.champ = true;
        for (var t = 0; t < n.kids.length; t++) mark(n.kids[t]);
        if (n.parent && won) mark(n.parent);            /* 本场赢了冠军 → 父场也在路径上 */
      };
      mark(root);
    }

    return {
      tree: tree, cols: cols, nodes: cols.reduce(function (a, c) { return a.concat(c.nodes); }, []),
      rows: rows, byRoundId: byRoundId, last: last, fromId: fromId,
      linked: cols.reduce(function (a, c) {
        return a + c.nodes.filter(function (n) { return n.parent && !n.inferred; }).length;
      }, 0),
      inferred: cols.reduce(function (a, c) {
        return a + c.nodes.filter(function (n) { return n.inferred; }).length;
      }, 0),
      orphans: orphans, champion: champion,
      finalCenter: root ? root.mid : 0
    };
  }

  /* 轮次列头：中文短名 + 场数 + 该轮奖金。
     金额从 roundinfo 原文（rounds[].prize）里用 /£[\d,]+/g 提取：含 Winner 的取前两个
     数（冠军/亚军），否则取最后一个数当「负者 £X」；金额为 0 的过滤掉，不显示 £0。 */
  function roundHead(r, ev, n) {
    var round = null;
    var rs = (ev && ev.rounds) || [];
    for (var i = 0; i < rs.length; i++) {
      if (rs[i] && rs[i].id === r) { round = rs[i]; break; }
    }
    var prize = '';
    if (round && round.prize) {
      var raw = String(round.prize);
      var ms = raw.match(/£[\d,]+/g);
      if (ms && ms.length) {
        var keep = ms.filter(function (x) {
          return parseInt(x.slice(1).replace(/,/g, ''), 10) > 0;
        });
        if (keep.length) {
          prize = /winner/i.test(raw)
            ? keep[0] + ' / ' + (keep[1] || '—')
            : '负者 ' + keep[keep.length - 1];
        }
      }
    }
    return { id: r, cn: round && round.cn ? round.cn : '', n: n, prize: prize };
  }

  /* ---------------- 3. 渲染 ---------------- */

  /* 一场比赛 = 一张卡片（外层 .tn-card 自带绝对定位 style，两种方向只换算像素）。
     已完赛：胜者加粗、负者淡出、比分显示在两侧；未完赛/待定：虚线卡片。 */
  function cardHtml(n, ev, pos) {
    var m = n.m || {};
    var a = pname(m.p1), b = pname(m.p2);
    var done = isDone(m);
    var w = winnerOf(m);

    var cls = 'tn-card';
    if (!a || !b || !done) cls += ' tbd';
    if (n.champ) cls += ' champ';

    /* 时间行：北京时间主行 + 比赛地时间小字 */
    var tm;
    if (done && !(m.ses && m.ses.length && utc(m.ses[0]))) {
      /* 赛后上游会把 scheduled 单元格撤成 wst.tv 链接 → 时刻永久丢失。
         这时候写「时刻待定」是撒谎，写「已结束」才对。 */
      tm = '已结束';
    } else if (m.ses && m.ses.length && utc(m.ses[0])) {
      tm = esc(bjWhen(m.ses[0]));
      var lo = localWhen(m.ses[0], tzOf(ev));
      /* 当地时刻用不换行空格黏住，否则会在「当地」和时刻之间断行 */
      if (lo) tm += ' <span class="lo">当地&nbsp;' + esc(lo) + '</span>';
    } else if (m.day) {
      tm = '时刻待定 约 ' + esc(m.day);                 /* day 是英文日期原文，原样显示 */
    } else {
      tm = '时刻待定';
    }

    var body;
    if (a && b) {
      /* 两边都有名字 → 竖排两个槽位（比分没打就不显示比分）。
         上游在赛前就把 64 强的名字填齐了，这是常态，别把它画成「待定」。 */
      body = slotHtml(a, done ? num(m.s1) : null, !!w && w === a) +
        slotHtml(b, done ? num(m.s2) : null, !!w && w === b);
    } else {
      /* 有一边空：合并成一行，否则两个槽位在半空卡片里会重叠 */
      body = '<div class="sl mid"><span class="nm" title="' + esc(a || '') + '">' +
        esc(a ? cnOf(a) : '待定') + '</span><span class="vs">vs</span><span class="nm">待定</span></div>';
    }
    return '<div class="' + cls + '" style="' + pos + '">' + body +
      '<div class="tm">' + tm + '</div></div>';
  }

  /* 一个球员槽位：中文名优先，英文名进 title（不并排显示，实测会挤爆并裁切） */
  function slotHtml(name, score, win) {
    if (!name) return '<div class="sl"><span class="nm lose">待定</span></div>';
    return '<div class="sl' + (win ? ' win' : '') + '" title="' + esc(name) + '">' +
      '<span class="nm' + (win ? '' : ' lose') + '">' + esc(cnOf(name)) + '</span>' +
      (score === null ? '' : '<span class="sc">' + esc(score) + '</span>') +
      '</div>';
  }

  function headHtml(c) {
    return '<b>' + esc(c.head.cn) + '</b><span>' + c.head.n + ' 场</span>' +
      (c.head.prize ? '<span class="pz">' + esc(c.head.prize) + '</span>' : '');
  }

  function px(n) { return (Math.round(n * 10) / 10) + ''; }

  /* ---- 纵向（默认）：轮次自上而下，最深的轮在最上、决赛在最下，轮内自左向右 ----
     两栏 flex：左侧轮次名栏固定 124px（CSS 定死），右侧树本体自己横滚。
     32 场那轮约 4480px 宽，靠横滚是预期行为。 */
  function renderV(g, ev, unit) {
    var cols = g.cols, last = cols.length - 1, d, c, n, i;
    if (!cols.length) return '<p class="tn-note">这场次暂时没有可排的轮次。</p>';
    /* 行宽自适应：8 行那站希望一屏看全（否则最右几张卡被挤到横滚区外），
       32 行那站必然要横滚，就别把卡压窄了。 */
    var u = unit || U;
    var W = g.rows * u, H = cols.length * RH + (cols.length - 1) * VG;
    var pos = {}, labels = '', cards = '', paths = '';

    for (d = 0; d < cols.length; d++) {                 /* 最深轮 band=0（顶），决赛 band=last（底） */
      c = cols[d];
      var yl = d * (RH + VG);
      labels += '<div class="tn-head" style="position:absolute;left:0;right:0;top:' + px(yl) + 'px">' +
        headHtml(c) + '</div>';
    }

    for (d = 0; d < cols.length; d++) {
      c = cols[d];
      var yb = d * (RH + VG);
      for (i = 0; i < c.nodes.length; i++) {
        n = c.nodes[i];
        var w = Math.min(c.span * u - 12, VCAP);
        pos[n.key] = { cx: n.mid * u, w: w, y0: yb, y1: yb + RH };
        cards += cardHtml(n, ev, 'position:absolute;left:' + px(n.mid * u - w / 2) + 'px;top:' + px(yb) +
          'px;width:' + px(w) + 'px;height:' + RH + 'px');
      }
    }

    /* 连线：子卡下缘中点 → 折向父卡上缘中点 */
    for (d = 0; d < cols.length; d++) {
      c = cols[d];
      for (i = 0; i < c.nodes.length; i++) {
        n = c.nodes[i];
        var o = pos[n.key], pa = n.parent ? pos[n.parent.key] : null;
        if (!o || !pa) continue;
        var ym = (o.y1 + pa.y0) / 2;
        paths += '<path class="' + lineCls(n) + '" d="M' + px(o.cx) + ' ' + px(o.y1) +
          ' V' + px(ym) + ' H' + px(pa.cx) + ' V' + px(pa.y0) + '"/>';
      }
    }

    return '<div class="snk-treebox v">' +
      '<div class="snk-vlabels" style="height:' + px(H) + 'px">' + labels + '</div>' +
      '<div class="snk-vscroll"><div class="tn-canvas" style="width:' + px(W) + 'px;height:' + px(H) + 'px">' +
      '<svg class="tn-lines" width="' + px(W) + '" height="' + px(H) + '">' + paths + '</svg>' +
      cards + '</div></div></div>';
  }

  /* 横向：轮次自左向右（最深的轮在最左、决赛在最右），轮内自上而下，标准签表观感 */
  function renderH(g, ev) {
    var cols = g.cols, d, c, n, i;
    if (!cols.length) return '<p class="tn-note">这场次暂时没有可排的轮次。</p>';
    var W = cols.length * CARD + (cols.length - 1) * GAP;
    var H = g.rows * ROW + HH;
    var pos = {}, heads = '', cards = '', paths = '';

    /* cols[0] 是最深轮（树起点），要摆在最左边 */
    for (d = 0; d < cols.length; d++) {
      c = cols[d];
      c.x = d * (CARD + GAP);
      heads += '<div class="tn-head" style="position:absolute;left:' + px(c.x) + 'px;top:0;width:' + CARD + 'px">' +
        headHtml(c) + '</div>';
    }

    for (d = 0; d < cols.length; d++) {
      c = cols[d];
      for (i = 0; i < c.nodes.length; i++) {
        n = c.nodes[i];
        var cy = n.mid * ROW + HH;
        pos[n.key] = { x: c.x, cy: cy };
        cards += cardHtml(n, ev, 'position:absolute;left:' + px(c.x) + 'px;top:' + px(cy - ROW / 2) +
          'px;width:' + CARD + 'px;height:' + ROW + 'px');
      }
    }

    /* 连线：子卡右缘中点 → 折向父卡左缘中点 */
    for (d = 0; d < cols.length; d++) {
      c = cols[d];
      for (i = 0; i < c.nodes.length; i++) {
        n = c.nodes[i];
        var o = pos[n.key], pa = n.parent ? pos[n.parent.key] : null;
        if (!o || !pa) continue;
        /* 折点落在两列空隙中间，不踩到卡片边框 */
        var xm = (o.x + CARD + pa.x) / 2;
        paths += '<path class="' + lineCls(n) + '" d="M' + px(o.x + CARD) + ' ' + px(o.cy) +
          ' H' + px(xm) + ' V' + px(pa.cy) + ' H' + px(pa.x) + '"/>';
      }
    }

    return '<div class="snk-treebox"><div style="overflow-x:auto"><div class="tn-canvas" style="width:' +
      px(W) + 'px;height:' + px(H) + 'px">' +
      heads +
      '<svg class="tn-lines" width="' + px(W) + '" height="' + px(H) + '">' + paths + '</svg>' +
      cards + '</div></div></div>';
  }

  /* 三种线：虚线（待定）/ 红色实线（冠军路径）/ 灰色实线 */
  function lineCls(n) {
    return n.inferred ? 'inf' : (n.champ ? 'champ' : '');
  }

  /* ---------------- 对外 ---------------- */

  /* render(ev, opts) → 完整自包含 HTML 片段（内联 style + 内联 svg 连线）
     opts: { fromId, dir: 'v'|'h', tzOffLabel } */
  function render(ev, opts) {
    opts = opts || {};
    var dir = opts.dir === 'h' ? 'h' : (opts.dir === 'v' ? 'v' : prefDir());

    if (!ev || typeof ev !== 'object') return SLOT_CSS + '<p class="tn-note">没有拿到这个站的数据。</p>';
    if (!ev.matches || !ev.matches.length) {
      return SLOT_CSS + '<p class="tn-note">这场次级明细还没抓取。</p>';
    }

    var tree = buildTree(ev);
    if (tree.empty) return SLOT_CSS + '<p class="tn-note">这场次级明细还没抓取。</p>';
    var g = geometry(tree, opts.fromId);
    if (!g.cols.length) return SLOT_CSS + '<p class="tn-note">这场次暂时没有可排的轮次。</p>';

    /* 纵向行宽：调用方给了可用宽度就按行数摊，最少 112px（再窄名字就废了） */
    var unit = U;
    if (opts.avail) {
      var fit = Math.floor((opts.avail - PADL - 16) / Math.max(1, g.rows));
      /* 能一屏放下就摊开；放不下（64 强 32 行那种必然要横滚）就別把卡压窄 —— 压到 112px 名字只剩「杰…」 */
      unit = fit >= 120 ? Math.min(U, fit) : U;
    }
    return SLOT_CSS + '<div class="snk-tree">' + (dir === 'h' ? renderH(g, ev) : renderV(g, ev, unit)) +
      footHtml(g) + '</div>';
  }

  /* 树脚注：连线含义 + 总数（0 也照常显示，不留空白） */
  function footHtml(g) {
    return '<div class="tn-foot">连线 实线 ' + g.linked + ' 条（按已完赛场次的胜者核实）· 虚线 ' +
      g.inferred + ' 条（待定，按页序两两配对）· ' + g.rows + ' 行 × ' + g.cols.length + ' 轮' +
      (g.champion ? ' · 冠军 ' + esc(cnOf(g.champion)) : '') + '</div>';
  }

  window.SnookerTree = {
    buildTree: buildTree,
    geometry: geometry,
    render: render,
    html: render,          /* render 的别名 */
    prefDir: prefDir,      /* 方向持久化：调用方切方向时配 setDir 用 */
    setDir: setDir
  };
})();