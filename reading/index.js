/* 日语阅读 · 篇目页脚本
   只做两件事：把已读完的篇目标出来、更新顶部计数。判据来自 assets/progress.js。 */
(function () {
  'use strict';
  var LP = window.LibProgress;
  var rows = document.querySelectorAll('[data-key]');
  var meter = document.getElementById('jpReadDone');
  var i;
  var n = 0;
  for (i = 0; i < rows.length; i++) {
    var k = rows[i].getAttribute('data-key');
    var done = !!(LP && LP.isDone(k));
    rows[i].classList.toggle('is-done', done);
    if (done) n++;
  }
  if (meter) meter.textContent = '已读 ' + n + '/' + rows.length;
})();
