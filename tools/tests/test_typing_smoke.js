/* ============================================================
   打字练习 · 冒烟测试（VM + DOM 桩，无框架、无浏览器）
   运行：node tools/tests/test_typing_smoke.js
   思路同 tools/tests/domharness.js：用 Node 的 vm 造一个最小
   window/document 环境，加载 romaji.js + typing.js，直接驱动游戏内核。

   覆盖（issue 04 增量加粗）：
     A 初始化 / index.html 与 JS 一致 / 移动端隐藏 input 属性齐全
     B Sound 六方法在「无 AudioContext」下安全调用（不抛错）
     C 音效开关读写 localStorage[jlpt-typing-sound]
     D 移动端隐藏 input 的 input 事件经 handleChar 正确收词 + 清空 + 重聚焦
     E 空格修复：聚焦按钮时不吞空格；否则阻止滚动 / 切换暂停
     F 回归：选档 / 收词计分 / 错字 / 退出确认 / 最高分 / 三档注入 / 暂停
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const TYPING = REPO + '/typing';
const html = fs.readFileSync(TYPING + '/index.html', 'utf8');

/* ---- 从 index.html 抽取 id 与 .ty-opt（JS 用到未声明的 id 即报错） ---- */
const ids = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);

const optAttrMaps = [];
for (const m of html.matchAll(/<button\b([^>]*)>/g)) {
  const attrs = m[1];
  const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
  if (!cls.split(/\s+/).includes('ty-opt')) continue;
  const map = {};
  for (const am of attrs.matchAll(/(data-[a-z-]+|class|id)="([^"]*)"/g)) map[am[1]] = am[2];
  optAttrMaps.push(map);
}

const loadedScripts = [];
let failed = 0, total = 0;
function ok(cond, msg) {
  total++;
  if (cond) { console.log('  PASS  ' + msg); }
  else { failed++; console.log('  FAIL  ' + msg); }
}

/* ---- 元素桩 ---- */
function mkEl(id, attrMap) {
  const classes = new Set(String((attrMap && attrMap.class) || '').split(/\s+/).filter(Boolean));
  const attrs = Object.assign({}, attrMap || {});
  const store = {};
  const el = {
    id: id || '', _text: '', _html: '', src: '', _focused: false,
    hidden: false, disabled: false, value: '', checked: false, offsetWidth: 0,
    _lis: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, f) => { if (f === undefined) (classes.has(c) ? classes.delete(c) : classes.add(c)); else (f ? classes.add(c) : classes.delete(c)); }
    },
    _classes: classes,
    style: new Proxy(store, {
      get(t, p) {
        if (p === 'setProperty') return (k, v) => { t[k] = v; };
        if (p === 'getPropertyValue') return (k) => t[k] || '';
        if (p === 'removeProperty') return (k) => { delete t[k]; };
        return t[p];
      },
      set(t, p, v) { t[p] = v; return true; }
    }),
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs,
    appendChild(c) { if (c) c.parentNode = this; return c; },
    removeChild(c) { return c; },
    focus() { this._focused = true; }, select() {}, scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (this._lis[t] = this._lis[t] || []).push(fn); },
    fire(t, ev) { (this._lis[t] || []).forEach((fn) => fn(ev || {})); }
  };
  Object.defineProperty(el, 'textContent', { get: () => el._text, set: (v) => { el._text = String(v); } });
  Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el._html = String(v); } });
  return el;
}

const registry = new Map();
function getById(id) {
  if (!ids.has(id)) throw new Error('index.html 中不存在 id="' + id + '"（JS 与 HTML 不一致）');
  if (!registry.has(id)) registry.set(id, mkEl(id, {}));
  return registry.get(id);
}

let optEls = null;
function querySelectorAll(sel) {
  if (sel === '.ty-opt') {
    if (!optEls) optEls = optAttrMaps.map((m) => mkEl(m.id || '', m));
    return optEls;
  }
  if (sel === '.ty-crumb') return [mkEl('', { class: 'ty-crumb' })];
  return [];
}

const doc = {
  readyState: 'complete',
  activeElement: null,
  head: {
    appendChild(script) {
      if (script && script.src) {
        const file = TYPING + '/' + String(script.src).replace(/^\.?\//, '');
        loadedScripts.push(script.src);
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
        if (script.onload) script.onload();
      }
      return script;
    }
  },
  body: mkEl('body', {}),
  documentElement: mkEl('html', {}),
  createElement(t) { const e = mkEl('', {}); e.tagName = t; if (t === 'script') e.src = ''; return e; },
  getElementById: getById,
  querySelector: (sel) => querySelectorAll(sel)[0] || null,
  querySelectorAll,
  addEventListener() {}, removeEventListener() {}
};

const sandbox = {
  window: {},
  document: doc,
  console,
  navigator: { maxTouchPoints: 2, userAgent: 'smoke-test' },   // 触发 isTouchDevice 的移动端路径
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); },
      clear: () => m.clear()
    };
  })(),
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  queueMicrotask,
  _winLis: {},
  addEventListener(t, fn) { (sandbox._winLis[t] = sandbox._winLis[t] || []).push(fn); },
  removeEventListener() {}
};
sandbox.window = sandbox;
/* 关键：环境刻意不提供 AudioContext / webkitAudioContext —— 用于验证「无 AudioContext 不崩」 */
vm.createContext(sandbox);

console.log('# 加载 romaji.js + typing.js');
vm.runInContext(fs.readFileSync(TYPING + '/romaji.js', 'utf8'), sandbox, { filename: 'romaji.js' });
vm.runInContext(fs.readFileSync(TYPING + '/typing.js', 'utf8'), sandbox, { filename: 'typing.js' });

const G = sandbox.TypingGame;
const state = G && G.state;
const R = sandbox.Romaji;
const LS = sandbox.localStorage;

/* 便捷操作 */
const pick = (attr, val) => optEls.find((b) => b.getAttribute(attr) === val);
const click = (id) => getById(id).fire('click', {});
const key = (k) => (sandbox._winLis.keydown || []).forEach((fn) => fn({ key: k, preventDefault() {} }));
function typeReading(word) { for (const ch of R.readings(word.k)[0]) G.handleChar(ch); }

/* ============================================================ */
console.log('\n# A. 初始化 / HTML 一致性 / 隐藏 input 属性');
ok(!!R, 'Romaji 引擎已就绪');
ok(!!G, 'window.TypingGame 已暴露');
ok(typeof G.handleChar === 'function', 'handleChar 唯一字符入口存在');
ok(!!state && state.screen === 'idle', '初始状态 idle');
ok(getById('screen-start').hidden === false, '开始屏可见');
ok(getById('screen-game').hidden === true, '游戏台初始隐藏');
ok(optEls.length === 13, 'index.html 中 .ty-opt 共 13 个（5 档 + 3 模式 + 5 速度）');
ok(optEls.every((b) => b.getAttribute('aria-pressed') !== null), '全部选档按钮均带 aria-pressed');

const inputTag = (html.match(/<input[^>]*id="mobile-input"[^>]*>/) || [''])[0];
ok(
  /inputmode="latin"/.test(inputTag) && /autocapitalize="off"/.test(inputTag) &&
  /autocomplete="off"/.test(inputTag) && /autocorrect="off"/.test(inputTag) &&
  /spellcheck="false"/.test(inputTag) && /aria-hidden="true"/.test(inputTag) &&
  /tabindex="-1"/.test(inputTag),
  '隐藏 input 属性齐全（inputmode/autocapitalize/autocomplete/autocorrect/spellcheck/aria-hidden/tabindex）'
);
ok(getById('quit-modal') && /aria-labelledby="quit-title"/.test(html), '退出弹层 role=dialog 带 aria-labelledby');
ok(/id="sr-status"[^>]*role="status"[^>]*aria-live="polite"/.test(html), 'live region（role=status / aria-live=polite）存在');

console.log('\n# B. Sound 六方法在「无 AudioContext」下安全调用');
const soundNames = ['key', 'collect', 'combo', 'wrong', 'tick', 'over'];
ok(G.Sound && soundNames.every((n) => typeof G.Sound[n] === 'function'), 'Sound 六方法齐备且为函数');
ok(typeof sandbox.AudioContext === 'undefined', '测试环境确实没有 AudioContext（负向前提成立）');
let soundThrew = false;
try { soundNames.forEach((n) => G.Sound[n]()); } catch (e) { soundThrew = true; }
ok(!soundThrew, '无 AudioContext 时六方法全部安全返回、不抛错');
ok(sandbox.window.AudioContext === undefined, '不会因调用而凭空创建 AudioContext');

console.log('\n# C. 音效开关读写 localStorage[jlpt-typing-sound]');
ok(LS.getItem('jlpt-typing-sound') === null, '默认未写入 → 视为「开」');
click('btn-sound');
ok(LS.getItem('jlpt-typing-sound') === '0', '点击开关 → 写入 "0"（关）');
ok(getById('btn-sound').getAttribute('aria-pressed') === 'false', '按钮 aria-pressed=false');
let soundThrew2 = false;
try { soundNames.forEach((n) => G.Sound[n]()); } catch (e) { soundThrew2 = true; }
ok(!soundThrew2, '关闭状态下六方法同样安全调用');
click('btn-sound');
ok(LS.getItem('jlpt-typing-sound') === '1', '再次点击 → 写入 "1"（开）');
ok(getById('btn-sound').getAttribute('aria-pressed') === 'true', '按钮 aria-pressed=true');

console.log('\n# D. 移动端隐藏 input：input 事件经 handleChar 收词');
pick('data-tier', 'n5').fire('click', {});
pick('data-mode', 'practice').fire('click', {});
click('btn-start');
ok(state.screen === 'playing', '开局进入 playing');
ok(getById('mobile-input')._focused === true, '触屏设备开局即 focus 隐藏 input（唤起软键盘）');
const wm = state.current;
const rdm = R.readings(wm.k)[0];
const wordsBefore = state.words;
getById('mobile-input').value = rdm;
getById('mobile-input').fire('input', {});
ok(state.words === wordsBefore + 1, '隐藏 input 的 input 事件 → handleChar 收词（' + wm.k + ' ← ' + rdm + '）');
ok(getById('mobile-input').value === '', '处理后 value 被清空，避免累积');
ok(state.current !== wm, '已流转到下一个词');
/* 失焦后点游戏台重新聚焦 */
getById('mobile-input')._focused = false;
getById('stage').fire('click', {});
ok(getById('mobile-input')._focused === true, '失焦后点游戏台 → 重新聚焦隐藏 input');

console.log('\n# E. 空格修复：聚焦按钮时不吞空格');
const btnAsActive = { tagName: 'BUTTON', getAttribute: () => null };
doc.activeElement = btnAsActive;
let preventedBtn = false;
(sandbox._winLis.keydown || []).forEach((fn) => fn({ key: ' ', preventDefault() { preventedBtn = true; } }));
ok(preventedBtn === false, '焦点在按钮上时，空格不调用 preventDefault（交给浏览器激活按钮）');
doc.activeElement = null;
let preventedNone = false;
(sandbox._winLis.keydown || []).forEach((fn) => fn({ key: ' ', preventDefault() { preventedNone = true; } }));
ok(preventedNone === true, '焦点不在可交互元素时，空格被 preventDefault（阻止滚动）');
/* 上一步「焦点为空按空格」本身就会切换暂停；显式声明进入暂停态，
   再验证「焦点在按钮上时空格不误触暂停切换」。 */
ok(state.screen === 'paused', '焦点为空时按空格 → 切入暂停态（副作用符合预期）');
doc.activeElement = btnAsActive;
(sandbox._winLis.keydown || []).forEach((fn) => fn({ key: ' ', preventDefault() {} }));
ok(state.screen === 'paused', '暂停态下聚焦按钮按空格不误触暂停切换');
doc.activeElement = null;
(sandbox._winLis.keydown || []).forEach((fn) => fn({ key: ' ', preventDefault() {} }));
ok(state.screen === 'playing', '焦点为空时空格可切换暂停（恢复）');

console.log('\n# F. 回归：退出 / 结算 / 最高分 / 三档');
/* 交回 idle */
click('btn-quit'); click('btn-quit-yes');
ok(state.screen === 'idle' && getById('screen-start').hidden === false, '确认退出 → 回到选档屏');

/* 竞技：收词计分 + 错字 −5 断连 + 桌面 keydown 路径 */
pick('data-tier', 'n4').fire('click', {});
pick('data-mode', 'competition').fire('click', {});
click('btn-start');
ok(loadedScripts.includes('data/n4.js'), '按需注入 data/n4.js');
ok(getById('hud-time')._text === '60s', '竞技倒计时初始 60s');
const w1 = state.current; const rd1 = R.readings(w1.k)[0];
for (const ch of rd1) key(ch);          // 全程走桌面 window keydown 路径
ok(state.words >= 1, '桌面 window keydown 路径可收词');
ok(state.current !== w1, '收词后流转下一词');
const s0 = state.score;
G.handleChar('q');
ok(state.score === Math.max(0, s0 - 5) && state.combo === 0, '竞技错字 −5 且断连');

/* 无尽：错字即结束 + 结算渲染 + 最高分落盘 */
click('btn-quit'); click('btn-quit-yes');
pick('data-mode', 'endless').fire('click', {});
pick('data-tier', 'n5').fire('click', {});
click('btn-start');
G.handleChar('q');
ok(state.screen === 'over' && getById('screen-over').hidden === false, '无尽错字 → 结算屏可见');
ok(getById('over-stats')._html.indexOf('分数') >= 0 && getById('over-stats')._html.indexOf('WPM') >= 0, '结算渲染成绩单（分数/正确率/WPM）');
const raw = LS.getItem('jlpt-typing-best');
ok(!!raw, '已写入 jlpt-typing-best');
let best = {};
try { best = JSON.parse(raw || '{}'); } catch (e) {}
ok(best['endless:n5:1'] && typeof best['endless:n5:1'].score === 'number', '按 mode:tier:speed 存 {score,words,wpm,at}');

/* 困难档注入 + 传送带提速 */
click('btn-back');
pick('data-tier', 'n1').fire('click', {});
pick('data-mode', 'practice').fire('click', {});
click('btn-start');
ok(loadedScripts[loadedScripts.length - 1] === 'data/n1.js', '注入 data/n1.js');
ok(state.screen === 'playing' && /^[ぁ-んー]+$/.test(state.current.k), 'N1 档词已就位：' + state.current.k);
ok(/^\d+ms$/.test(getById('typing-app').style.getPropertyValue('--ty-flow-ms')), '传送带单程时长已写入 --ty-flow-ms=' + getById('typing-app').style.getPropertyValue('--ty-flow-ms'));

/* 按词长给时的口径：n 个假名 → clamp(3400 + 1150*(n-1), 4200, 16000) / speed。
   直接调用内核暴露的 flowDurationMs，防回归到「固定时长」。
   决策 23 起签名改为接收**词对象**（默认按 word.k 的假名数计数）。 */
ok(typeof G.flowDurationMs === 'function', 'flowDurationMs 已通过 TypingGame 接缝暴露');
[1, 2, 3, 5, 9, 12].forEach(function (n) {
  state.speed = 1;
  var get = G.flowDurationMs({ k: 'あ'.repeat(n) });
  var want = Math.round(Math.min(16000, Math.max(4200, 3400 + 1150 * (n - 1))) / 1);
  ok(get === want, '词长 ' + n + ' @1x → ' + get + 'ms（期望 ' + want + 'ms）');
});
state.speed = 2;
ok(G.flowDurationMs({ k: 'あああ' }) === 2850, '词长 3 @2x → 2850ms（速度倍率参与缩放）');
state.speed = 0.5;
ok(G.flowDurationMs({ k: 'あ'.repeat(12) }) === 32000, '超长词 @0.5x 不被 16s 上限二次 clamp（上限作用在速度换算前）');
state.speed = 1;
ok(G.flowDurationMs(null) === 4200, 'state.current 为空时退回最小值 4200ms（旧行为逐字一致）');
console.log('\n' + (failed ? 'RESULT: FAIL（' + failed + '/' + total + ' 项失败）' : 'RESULT: ALL PASS（共 ' + total + ' 项断言）'));
process.exit(failed ? 1 : 0);
