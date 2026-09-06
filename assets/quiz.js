/* 日语学习资料库 · 自测练习（可选答）
 *
 * 把每道题的 ol.options 选项变成可点击按钮：
 *   选答 → 立即判定对错 → 标出正确答案 → 自动展开「答案与解析」。
 *
 * 正确答案从该题 p.answer 的文本解析（格式统一为「正确答案：N（…）」）。
 * 解析不到答案的题目保持原样、不做改造，宁可不交互也不能误判。
 *
 * 与 theme.js / progress.js 一样以普通 <script> 引入，无依赖、不改 HTML。
 */
(function () {
  'use strict';

  var RE_ANSWER = /正确答案[：:]\s*(\d+)/;

  function setup(q) {
    var i, lis = q.querySelectorAll('ol.options > li');
    if (!lis.length) return;

    var ans = null;
    var ap = q.querySelector('p.answer');
    if (ap) {
      var m = RE_ANSWER.exec(ap.textContent || '');
      if (m) ans = parseInt(m[1], 10);
    }
    if (!ans || ans < 1 || ans > lis.length) return;   // 无答案或越界：放弃改造

    var det = q.querySelector('details.explanation-block');

    // 判定结果行：role=status 让读屏自动播报
    var res = document.createElement('p');
    res.className = 'q-result';
    res.setAttribute('role', 'status');
    if (det) q.insertBefore(res, det);
    else q.appendChild(res);

    for (i = 0; i < lis.length; i++) bind(lis[i], i + 1, lis, ans, det, res, q);
  }

  function bind(li, n, lis, ans, det, res, q) {
    // 把 li 的内容整体挪进 button：li 继续当视觉盒子，button 负责可点击与键盘可达
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt-btn';
    while (li.firstChild) btn.appendChild(li.firstChild);
    li.appendChild(btn);
    li.classList.add('has-btn');

    btn.addEventListener('click', function () {
      var i, right = (n === ans);

      for (i = 0; i < lis.length; i++) lis[i].classList.remove('is-picked', 'is-wrong', 'is-answer');

      lis[n - 1].classList.add('is-picked');
      if (right) lis[n - 1].classList.add('is-answer');
      else { lis[n - 1].classList.add('is-wrong'); lis[ans - 1].classList.add('is-answer'); }

      q.classList.toggle('is-right', right);
      q.classList.toggle('is-wrong', !right);

      res.textContent = right ? '回答正确' : '回答错误 · 正确答案 ' + ans;
      res.classList.toggle('is-right', right);
      res.classList.toggle('is-wrong', !right);

      if (det) det.open = true;      // 自动展开答案与解析
    });
  }

  function boot() {
    var qs = document.querySelectorAll('div.question-block'), i;
    for (i = 0; i < qs.length; i++) setup(qs[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
