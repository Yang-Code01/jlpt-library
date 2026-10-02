/* ============================================================
   打字练习 · 游戏内核（假名 → 罗马字）
   依赖：romaji.js（全局 Romaji.readings / Romaji.match）
   数据：按难度档以 <script src="data/<档>.js"> 动态注入后读全局变量
         （file:// 下 fetch 不可用，故只能走 <script src> 这条硬约束路径）

   状态机：idle → playing ⇄ paused → over →（返回）idle
   三模式共用同一内核，差异只在「结束条件 / 计时 / 是否可暂停」：
     practice    练习  无时限 · 可暂停 · 错字仅红色反馈不计分 · 词出界不惩罚自动换词
     competition 竞技  60 秒倒计时 · 错字 −5 分且断连 · 词出界不惩罚只是不得分
     endless     无尽  无时限 · 敲错一个字符 或 当前词流出左界（停留过久）即结束

   对外接缝：
     window.TypingGame.handleChar(ch)  —— 「单个字符输入」的唯一入口
                                         （桌面 keydown 与移动端隐藏 input 都走这里）
     window.TypingGame.Sound           —— WebAudio 合成音效（key/collect/combo/
                                         wrong/tick/over），无音频文件依赖
   ============================================================ */
(function () {
'use strict';

/* ------------------------------------------------------------
   ① 常量：难度档 / 模式
   ------------------------------------------------------------ */

/* 最高分存储 key（独立于 assets/progress.js） */
var BEST_KEY = 'jlpt-typing-best';

/* 竞技模式总时长与「最后告警」区间 */
var COMP_MS = 60000;
var COMP_WARN_MS = 3000;
var TICK_MS = 120;

/* 难度档 = JLPT 等级（N5 最易 → N1 最难），每档独立词表。
   传送带单程时长按「假名数」线性缩放，再乘用户自选速度倍率（state.speed，越大越快）。
   固定时长下 1 假名词与 12 假名词拿同样的停留时间，长词在无尽模式里几乎必死、
   短词又过于宽松；按词长给时，难度才落回手速而不是运气。
   CSS 侧通过 --ty-flow-ms 承接实际时长。 */
var FLOW_BASE_MS = 3400;      /* 每个词的基础停留 */
var FLOW_PER_KANA_MS = 1150;  /* 每多一个假名追加的停留 */
var FLOW_MIN_MS = 4200;       /* 单假名词也不会快到底 */
var FLOW_MAX_MS = 16000;      /* 超长词不至于占满整屏时间 */
var SPEED_KEY = 'jlpt-typing-speed';
var SPEEDS = [0.5, 1.0, 1.2, 1.5, 2.0];
var TIERS = {
  n5:   { key: 'n5', label: 'N5', src: 'data/n5.js', global: 'TYPING_WORDS_N5' },
  n4:   { key: 'n4', label: 'N4', src: 'data/n4.js', global: 'TYPING_WORDS_N4' },
  n3:   { key: 'n3', label: 'N3', src: 'data/n3.js', global: 'TYPING_WORDS_N3' },
  n2:   { key: 'n2', label: 'N2', src: 'data/n2.js', global: 'TYPING_WORDS_N2' },
  n1:   { key: 'n1', label: 'N1', src: 'data/n1.js', global: 'TYPING_WORDS_N1' }
};

function loadSpeed() {
  try {
    var v = parseFloat(localStorage.getItem(SPEED_KEY));
    if (SPEEDS.indexOf(v) !== -1) return v;
  } catch (e) {}
  return 1.0;
}

function saveSpeed(v) {
  try { localStorage.setItem(SPEED_KEY, String(v)); } catch (e) {}
}

/* 模式（所有模式均可用 Space 暂停 / 恢复；竞技暂停同时冻结计时） */
var MODES = {
  practice:    { key: 'practice',    label: '练习', limited: false, pausable: true,
                 failOnWrong: false, failOnMiss: false,
                 tip: '无时限 · 错字只做红色反馈、不计分 · 词流出界自动换下一个 · Space 可暂停 / 恢复' },
  competition: { key: 'competition', label: '竞技', limited: true,  pausable: true,
                 failOnWrong: false, failOnMiss: false,
                 tip: '60 秒内尽可能多收词 · 连击每满 10 加 0.5 倍率 · 错字 −5 并断连 · Space 暂停同时冻结计时' },
  endless:     { key: 'endless',     label: '无尽', limited: false, pausable: true,
                 failOnWrong: true,  failOnMiss: true,
                 tip: '敲错一个字符或当前词流出左界即结束 · 比谁走得远 · Space 可暂停' }
};

/* ------------------------------------------------------------
   ② 音效：WebAudio 现场合成（零音频文件）
   - AudioContext 延迟创建（首次真正发声时才 new），避免开局即产生
     被自动播放策略拦截的 suspended 上下文与控制台告警
   - 首次用户交互后 resume()（见 bindAudioUnlock）
   - 开关存 localStorage[jlpt-typing-sound]：'0' 关，其余（缺省）开
   - 触发点：判对→key()；收词→speakWord()（单词发音）；连击满 10→combo()；
            错字→wrong()；竞技最后 3 秒→tick()；结算→over()
   - 六个方法在「无 AudioContext / 无 window / 无 localStorage」的 Node
     环境下均安全返回、不抛错（供 VM 冒烟测试直接调用）
   ------------------------------------------------------------ */
var SOUND_KEY = 'jlpt-typing-sound';

function soundEnabled() {
  try {
    return !(typeof localStorage !== 'undefined' && localStorage.getItem(SOUND_KEY) === '0');
  } catch (e) { return true; }
}

function setSoundEnabled(on) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch (e) {}
}

var audioCtx = null;

/* 惰性取得（或创建）AudioContext；环境不支持时返回 null */
function getAudioCtx() {
  if (typeof window === 'undefined') return null;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
  }
  return audioCtx;
}

/* 首次用户交互解锁音频（浏览器自动播放策略） */
function unlockAudio() {
  var ctx = getAudioCtx();
  if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    try { ctx.resume(); } catch (e) {}
  }
}

/* 现场合成一个音：type 波形 / from 起始频率 / to 终止频率 / dur 时长(s) /
   gain 峰值增益 / delay 起始延迟(s)。任何一步失败都静默忽略。 */
function tone(type, from, to, dur, gain, delay) {
  var ctx = getAudioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(from, t0);
    if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.07, t0 + Math.min(0.012, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  } catch (e) { /* 合成失败静默忽略，不影响游戏 */ }
}

var Sound = {
  /* 极短方波「嗒」 */
  key: function () { if (soundEnabled()) tone('square', 900, 760, 0.028, 0.05); },
  /* 上滑短音：保留备用（收词已改为单词发音 speakWord） */
  collect: function () { if (soundEnabled()) tone('sine', 620, 1240, 0.11, 0.09); },
  /* 明亮双音：连击升级 */
  combo: function () {
    if (!soundEnabled()) return;
    tone('triangle', 880, 880, 0.07, 0.09, 0);
    tone('triangle', 1320, 1320, 0.09, 0.09, 0.08);
  },
  /* 低哑短音：错字 */
  wrong: function () { if (soundEnabled()) tone('sawtooth', 200, 90, 0.16, 0.08); },
  /* 短促滴答：竞技倒数 */
  tick: function () { if (soundEnabled()) tone('square', 1300, 1300, 0.03, 0.05); },
  /* 收束音：结算 */
  over: function () { if (soundEnabled()) tone('sine', 720, 180, 0.5, 0.1); }
};

/* ------------------------------------------------------------
   ②b 单词发音：Web Speech API（speechSynthesis，ja-JP 语音，零音频文件）
   - 收词成功时朗读该词；先 cancel() 上一条，防止连击时语音排队堆积
   - 发音质量取决于系统日语语音（Win10/11、macOS、iOS 均内置）；
     环境不支持或合成失败时静默忽略，不影响游戏
   ------------------------------------------------------------ */
function speakWord(word) {
  if (!soundEnabled()) return;
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    var ss = window.speechSynthesis;
    if (typeof ss.cancel === 'function') ss.cancel();
    var u = new SpeechSynthesisUtterance(word);
    u.lang = 'ja-JP';
    u.rate = 0.9;   // 稍慢，利于跟读
    var voices = (typeof ss.getVoices === 'function') ? ss.getVoices() : [];
    for (var i = 0; i < voices.length; i++) {
      if (/^ja/i.test(voices[i].lang || '')) { u.voice = voices[i]; break; }
    }
    ss.speak(u);
  } catch (e) { /* 不支持 / 合成失败：静默忽略 */ }
}

/* ------------------------------------------------------------
   ③ 运行状态
   ------------------------------------------------------------ */
var state = {
  screen: 'idle',     // idle | playing | paused | over
  mode: 'practice',
  tier: 'n5',
  speed: 1.0,         // 速度倍率（SPEEDS 之一，localStorage 记忆）
  pool: [],           // 当前档完整词表（原始顺序，洗牌时复制）
  queue: [],          // 本轮洗牌后的播放队列
  qi: 0,              // queue 游标
  current: null,      // 当前词 { w, k, m, p }
  typed: '',          // 当前词已输入串
  score: 0,
  combo: 0,
  maxCombo: 0,
  words: 0,           // 收词数
  totalKeys: 0,       // 总输入字符数（正确率分母）
  correctKeys: 0,     // 正确字符数（正确率分子 / WPM 分子）
  startAt: 0,
  endAt: 0,
  pauseTotal: 0,      // 累计暂停时长（ms），计入 WPM / 竞技倒计时
  pausedAt: 0,
  tickId: 0,
  lastWarnSec: -1
};

var el = {};          // DOM 缓存

/* ------------------------------------------------------------
   ④ 工具
   ------------------------------------------------------------ */
function $(id) { return document.getElementById(id); }

function each(list, fn) { for (var i = 0; i < list.length; i++) fn(list[i], i); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 屏幕阅读器播报：全部经 #sr-status 这一个 aria-live 区域输出，避免多处抢读。
   只在「状态真的变化」时播报（新词 / 收词 / 错字 / 连击里程碑 / 结算），
   不逐字符播报，否则读屏会淹没在噪音里。 */
function announce(text) {
  if (!el.srStatus) return;
  var next = text || '';
  /* 文本未变则不动 DOM，避免连续同一个错字把读屏刷成噪音 */
  if (el.srStatus.textContent === next) return;
  el.srStatus.textContent = next;
}

function shuffle(a) {
  var arr = a.slice();
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/* 假名数（长音 ー 与促音 っ 均计入，与 gen-words.js 分档口径一致） */
function kanaCount(k) { return k ? k.length : 0; }

/* ------------------------------------------------------------
   ⑤ 数据注入：按难度档 <script src> 动态插入（file:// 下 fetch 不可用）
   ------------------------------------------------------------ */
function ensureData(tier, done) {
  var spec = TIERS[tier];
  if (window[spec.global] && window[spec.global].length) {
    done(window[spec.global]);
    return;
  }
  var s = document.createElement('script');
  s.src = spec.src;
  s.onload = function () {
    done(window[spec.global] || []);
  };
  s.onerror = function () {
    done([]);
  };
  (document.head || document.body).appendChild(s);
}

/* ------------------------------------------------------------
   ⑥ 传送带渲染
   ------------------------------------------------------------ */

/* 从当前词的全部合法罗马字写法里，挑「与已输入串前缀匹配最长」的那条做展示底稿，
   这样即使玩家用 si 而不是 shi，提示行的高亮也不会错位。 */
function bestHint(kana, typed) {
  var rs = window.Romaji ? window.Romaji.readings(kana) : [];
  if (!rs.length) return { text: '', hit: 0 };
  var best = rs[0], bestN = -1;
  for (var i = 0; i < rs.length; i++) {
    var n = 0;
    while (n < typed.length && n < rs[i].length && typed.charAt(n) === rs[i].charAt(n)) n++;
    if (n > bestN) { bestN = n; best = rs[i]; }
  }
  return { text: best, hit: bestN < 0 ? 0 : bestN };
}

function renderWord() {
  var w = state.current;
  if (!w) return;
  /* 词形为主视觉；含汉字时用 ruby 标假名，纯假名词直接大字显示 */
  var hasKanji = /[㐀-䶿一-龯豈-﫿]/.test(w.w);
  el.word.innerHTML = hasKanji
    ? '<ruby>' + esc(w.w) + '<rt>' + esc(w.k) + '</ruby>'
    : esc(w.w);
  el.mean.textContent = w.p ? (w.m + '（' + w.p + '）') : w.m;
  renderTyped();
}

function renderTyped() {
  if (!state.current) return;
  var hint = bestHint(state.current.k, state.typed);
  el.romaji.innerHTML =
    '<span class="ty-hit">' + esc(hint.text.slice(0, hint.hit)) + '</span>' +
    '<span class="ty-rest">' + esc(hint.text.slice(hint.hit)) + '</span>';
  el.echo.textContent = state.typed;
}

/* 当前词的单程停留时长：按假名数线性缩放，再除以速度倍率。
   例（1.0x）：あ ≈ 4.2s，かな ≈ 7.0s，消费者物价指数 ≈ 16s。 */
function flowDurationMs(kana) {
  var n = kanaCount(kana);
  var ms = FLOW_BASE_MS + FLOW_PER_KANA_MS * Math.max(0, n - 1);
  if (ms < FLOW_MIN_MS) ms = FLOW_MIN_MS;
  if (ms > FLOW_MAX_MS) ms = FLOW_MAX_MS;
  return Math.round(ms / state.speed);
}

/* 重置动画让下一个词重新从右侧流入。
   CSS 里 .ty-card 的 animation 用 var(--ty-flow-ms) 取时长，
   这里改写变量 + 强制回流后重挂动画。 */
function restartFlow() {
  var card = el.card;
  if (!card) return;
  var kana = state.current ? state.current.k : '';
  el.app.style.setProperty('--ty-flow-ms', flowDurationMs(kana) + 'ms');
  card.style.animation = 'none';
  void card.offsetWidth;          // 强制回流，确保动画可重入
  card.style.animation = '';      // 回落样式表里的 ty-flow
}

function stopFlow() {
  if (el.card) el.card.style.animation = 'none';
}

/* 描述当前词，供 live region 使用 */
function describeWord(w) {
  return '题目：' + w.w + '，读音 ' + w.k + '，' + w.m;
}

/* 取下一个词（队列用尽则重新洗牌，避免与上一词紧邻重复）。
   silent=true 时不单独播报，交由调用方合成一条完整消息。 */
function nextWord(silent) {
  if (!state.pool.length) return;
  if (state.qi >= state.queue.length) {
    var last = state.queue[state.queue.length - 1];
    state.queue = shuffle(state.pool);
    if (state.pool.length > 1 && last && state.queue[0] === last) {
      state.queue.push(state.queue.shift());
    }
    state.qi = 0;
  }
  state.current = state.queue[state.qi++];
  state.typed = '';
  renderWord();
  restartFlow();
  if (!silent) announce(describeWord(state.current));
}

/* ------------------------------------------------------------
   ⑦ 输入：唯一入口 handleChar(ch)
   ------------------------------------------------------------ */
function handleChar(ch) {
  if (state.screen !== 'playing' || !state.current) return;
  if (typeof ch !== 'string') return;
  ch = ch.toLowerCase();                    // 宽松：大写字母也接受
  if (!/^[a-z-]$/.test(ch)) return;         // 只接受 a–z 与 -

  state.totalKeys++;
  var cand = state.typed + ch;
  var r = window.Romaji.match(state.current.k, cand);

  if (r.status === 'wrong') {
    onWrongChar();
    return;
  }

  state.typed = cand;
  state.correctKeys++;
  Sound.key();

  if (r.status === 'complete') {
    onWordComplete();
  } else {
    renderTyped();
  }
}

/* 错字反馈：卡片红闪（练习：仅反馈；竞技：−5 / 断连；无尽：结束） */
function onWrongChar() {
  var m = MODES[state.mode];
  Sound.wrong();
  flashWrong();

  if (m.failOnWrong) { endGame('敲错了'); return; }

  if (state.mode === 'competition') {
    state.score = Math.max(0, state.score - 5);
    state.combo = 0;
    updateHud();
    announce('敲错，扣 5 分，连击重置');
    return;
  }
  // 练习：只做红色反馈，不计分、不断连
  announce('敲错了');
}

var flashTimer = 0;
function flashWrong() {
  if (!el.card || !el.card.classList) return;
  el.card.classList.add('ty-wrong');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(function () {
    if (el.card && el.card.classList) el.card.classList.remove('ty-wrong');
  }, 220);
}

/* 收词：基础分 = 假名数 × 10；倍率 = 1 + floor(combo / 10) × 0.5（无上限） */
function onWordComplete() {
  var done = state.current;              // 先留存，nextWord() 会改写 state.current
  state.combo++;
  if (state.combo > state.maxCombo) state.maxCombo = state.combo;
  state.words++;

  var base = kanaCount(done.k) * 10;
  var mult = 1 + Math.floor(state.combo / 10) * 0.5;
  state.score += Math.round(base * mult);

  Sound.collect();
  speakWord(done.w);   // 收词成功：朗读单词
  if (state.combo % 10 === 0) Sound.combo();

  updateHud();
  var comboNow = state.combo;
  var wordsNow = state.words;
  var scoreNow = state.score;
  nextWord(true);   // 静默换词，下面把「收词结果 + 下一题」合成一条播报
  announce('正确 ' + done.w + '，收词 ' + wordsNow + '，得分 ' + scoreNow +
           (comboNow > 0 && comboNow % 10 === 0 ? '，' + comboNow + ' 连击' : '') +
           '。' + describeWord(state.current));
}

/* 当前词流出左界（停留过久） */
function onFlowEnd() {
  if (state.screen !== 'playing') return;
  if (MODES[state.mode].failOnMiss) { endGame('停留过久'); return; }
  nextWord();   // 练习 / 竞技：不惩罚（只是不得分），自动换下一个
}

/* ------------------------------------------------------------
   ⑧ 竞技倒计时
   ------------------------------------------------------------ */
function tick() {
  if (state.screen !== 'playing' || !MODES[state.mode].limited) return;
  var left = COMP_MS - (Date.now() - state.startAt - state.pauseTotal);
  if (left < 0) left = 0;

  var sec = Math.ceil(left / 1000);
  el.time.textContent = sec + 's';
  el.time.classList[sec <= 3 ? 'add' : 'remove']('is-warn');

  if (sec !== state.lastWarnSec) {
    state.lastWarnSec = sec;
    if (left > 0 && left <= COMP_WARN_MS) Sound.tick();   // 最后 3 秒滴答（音效接缝）
  }
  if (left <= 0) endGame('时间到');
}

/* ------------------------------------------------------------
   ⑨ HUD / 屏幕切换
   ------------------------------------------------------------ */
function updateHud() {
  el.hudMode.textContent = MODES[state.mode].label + '·' + TIERS[state.tier].label + '·' + state.speed + 'x';
  el.score.textContent = state.score;
  el.combo.textContent = state.combo;
  el.words.textContent = state.words;
}

function showScreen(name) {
  el.start.hidden = name !== 'start';
  el.game.hidden = name !== 'game';
  el.over.hidden = name !== 'over';
}

function setHint(text, isError) {
  el.startHint.textContent = text || '';
  el.startHint.classList[isError ? 'add' : 'remove']('is-error');
}

/* ------------------------------------------------------------
   ⑩ 开局 / 暂停 / 退出 / 结算
   ------------------------------------------------------------ */
function startGame() {
  if (state.screen === 'playing' || state.screen === 'paused') return;
  /* 在用户手势调用栈内同步聚焦隐藏输入框，才能可靠唤起 iOS 软键盘 */
  if (isTouchDevice()) focusMobileInput();
  setHint('词库加载中…');
  el.btnStart.disabled = true;

  ensureData(state.tier, function (list) {
    el.btnStart.disabled = false;
    if (!list || !list.length) {
      setHint('词库加载失败，请确认 typing/data/' + state.tier + '.js 存在。', true);
      return;
    }
    setHint('');
    resetRun(list);

    showScreen('game');
    state.screen = 'playing';

    el.pausedNote.hidden = true;
    el.stage.classList.remove('ty-paused');
    el.btnPause.textContent = '暂停 · Space';
    el.tip.textContent = MODES[state.mode].tip;
    el.time.classList.remove('is-warn');

    state.startAt = Date.now();
    state.lastWarnSec = -1;
    updateHud();
    updateTimeDisplay();

    if (MODES[state.mode].limited) {
      state.tickId = setInterval(tick, TICK_MS);
    }
    nextWord();
  });
}

function resetRun(pool) {
  state.pool = pool;
  state.queue = [];
  state.qi = 0;
  state.current = null;
  state.typed = '';
  state.score = 0;
  state.combo = 0;
  state.maxCombo = 0;
  state.words = 0;
  state.totalKeys = 0;
  state.correctKeys = 0;
  state.startAt = 0;
  state.endAt = 0;
  state.pauseTotal = 0;
  state.pausedAt = 0;
  state.lastWarnSec = -1;
  if (state.tickId) { clearInterval(state.tickId); state.tickId = 0; }
}

function updateTimeDisplay() {
  el.time.textContent = MODES[state.mode].limited ? Math.ceil(COMP_MS / 1000) + 's' : '∞';
}

function togglePause() {
  if (!MODES[state.mode].pausable) return;
  if (state.screen === 'playing') {
    state.screen = 'paused';
    state.pausedAt = Date.now();
    el.stage.classList.add('ty-paused');   // CSS animation-play-state: paused，冻结词的停留计时
    el.pausedNote.hidden = false;
    el.btnPause.textContent = '继续 · Space';
    announce('已暂停');
  } else if (state.screen === 'paused') {
    state.screen = 'playing';
    state.pauseTotal += Date.now() - state.pausedAt;   // 竞技模式暂停同时冻结计时
    el.stage.classList.remove('ty-paused');
    el.pausedNote.hidden = true;
    el.btnPause.textContent = '暂停 · Space';
    announce('继续');
  }
}

function openQuit() {
  if (state.screen === 'playing' || state.screen === 'paused') el.quitModal.hidden = false;
}

function closeQuit() { el.quitModal.hidden = true; }

function confirmQuit() {
  closeQuit();
  stopFlow();
  if (state.tickId) { clearInterval(state.tickId); state.tickId = 0; }
  state.screen = 'idle';
  state.current = null;
  showScreen('start');
  renderBest();
}

function endGame(reason) {
  if (state.screen !== 'playing' && state.screen !== 'paused') return;
  state.screen = 'over';
  state.endAt = Date.now();
  stopFlow();
  if (state.tickId) { clearInterval(state.tickId); state.tickId = 0; }
  Sound.over();

  var stats = computeStats();
  var rec = saveBest(stats);
  renderOver(reason, stats, rec);
  showScreen('over');
  announce(reason + '。得分 ' + stats.score + '，收词 ' + stats.words +
           '，正确率 ' + Math.round(stats.accuracy * 100) + '%，' + Math.round(stats.wpm) + ' WPM' +
           (rec.isRecord ? '，新纪录' : ''));
}

function computeStats() {
  var ms = Math.max(1, state.endAt - state.startAt - state.pauseTotal);
  var minutes = ms / 60000;
  return {
    score: state.score,
    words: state.words,
    maxCombo: state.maxCombo,
    ms: ms,
    accuracy: state.totalKeys ? state.correctKeys / state.totalKeys : 0,
    wpm: state.correctKeys / 5 / minutes
  };
}

/* ------------------------------------------------------------
   ⑪ 结算渲染 + 最高分（localStorage: jlpt-typing-best，按 mode:tier 存）
   ------------------------------------------------------------ */
function loadBest() {
  try {
    var raw = localStorage.getItem(BEST_KEY);
    var obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
}

function saveBest(s) {
  var all = loadBest();
  var k = state.mode + ':' + state.tier + ':' + state.speed;
  var prev = all[k] || null;
  var isRecord = !prev || s.score > prev.score;
  if (isRecord) {
    all[k] = {
      score: s.score,
      words: s.words,
      wpm: Math.round(s.wpm),
      at: new Date().toISOString()
    };
    try { localStorage.setItem(BEST_KEY, JSON.stringify(all)); } catch (e) {}
  }
  return { isRecord: isRecord, prev: prev, best: all[k] };
}

function fmtDate(iso) {
  return (typeof iso === 'string' && iso.length >= 10) ? iso.slice(0, 10) : '';
}

function renderBest() {
  var rec = loadBest()[state.mode + ':' + state.tier + ':' + state.speed];
  var label = MODES[state.mode].label + '·' + TIERS[state.tier].label + '·' + state.speed + 'x';
  if (!rec) {
    el.bestList.innerHTML = '本档暂无记录（' + esc(label) + '）';
    return;
  }
  el.bestList.innerHTML =
    '本档最高（' + esc(label) + '）：' +
    '<strong>' + rec.score + '</strong> 分 · ' + rec.words + ' 词 · ' + rec.wpm + ' WPM' +
    (fmtDate(rec.at) ? ' · ' + esc(fmtDate(rec.at)) : '');
}

function renderOver(reason, s, rec) {
  el.overTitle.textContent = MODES[state.mode].label + '·' + TIERS[state.tier].label + '·' + state.speed + 'x · ' + reason;
  el.overRecord.hidden = !rec.isRecord;
  el.overRecord.textContent = rec.isRecord ? '新纪录！' : '';

  var rows = [
    ['分数', s.score, true],
    ['收词数', s.words, false],
    ['正确率', Math.round(s.accuracy * 100) + '%', false],
    ['WPM', Math.round(s.wpm) + '（' + state.speed + 'x）', false],
    ['最高连击', s.maxCombo, false],
    ['本档历史最高', rec.best.score + (fmtDate(rec.best.at) ? '（' + fmtDate(rec.best.at) + '）' : ''), false]
  ];

  el.stats.innerHTML = rows.map(function (r) {
    return '<div class="ty-stat' + (r[2] ? ' ty-stat-lead' : '') + '">' +
      '<span class="ty-stat-k">' + esc(r[0]) + '</span>' +
      '<span class="ty-stat-v">' + esc(r[1]) + '</span>' +
      '</div>';
  }).join('');
}

/* ------------------------------------------------------------
   ⑫ 选档交互 / 事件绑定
   ------------------------------------------------------------ */
function applySelection() {
  each(document.querySelectorAll('.ty-opt'), function (btn) {
    var isTier = btn.getAttribute('data-tier');
    var isMode = btn.getAttribute('data-mode');
    var isSpeed = btn.getAttribute('data-speed');
    var on = (isTier && isTier === state.tier) || (isMode && isMode === state.mode) ||
             (isSpeed && parseFloat(isSpeed) === state.speed);
    btn.classList[on ? 'add' : 'remove']('is-active');
    if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/* ------- 音效开关控件 ------- */
function renderSound() {
  if (!el.btnSound) return;
  var on = soundEnabled();
  el.btnSound.textContent = on ? '音效 开' : '音效 关';
  el.btnSound.setAttribute('aria-pressed', on ? 'true' : 'false');
  el.btnSound.setAttribute('aria-label', '音效开关（' + (on ? '开' : '关') + '）');
}

function toggleSound() {
  setSoundEnabled(!soundEnabled());
  renderSound();
  if (soundEnabled()) Sound.key();   // 打开时给一声反馈
}

/* ------- 移动端隐藏输入框 ------- */
/* 粗略判定触屏设备：命中任一即认为需要唤起软键盘 */
function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  try {
    if ('ontouchstart' in window) return true;
    if (window.navigator && window.navigator.maxTouchPoints > 0) return true;
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
  } catch (e) {}
  return false;
}

function focusMobileInput() {
  if (!el.mobileInput) return;
  unlockAudio();                     // 聚焦动作同样属于用户交互，顺便解锁音频
  try {
    el.mobileInput.focus({ preventScroll: true });
  } catch (e) {
    try { el.mobileInput.focus(); } catch (e2) {}
  }
}

/* 读取隐藏输入框的新增内容并逐字符路由到唯一入口 handleChar，随后清空，
   避免字符累积或同一输入被重复处理。 */
function routeMobileValue() {
  if (!el.mobileInput) return;
  var v = el.mobileInput.value;
  el.mobileInput.value = '';
  if (!v) return;
  for (var i = 0; i < v.length; i++) handleChar(v.charAt(i));
}

/* 当前焦点是否落在「浏览器原生会用空格/回车激活」的可交互元素上。
   用于把空格让给按钮 / 链接，保证纯键盘用户能 Tab 到控件并用空格操作。 */
/* 鼠标 / 触控点击控件后主动失焦，避免随后的 Space 被控件吞掉；
   仅 pointerdown（真实指针）触发标记，键盘 Enter/Space 激活不受影响。 */
function blurOnPointerClick(node) {
  node.addEventListener('pointerdown', function () { node._mc = true; });
  node.addEventListener('click', function () {
    if (node._mc) { node._mc = false; try { node.blur(); } catch (e) {} }
  });
}

function isInteractiveTarget(node) {
  if (!node) return false;
  var tag = node.tagName ? String(node.tagName).toLowerCase() : '';
  if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (typeof node.getAttribute === 'function') {
    var role = node.getAttribute('role');
    if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') return true;
    if (node.getAttribute('href') !== null) return true;
  }
  return false;
}

function onKeyDown(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
  /* 隐藏输入框自身的按键由移动端路由处理，避免与 input 事件重复计字符 */
  if (el.mobileInput && e.target === el.mobileInput) return;

  if (e.key === 'Escape') {
    if (state.screen === 'playing' || state.screen === 'paused') {
      if (el.quitModal.hidden) openQuit(); else closeQuit();
    }
    return;
  }

  if (e.key === ' ') {
    /* 焦点在按钮 / 链接上（如 Tab 聚焦）时，空格归它们（激活）；
       鼠标点击后控件已 blur，空格走全局：开始 / 暂停 / 恢复 / 再来一局 */
    var focusEl = (typeof document !== 'undefined') ? document.activeElement : null;
    if (isInteractiveTarget(focusEl)) return;
    e.preventDefault();                       // 否则阻止页面滚动
    if (state.screen === 'idle') { startGame(); return; }
    if (state.screen === 'over') { startGame(); return; }
    if (state.screen === 'playing' || state.screen === 'paused') { togglePause(); return; }
    return;
  }

  if (typeof e.key !== 'string' || e.key.length !== 1) return;
  var ch = e.key.toLowerCase();
  if (ch >= 'a' && ch <= 'z') { handleChar(ch); return; }
  if (ch === '-') handleChar('-');
}

function cacheDom() {
  el.app = $('typing-app');
  el.srStatus = $('sr-status');

  el.start = $('screen-start');
  el.game = $('screen-game');
  el.over = $('screen-over');

  el.bestList = $('best-list');
  el.btnStart = $('btn-start');
  el.startHint = $('start-hint');

  el.hudMode = $('hud-mode');
  el.time = $('hud-time');
  el.words = $('hud-words');
  el.combo = $('hud-combo');
  el.score = $('hud-score');
  el.btnPause = $('btn-pause');
  el.btnQuit = $('btn-quit');
  el.btnSound = $('btn-sound');
  el.mobileInput = $('mobile-input');

  el.stage = $('stage');
  el.card = $('card');
  el.word = $('ln-word');
  el.romaji = $('ln-romaji');
  el.echo = $('ln-echo');
  el.mean = $('ln-mean');
  el.pausedNote = $('paused-note');
  el.tip = $('game-tip');

  el.overTitle = $('over-title');
  el.overRecord = $('over-record');
  el.stats = $('over-stats');
  el.btnAgain = $('btn-again');
  el.btnBack = $('btn-back');

  el.quitModal = $('quit-modal');
  el.btnQuitYes = $('btn-quit-yes');
  el.btnQuitNo = $('btn-quit-no');
  el.crumbBack = $('crumb-back');
}

function bindEvents() {
  each(document.querySelectorAll('.ty-opt'), function (btn) {
    btn.addEventListener('click', function () {
      var t = btn.getAttribute('data-tier');
      var m = btn.getAttribute('data-mode');
      var sp = btn.getAttribute('data-speed');
      if (t) state.tier = t;
      if (m) state.mode = m;
      if (sp) { state.speed = parseFloat(sp); saveSpeed(state.speed); }
      applySelection();
      renderBest();
    });
  });

  el.btnStart.addEventListener('click', startGame);
  el.btnPause.addEventListener('click', togglePause);
  el.btnQuit.addEventListener('click', openQuit);
  el.btnQuitYes.addEventListener('click', confirmQuit);
  el.btnQuitNo.addEventListener('click', closeQuit);
  el.btnSound.addEventListener('click', toggleSound);
  el.btnAgain.addEventListener('click', startGame);
  el.btnBack.addEventListener('click', function () {
    state.screen = 'idle';
    showScreen('start');
    renderBest();
  });

  /* 面包屑「打字练习」：游戏中触发退出确认，结算 / 空闲时直接回选档屏 */
  if (el.crumbBack) {
    el.crumbBack.addEventListener('click', function (e) {
      e.preventDefault();
      if (state.screen === 'playing' || state.screen === 'paused') { openQuit(); return; }
      state.screen = 'idle';
      stopFlow();
      showScreen('start');
      renderBest();
    });
  }

  /* 所有按钮 / 链接：鼠标点击后 blur，Space 才能全局生效 */
  each(document.querySelectorAll('.ty-btn, .ty-opt, .ty-crumb a'), function (btn) {
    blurOnPointerClick(btn);
  });

  /* 移动端隐藏输入框：input 事件是字符的唯一来源（虚拟 / 物理键盘都会触发）；
     keydown 仅用于阻止冒泡到 window（否则同一按键会被两条路径重复计数）并保留 Esc。 */
  if (el.mobileInput) {
    el.mobileInput.addEventListener('input', routeMobileValue);
    el.mobileInput.addEventListener('keydown', function (e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (e && e.key === 'Escape' && (state.screen === 'playing' || state.screen === 'paused')) {
        if (el.quitModal.hidden) openQuit(); else closeQuit();
      }
    });
  }

  /* 失焦后点游戏台重新唤起软键盘 */
  el.stage.addEventListener('click', function () {
    if (state.screen === 'playing' && isTouchDevice()) focusMobileInput();
  });

  /* 词流出左界 = 动画跑完 */
  el.card.addEventListener('animationend', function (e) {
    if (!e || !e.animationName || e.animationName.indexOf('ty-flow') !== 0) return;
    onFlowEnd();
  });

  window.addEventListener('keydown', onKeyDown);
  bindAudioUnlock();
}

/* 首次用户交互后解锁 AudioContext（自动播放策略） */
function bindAudioUnlock() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('touchstart', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
}

function init() {
  cacheDom();
  if (!window.Romaji) {
    setHint('罗马字引擎（romaji.js）未加载，页面无法运行。', true);
    return;
  }
  state.tier = 'n5';
  state.speed = loadSpeed();
  state.mode = 'practice';
  bindEvents();
  applySelection();
  renderSound();
  renderBest();
  showScreen('start');
}

/* ------------------------------------------------------------
   ⑬ 对外接缝（#4 音效 / 移动端隐藏 input 复用）
   ------------------------------------------------------------ */
window.TypingGame = {
  handleChar: handleChar,   // 「单个字符输入」唯一入口：只传一个小写字母或 '-'
  Sound: Sound,             // 音效挂载点：填充 key/collect/combo/wrong/tick/over
  state: state,             // 只读用途为主（测试 / 调试）
  start: startGame,
  flowDurationMs: flowDurationMs   // 暴露给测试：断言按词长给时的口径
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
