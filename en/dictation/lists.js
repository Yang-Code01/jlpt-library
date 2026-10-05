/* 英语听写 · 词单数据适配
   词源与英语词表同一份（en/data/vocab.js 的 window.EN_VOCAB），运行时现算，
   不另存一份数据文件：77 个单元与词表单元一一对应（1k 01–20 / 2k 21–40 /
   3k 41–57 / 4k 58–77），按档位分组。
   一条词的映射：w = 单词；k = 音标（页面里当"读音"列显示，也写进错词本）；
   m = 中文释义首行；p = 词性。判题只看 w，见 cfg.js。
   ⚠️ 本文件必须在 dictation.js 之前加载（内核启动时就渲染词单）。 */
(function () {
  'use strict';

  var V = (typeof window !== 'undefined' && window.EN_VOCAB) || null;
  if (!V || !V.words || !V.meta) return;

  /* 档位配色：沿用站内令牌（1k 用朱色主色，往后逐档压暗） */
  var BAND_COLOR = { '1k': '--accent', '2k': '--sumi-2', '3k': '--sumi-3', '4k': '--sumi-4' };
  var PER_UNIT = V.meta.perUnit || 50;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /* 中释是多行（字面量 \n），听写提示只取首行 */
  function firstLine(s) { return String(s == null ? '' : s).split(/\\n|\n/)[0].trim(); }
  function phonetic(ph) { return ph ? '/' + String(ph).trim() + '/' : ''; }

  var bands = {};
  V.meta.bands.forEach(function (b) { bands[b.id] = b; });

  var lists = [], cur = null, lastUnit = 0;
  V.words.forEach(function (w) {
    if (!cur || lastUnit !== w.unit) {
      var band = bands[w.band] || { id: w.band, from: w.rank, to: w.rank, unitFrom: w.unit };
      /* 单元区间按档位起点 + 档内序号算（3k 只有 809 词，跟位次不成整数倍） */
      var local = w.unit - (band.unitFrom || w.unit);
      var from = (band.from != null ? band.from : w.rank) + local * PER_UNIT;
      var to = Math.min(from + PER_UNIT - 1, band.to != null ? band.to : from);
      cur = {
        id: 'en-' + w.band + '-' + pad2(w.unit),
        title: '单元 ' + pad2(w.unit),
        group: w.band,
        desc: '词频位次 ' + num(from) + '–' + num(to),
        color: BAND_COLOR[w.band] || '--sumi-3',
        words: []
      };
      lastUnit = w.unit;
      lists.push(cur);
    }
    cur.words.push({
      w: w.w,
      k: phonetic(w.ph),
      m: firstLine(w.tr) || w.w,
      p: w.pos || ''
    });
  });

  window.DICTATION_LISTS = lists;
})();
