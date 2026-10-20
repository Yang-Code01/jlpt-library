/* 门户：把进度分母（assets/units.js）接到卡片右栏的进度胶囊上。
   数据全在浏览器本地（LibProgress），file:// 下无网络请求。
   没有分母的卡片（真题 / 听力 / 听写 …）不显示胶囊，只显示规模徽章。 */
(function () {
  'use strict';

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function mount() {
    var P = window.LibProgress;
    var units = window.WB_UNITS || {};
    var cards = document.querySelectorAll('[data-units]');

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var bucket = card.getAttribute('data-units');
      var list = units[bucket];
      var pill = card.querySelector('.prog-pill');
      if (!pill) continue;

      if (!list || !list.length || !P) {
        pill.setAttribute('data-state', 'empty');
        continue;
      }

      var done = P.count('', list);
      var total = list.length;
      var pct = total ? Math.round((done / total) * 100) : 0;

      pill.style.setProperty('--p', pct + '%');
      var val = pill.querySelector('.prog-val');
      if (val) val.innerHTML = fmt(done) + '<em>/' + fmt(total) + '</em>';
      pill.setAttribute('aria-label', '已看 ' + done + ' / ' + total + ' 个单元');
      pill.setAttribute('data-state', done === 0 ? 'zero' : 'on');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
