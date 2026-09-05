/* 日语学习资料库 主题切换（浅色/深色）
 * 所有页面共用：在 <head> 中以普通 <script> 引入，
 * 会立即根据 localStorage 恢复主题以避免闪烁，DOM 就绪后在右上角生成切换按钮。 */
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

  function ready(fn) {
    if (document.readyState !== 'loading') { fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  }

  ready(function () {
    var box = document.createElement('div');
    box.className = 'theme-switch';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '外观切换');
    box.innerHTML =
      '<span class="ts-label">外观</span>' +
      '<button type="button" data-v="light">浅色</button>' +
      '<button type="button" data-v="dark">深色</button>';
    document.body.appendChild(box);

    var btns = box.querySelectorAll('button');
    function sync() {
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].getAttribute('data-v') === current);
      }
    }
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        current = this.getAttribute('data-v');
        save(current);
        apply(current);
        sync();
      });
    }
    sync();
  });
})();
