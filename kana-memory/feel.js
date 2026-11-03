/* ============================================================================
   假名翻牌 · 手感层（音效 / 键盘 / 朗读 / 减少动效）
   本文件不改 page.js，只走两样既有接缝：
     · KanaApp.on() 的既有事件（round:start / tile:open / tile:match / tile:miss /
       round:end / tier:change）
     · index.html 的既有插槽（#k-sound 开关、#k-live 播报区）
   牌面的 data-state 只由 page.js 的 paint() 写，这里连碰都不碰；配错抖动用的是
   page.js 自己加/摘的 .is-miss。

   为什么接线要等 DOMContentLoaded：ARCH §2 规定脚本顺序是 feel.js → page.js，
   加载这一刻 window.KanaApp 还不存在；page.js 的 boot() 在解析期间跑完，等
   DOMContentLoaded 再接线就一定拿得到它（那时开局的 round:start / tier:change
   也已经发过去了 —— 本层不需要它们）。

   朗读分工（同一个 aria-live 不重复写，否则读屏会把一局念两遍）：
     · #k-live 归 page.js 的 announce()：配对成功 / 配错 / 开局 / 结算那几个整句里
       已经带了「已配对 X / Y」和「第 N 步」，本层不再重复；
     · 本层只补它不管的两种：音效开关，以及换档 / 按 R 重开后的计数器归位。
   ============================================================================ */
(function (root) {
'use strict';

var document = root.document;

var SOUND_KEY = 'jlpt-kana-sound';
var SOUND_OFF = 'off';          // 键只存 'on' / 'off'；没存过按默认「开」算
var REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

var el = {};                    // { sound, live }
var wired = false;
var soundOn = true;
var reduced = null;             // matchMedia 的结果对象
var audio = null;               // AudioContext：第一次真要发声时才创建

/* ---------------------------------------------------------------- 音效 */
/* 四个音全部运行时合成（不引音频文件）：一段振荡器 + 一条增益包络。
   关掉音效时连 AudioContext 都不创建 —— 「关了就没声」是结构上的保证，
   而不是把音量调到 0 之后照旧跑振荡器。 */
function audioContext() {
  if (audio) return audio;
  var Ctor = root.AudioContext || root.webkitAudioContext;
  if (!Ctor) return null;                     // 没有 WebAudio：静默降级，别让页面挂掉
  audio = new Ctor();
  if (audio.state === 'suspended' && audio.resume) audio.resume();
  return audio;
}

function tone(ctx, spec) {
  var at = spec.at === undefined ? ctx.currentTime : spec.at;
  var dur = spec.dur || 0.12;
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();
  osc.type = spec.type || 'sine';
  osc.frequency.setValueAtTime(spec.from, at);
  if (spec.to) osc.frequency.exponentialRampToValueAtTime(spec.to, at + dur);
  /* 起音留 12ms 的爬升、收音回到 0.0001：指数包络不能碰 0，会报错 */
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(spec.peak || 0.05, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/* at 是相对这一次发声起点的秒数 */
var SOUNDS = {
  /* 翻牌：短促下滑，像纸牌从手边落到桌上 */
  flip: [{ type: 'triangle', from: 560, to: 340, dur: 0.09, peak: 0.05 }],
  /* 配对成功：纯五度上行两声 */
  match: [
    { type: 'triangle', from: 660, at: 0, dur: 0.1, peak: 0.06 },
    { type: 'triangle', from: 990, at: 0.09, dur: 0.16, peak: 0.06 }
  ],
  /* 配错：一声低而短的闷响，不该比配对成功更抢耳 */
  miss: [{ type: 'sawtooth', from: 240, to: 150, dur: 0.16, peak: 0.035 }],
  /* 通关：C-E-G-C 琶音 */
  win: [
    { type: 'sine', from: 523.25, at: 0, dur: 0.22, peak: 0.055 },
    { type: 'sine', from: 659.25, at: 0.1, dur: 0.22, peak: 0.055 },
    { type: 'sine', from: 783.99, at: 0.2, dur: 0.22, peak: 0.055 },
    { type: 'sine', from: 1046.5, at: 0.3, dur: 0.34, peak: 0.055 }
  ]
};

function play(name) {
  if (!soundOn) return;
  var parts = SOUNDS[name];
  if (!parts) return;
  var ctx = audioContext();
  if (!ctx) return;
  var base = ctx.currentTime;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    tone(ctx, { type: p.type, from: p.from, to: p.to, at: base + (p.at || 0), dur: p.dur, peak: p.peak });
  }
}

function storedSound() {
  var saved = null;
  try { saved = root.localStorage.getItem(SOUND_KEY); } catch { saved = null; }
  return saved !== SOUND_OFF;
}

function paintSound() {
  if (!el.sound) return;
  el.sound.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  el.sound.textContent = soundOn ? '音效 开' : '音效 关';
}

function setSound(on) {
  soundOn = !!on;
  try {
    root.localStorage.setItem(SOUND_KEY, soundOn ? 'on' : SOUND_OFF);
  } catch { /* 隐私模式写不进去：这一次照玩，只是记不住 */ }
  paintSound();
  if (soundOn) play('match');        // 打开时给一声，让人当场确认真的听得见
  say(soundOn ? '音效已开启' : '音效已关闭');
}

/* ---------------------------------------------------------------- 朗读 */
function say(text) {
  if (!el.live) return;
  el.live.textContent = text;
}

/* ---------------------------------------------------------------- 减少动效 */
/* 位移与翻转时长全在 kana.css 的 --dur / --dur-slow / --shake / --lift 四个令牌里，
   归零即「无位移、即时切换」。媒体查询那条给真实浏览器；这里把同一状态镜像到
   <html data-motion="reduce">，系统设置在页面打开之后被改掉也能跟上。 */
function applyReducedMotion() {
  var html = document.documentElement;
  if (!html) return;
  if (reduced && reduced.matches) html.setAttribute('data-motion', 'reduce');
  else html.removeAttribute('data-motion');
}

/* ---------------------------------------------------------------- 键盘 */
/* Tab 一律不拦（焦点顺序交给浏览器）。Enter / Space 只在焦点落在牌上时接管：
   浏览器对 <button> 的原生激活（Enter 在 keydown、Space 在 keyup）会让牌翻两次，
   所以捕获后 preventDefault 再自己 click() 一次。焦点在音效 / 档位按钮上时不接管，
   那些按钮的原生激活本来就是对的。 */
function focusedTile(evt) {
  var active = document.activeElement;
  if (active && active.classList && active.classList.contains('k-tile')) return active;
  var node = evt && evt.target;
  if (node && node.closest) return node.closest('.k-tile');
  return null;
}

function restart() {
  var App = root.KanaApp;
  if (!App) return;
  App.setTier(App.getState().tier);      // 重开本档：page.js 重建牌墙、计数归零
}

function onKeydown(evt) {
  if (!evt || evt.metaKey || evt.ctrlKey || evt.altKey) return;
  var key = evt.key;
  if (key === 'r' || key === 'R') { restart(); return; }
  if (key !== 'Enter' && key !== ' ') return;
  var tile = focusedTile(evt);
  if (!tile) return;
  evt.preventDefault();
  tile.click();
}

/* ---------------------------------------------------------------- 接线 */
function wire() {
  var App = root.KanaApp;
  if (wired || !App) return;             // page.js 还没跑：留给 DOMContentLoaded 那一次
  wired = true;

  el.sound = document.getElementById('k-sound');
  el.live = document.getElementById('k-live');

  soundOn = storedSound();
  paintSound();
  if (el.sound) {
    el.sound.addEventListener('click', function () { setSound(!soundOn); });
  }

  if (typeof root.matchMedia === 'function') {
    reduced = root.matchMedia(REDUCE_QUERY);
    applyReducedMotion();
    if (reduced && typeof reduced.addEventListener === 'function') {
      reduced.addEventListener('change', applyReducedMotion);
    }
  }

  document.addEventListener('keydown', onKeydown);

  App.on('tile:open', function () { play('flip'); });
  App.on('tile:match', function () { play('match'); });
  App.on('tile:miss', function () { play('miss'); });
  App.on('round:end', function () { play('win'); });

  /* 换档 / 按 R 重开：page.js 只播「新的一局，共 N 张牌」，计数器归位没人说，
     这里补一句（含配对数与步数，是那句话的超集，不重复念） */
  App.on('tier:change', function () {
    var s = App.getState();
    var size = s.round ? s.round.size : s.total * 2;
    say('新的一局，共 ' + size + ' 张牌，已配对 0 / ' + s.total + '，步数 0');
  });
}

document.addEventListener('DOMContentLoaded', wire);
/* 已被动态插入（此时 readyState 已过 loading）时补一次；拿不到 KanaApp 会自己退出 */
if (document.readyState !== 'loading') wire();

})(typeof window !== 'undefined' ? window : globalThis);
