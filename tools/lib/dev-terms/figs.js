/* 图形语法：16 个模板，全部 340×150 画布，靠 CSS class 上色。
   每个术语只给一句 spec：{ t:'flow', a:['页面','接口'] } —— a 是该模板的入参。 */
(function () {
  var UID = 0;
  var AR = function () { return ''; };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function T(x, y, s, cls, anchor) {
    return '<text x="' + x + '" y="' + y + '" class="' + (cls || 'f-lab') +
      '" text-anchor="' + (anchor || 'middle') + '">' + esc(s) + '</text>';
  }
  function R(x, y, w, h, cls, rx) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
      '" rx="' + (rx == null ? 6 : rx) + '" class="' + (cls || 'f-box') + '"/>';
  }
  function box(x, y, w, h, label, cls, sub) {
    var cy = y + h / 2 + (sub ? -1.5 : 3.5);
    return R(x, y, w, h, cls) + T(x + w / 2, cy, label, 'f-lab') +
      (sub ? T(x + w / 2, y + h - 6, sub, 'f-sub') : '');
  }
  function pill(x, y, w, h, label, cls) {
    return R(x, y, w, h, cls || 'f-pill', h / 2) + T(x + w / 2, y + h / 2 + 3.4, label, 'f-lab');
  }

  function svg(label, build) {
    UID += 1;
    var id = 'ah' + UID;
    AR = function (d, cls) {
      return '<path d="' + d + '" class="f-ar ' + (cls || '') + '" marker-end="url(#' + id + ')"/>';
    };
    return '<svg class="fig" viewBox="0 0 340 150" role="img" aria-label="' + esc(label) +
      '" preserveAspectRatio="xMidYMid meet">' +
      '<defs><marker id="' + id + '" viewBox="0 0 8 8" refX="6.4" refY="3" markerWidth="5" markerHeight="5" orient="auto">' +
      '<path d="M0,0 L6.4,3 L0,6 z" class="f-head"/></marker></defs>' +
      build() + '</svg>';
  }

  /* ---------- 模板 ---------- */

  function flow(items) {
    var n = items.length, gap = 20;
    var w = Math.min(104, (340 - 16 - gap * (n - 1)) / n);
    if (n > 1) gap = (340 - 16 - n * w) / (n - 1);
    var out = '';
    for (var i = 0; i < n; i++) {
      var x = 8 + i * (w + gap);
      out += box(x, 57, w, 36, items[i], i === n - 1 ? 'f-box-accent' : 'f-box');
      if (i < n - 1) out += AR('M' + (x + w + 3) + ',75 L' + (x + w + gap - 3) + ',75');
    }
    return out;
  }

  function fanout(o) {
    var tos = o.a, n = tos.length, out = '';
    out += box(8, 57, 88, 36, o.from, 'f-box');
    var h = n > 2 ? 26 : 32;
    for (var i = 0; i < n; i++) {
      var y = n === 1 ? 57 : 12 + i * ((150 - 24 - h) / (n - 1));
      out += box(226, y, 106, h, tos[i], 'f-box-muted');
      out += AR('M96,75 C 158,75 164,' + (y + h / 2) + ' 224,' + (y + h / 2));
    }
    if (o.n) out += T(n === 1 ? 170 : 150, n === 1 ? 112 : 132, o.n, 'f-badge');
    return out;
  }

  function merge(o) {
    var sources = o.a, n = sources.length, out = '', h = n > 2 ? 26 : 32;
    for (var i = 0; i < n; i++) {
      var y = n === 1 ? 57 : 12 + i * ((150 - 24 - h) / (n - 1));
      out += box(8, y, 106, h, sources[i], 'f-box-muted');
      out += AR('M114,' + (y + h / 2) + ' C 172,' + (y + h / 2) + ' 178,75 224,75');
    }
    out += box(226, 57, 106, 36, o.to, 'f-box-accent');
    if (o.n) out += T(170, 100, o.n, 'f-badge');
    return out;
  }

  function layers(items) {
    var n = items.length, out = '';
    var gap = n > 3 ? 8 : 18;
    var h = Math.min(36, (150 - 20 - gap * (n - 1)) / n);
    var total = n * h + (n - 1) * gap;
    var top = (150 - total) / 2;
    for (var i = 0; i < n; i++) {
      var y = top + i * (h + gap);
      out += box(20, y, 300, h, items[i], i === n - 1 ? 'f-box-accent' : 'f-box');
      if (i < n - 1) out += AR('M170,' + (y + h + 1) + ' L170,' + (y + h + gap - 1));
    }
    return out;
  }

  function nest(o) {
    var out = R(24, 12, 292, 126, 'f-box', 10);
    out += T(170, 31, o.title, 'f-lab');
    var kids = o.a;
    if (kids.length === 1) {
      out += box(70, 54, 200, 50, kids[0], 'f-box-accent');
    } else {
      var w = (248 - 12 * (kids.length - 1)) / kids.length;
      for (var i = 0; i < kids.length; i++) out += box(46 + i * (w + 12), 54, w, 50, kids[i], 'f-box-accent');
    }
    if (o.sub) out += T(170, 127, o.sub, 'f-sub');
    return out;
  }

  function gate(o) {
    var out = box(4, 57, 86, 36, o.left, 'f-box') +
      '<line x1="170" y1="16" x2="170" y2="134" class="f-gate"/>' +
      T(170, 10, o.gate, 'f-sub') +
      box(250, 57, 86, 36, o.right, 'f-box-accent');
    if (o.dash) {
      out += AR('M90,66 L250,66', 'f-dash') + T(170, 58, o.dash, 'f-sub');
      out += AR('M90,86 L250,86') + T(170, 108, o.ok || '放行', 'f-sub');
    } else {
      out += AR('M90,75 L250,75') + T(170, 102, o.ok || '放行', 'f-sub');
    }
    return out;
  }

  function store(o) {
    var cols = o.a, cw = 188 / cols.length, x = 76, y = 24, hh = 22, rh = 24, out = '';
    out += R(x, y, 188, hh, 'f-th', 4);
    for (var i = 0; i < cols.length; i++) {
      out += T(x + cw * i + cw / 2, y + 15, cols[i], 'f-thlab');
      out += '<line x1="' + (x + cw * i) + '" y1="' + y + '" x2="' + (x + cw * i) + '" y2="' + (y + hh) + '" class="f-rule"/>';
    }
    out += '<line x1="' + x + '" y1="' + (y + hh) + '" x2="' + (x + 188) + '" y2="' + (y + hh) + '" class="f-rule"/>';
    for (var r = 0; r < 2; r++) {
      var ry = y + hh + r * rh;
      out += '<line x1="' + x + '" y1="' + (ry + rh) + '" x2="' + (x + 188) + '" y2="' + (ry + rh) + '" class="f-rule"/>';
      for (var c = 0; c < cols.length; c++) {
        out += '<line x1="' + (x + cw * c) + '" y1="' + ry + '" x2="' + (x + cw * c) + '" y2="' + (ry + rh) + '" class="f-rule"/>';
      }
    }
    if (o.sub) out += T(x + 94, y + hh + 2 * rh + 20, o.sub, 'f-sub');
    return out;
  }

  function cacheflow(o) {
    var out = box(4, 57, 62, 36, o.l);
    out += AR('M68,66 L96,66');
    out += '<g class="f-store">' + R(96, 24, 76, 102, 'f-box') +
      '<line x1="104" y1="44" x2="164" y2="44" class="f-rule"/>' +
      '<line x1="134" y1="44" x2="134" y2="118" class="f-rule"/></g>';
    out += T(134, 38, o.m, 'f-lab');
    out += T(115, 64, o.k1 || 'key', 'f-sub') + T(149, 64, o.k2 || 'val', 'f-sub');
    out += AR('M172,76 L256,76', 'f-dash') + T(214, 92, o.back || '回源', 'f-sub');
    out += AR('M256,96 L172,96', 'f-dash') + T(214, 114, o.fill || '回填', 'f-sub');
    out += box(256, 57, 80, 36, o.r);
    return out;
  }

  function queue(o) {
    var out = box(4, 57, 66, 36, o.l);
    out += AR('M70,68 L90,68') + T(80, 60, o.tag || '202', 'f-badge');
    out += '<g class="f-queue">' + R(90, 32, 88, 76, 'f-box') +
      '<line x1="119" y1="32" x2="119" y2="108"/><line x1="148" y1="32" x2="148" y2="108"/></g>';
    out += T(134, 24, o.m, 'f-sub');
    out += AR('M178,88 L214,88', 'f-dash') + T(196, 106, o.later || '稍后处理', 'f-sub');
    out += box(214, 57, 122, 36, o.r);
    return out;
  }

  function segments(segs) {
    var total = 0, i, x = 18, w = 304, y = 42, hh = 44, out = '';
    for (i = 0; i < segs.length; i++) total += segs[i].w || 1;
    for (i = 0; i < segs.length; i++) {
      var sw = w * (segs[i].w || 1) / total;
      out += '<rect x="' + x + '" y="' + y + '" width="' + sw + '" height="' + hh +
        '" class="f-seg' + ((i % 3) + 1) + '" rx="' + (i === 0 || i === segs.length - 1 ? 5 : 0) + '"/>';
      out += T(x + sw / 2, y + hh / 2 + 4, segs[i].t, 'f-lab');
      if (segs[i].s) out += T(x + sw / 2, y + hh + 20, segs[i].s, 'f-sub');
      x += sw;
    }
    return out;
  }

  function compare(o) {
    var out = '';
    [[8, o.l], [176, o.r]].forEach(function (p) {
      var n = p[1].a.length, top = 56 - (n - 1) * 10.5;
      out += R(p[0], 16, 156, 118, 'f-panel', 8);
      out += T(p[0] + 78, 38, p[1].t, 'f-lab');
      p[1].a.forEach(function (line, i) { out += T(p[0] + 78, top + 26 + i * 21, line, 'f-sub'); });
    });
    return out;
  }

  function compare3(o) {
    var out = '';
    [6, 118, 230].forEach(function (x, k) {
      var p = o.a[k];
      out += R(x, 16, 104, 118, k === o.hot ? 'f-panel-hot' : 'f-panel', 8);
      out += T(x + 52, 38, p.t, 'f-lab');
      p.a.forEach(function (line, i) { out += T(x + 52, 62 + i * 20, line, 'f-sub'); });
    });
    return out;
  }

  function timeline(o) {
    var pts = o.a, n = pts.length, out = '', x0 = 28, x1 = 312, y = 82;
    out += '<line x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y + '" class="f-axis"/>';
    for (var i = 0; i < n; i++) {
      var x = n === 1 ? 170 : x0 + i * (x1 - x0) / (n - 1);
      out += '<circle cx="' + x + '" cy="' + y + '" r="4.5" class="' + (i === o.hot ? 'f-dot-hot' : 'f-dot') + '"/>';
      var anc = i === 0 ? 'start' : (i === n - 1 ? 'end' : '');
      var ax = i === 0 ? x - 6 : (i === n - 1 ? x + 6 : x);
      out += T(ax, y - 16, pts[i].t, 'f-lab', anc);
      if (pts[i].s) out += T(ax, y + 24, pts[i].s, 'f-sub', anc);
    }
    return out;
  }

  function cycle(o) {
    var pts = o.a, out = '';
    var pos = [[170, 18, 120], [78, 110, 104], [262, 110, 104]];
    for (var i = 0; i < 3; i++) {
      var p = pos[i], w = p[2], h = 32;
      out += box(p[0] - w / 2, p[1], w, h, pts[i], i === o.hot ? 'f-box-accent' : 'f-box');
    }
    out += AR('M232,44 C 292,56 300,88 272,104');
    out += AR('M208,126 C 186,144 152,144 132,126');
    out += AR('M80,110 C 28,96 34,46 108,52');
    return out;
  }

  function tree(o) {
    var out = box(120, 12, 100, 30, o.root, 'f-box');
    var kids = o.a, n = kids.length;
    for (var i = 0; i < n; i++) {
      var w = (340 - 16 - 12 * (n - 1)) / n, x = 8 + i * (w + 12);
      out += '<path d="M170,44 L' + (x + w / 2) + ',98" class="f-line"/>';
      out += box(x, 98, w, 30, kids[i], 'f-box-muted');
    }
    return out;
  }

  function rings(o) {
    var l = o;
    return R(10, 8, 320, 134, 'f-box', 12) + T(28, 28, l[0], 'f-lab', 'start') +
      R(48, 40, 244, 86, 'f-box', 10) + T(66, 60, l[1] || '', 'f-lab', 'start') +
      R(90, 68, 160, 44, 'f-box-accent', 8) + (l[2] ? T(170, 95, l[2], 'f-lab') : '');
  }

  /* 变体并列：n 个做法竖排，左边名字右边一句「什么时候用」。 */
  function variants(o) {
    var items = (o && o.items) || [], n = items.length || 1;
    var top = 12;
    if (o.title) top = n >= 5 ? 26 : 30;
    var gap = n >= 5 ? 4 : 7;
    var h = Math.min(30, Math.floor((150 - top - 8 - gap * (n - 1)) / n));
    var out = o.title ? T(14, 18, o.title, 'f-sub', 'start') : '';
    for (var i = 0; i < n; i++) {
      var y = top + i * (h + gap), it = items[i];
      out += R(12, y, 316, h, i === o.hot ? 'f-box-accent' : 'f-box', 6);
      out += T(26, y + h / 2 + 3.5, it[0], 'f-lab', 'start');
      if (it[1]) out += T(316, y + h / 2 + 3.5, it[1], 'f-sub', 'end');
    }
    return out;
  }

  function twice(o) {
    return pill(70, 8, 160, 24, o.req) +
      AR('M108,34 L108,54') + AR('M192,34 L192,54') + T(244, 32, '×2', 'f-badge') +
      box(70, 56, 160, 34, o.mid, 'f-box') +
      AR('M150,92 L150,106') +
      R(70, 108, 160, 30, 'f-box-accent') + T(150, 127, o.res, 'f-lab');
  }

  var MAP = {
    flow: flow, fanout: fanout, merge: merge, layers: layers, nest: nest, gate: gate,
    store: store, cacheflow: cacheflow, queue: queue, segments: segments,
    compare: compare, compare3: compare3, timeline: timeline, cycle: cycle,
    tree: tree, rings: rings, twice: twice, variants: variants
  };

  window.FIGS = {
    render: function (spec) {
      var fn = MAP[spec.t];
      if (!fn) throw new Error('未知图型 ' + spec.t);
      // timeline / compare3 / cycle 的 spec 是「数组 + hot」，其余模板的入参都在 spec.a 里
      var arg = ['timeline', 'compare3', 'cycle'].includes(spec.t) ? { a: spec.a, hot: spec.hot } : spec.a;
      return svg(spec.alt || spec.t, function () { return fn(arg); });
    }
  };
})();
