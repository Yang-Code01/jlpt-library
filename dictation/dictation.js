/* ============================================================
   听写练习 · 核心逻辑
   规则（对齐参考站）：答错后拼写正确再进入下一词。
   - 左栏：本次练习统计（已完成 / 错误次数）＋ 本词结果 ＋ 本地错词本
   - 右栏：词表页签 ＋ 圆形播放键 ＋ 中文释义 ＋ 输入  提交
   - 错词写入本地错词本（localStorage），复习答对即移除
   数据：window.DICTATION_LISTS（words-data.js）
   ============================================================ */

(function () {
'use strict';

var $ = function (id) { return document.getElementById(id); };

/* ===== DOM ===== */
var viewLists = $('viewLists'), viewPractice = $('viewPractice');
var listGrid = $('listGrid');
var hdrTitle = $('hdrTitle'), hdrSub = $('hdrSub');
var sideStatus = $('sideStatus'), sideListName = $('sideListName');
var statDone = $('statDone'), statErr = $('statErr');
var wordResult = $('wordResult');
var btnReview = $('btnReview'), wbBadge = $('wbBadge');
var listPill = $('listPill'), mainTitle = $('mainTitle');
var cntNow = $('cntNow'), cntTotal = $('cntTotal');
var listTabs = $('listTabs');
var mainBody = $('mainBody');
var fbLine = $('fbLine');
var footRemain = $('footRemain'), footFill = $('footFill');
var settingsDialog = $('settingsDialog'), wordListDialog = $('wordListDialog');

/* 练习区元素（mainBody 重渲染后会重建，用查询函数取） */
function q(sel) { return mainBody.querySelector(sel); }

/* ===== 存储 ===== */
var SETTINGS_KEY = 'dictation-settings';
var PROGRESS_KEY = 'dictation-progress-v2';   // { listId: { keys: [], err: n } }
var WRONGBOOK_KEY = 'dictation-wrongbook';    // [{ w, k, m, p }]

var settings = Object.assign({
  speed: 0.9, repeats: 2, gap: 0.8,
  showHint: true,          // 默认显示中文释义
  acceptMode: 'both',      // both | kana | kanji
  orderMode: 'seq',        // seq | shuffle
  engine: 'browser',       // browser | voicevox | azure
  vvUrl: 'http://127.0.0.1:50021',
  vvSpeaker: null,
  azKey: '',
  azRegion: 'japaneast',
  azVoice: 'ja-JP-NanamiNeural'
}, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));

var progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
var wrongBook = JSON.parse(localStorage.getItem(WRONGBOOK_KEY) || '[]');

function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function saveProgress() { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); }
function saveWrongBook() { localStorage.setItem(WRONGBOOK_KEY, JSON.stringify(wrongBook)); }

function listProg(id) {
  if (!progress[id]) progress[id] = { keys: [], err: 0 };
  return progress[id];
}

/* ===== 会话状态 ===== */
var session = null;
/* { mode:'list'|'review', listId, list, queue:[], idx, done, err,
     wordErr:0(本词错误次数), locked:false, finished:false } */

/* ===== 音频引擎 =====
   三选一：browser（Web Speech）/ voicevox（本地引擎）/ azure（云端 Neural TTS）。
   voicevox 与 azure 的合成结果按「引擎+音色+语速+文本」缓存为 blob URL，重播不重复合成。
   任一引擎失败自动回退 browser，保证练习不中断。                              */
var jpVoice = null;
function loadVoices() {
  var vs = speechSynthesis.getVoices();
  jpVoice = vs.find(function (v) { return v.lang === 'ja-JP'; })
         || vs.find(function (v) { return v.lang && v.lang.indexOf('ja') === 0; })
         || null;
}
if (typeof speechSynthesis !== 'undefined') {
  if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

var playTimer = null;
var currentAudio = null;   // 当前 HTMLAudio（voicevox / azure）
var clipCache = {};        // cacheKey -> blobUrl
var azSdkPromise = null;

function engineLabel() {
  if (settings.engine === 'voicevox') return 'VOICEVOX';
  if (settings.engine === 'azure') return 'Azure';
  return '浏览器语音';
}

function stopPlayback() {
  clearTimeout(playTimer);
  try { speechSynthesis.cancel(); } catch (e) {}
  if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
}

function clipKey(text) {
  var voice = settings.engine === 'voicevox' ? (settings.vvUrl + '#' + settings.vvSpeaker)
            : settings.engine === 'azure' ? (settings.azVoice + '@' + settings.azRegion)
            : 'web';
  return settings.engine + '|' + voice + '|' + settings.speed + '|' + text;
}

/* --- 浏览器 TTS --- */
function speakBrowser(text, onEnd) {
  var u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  if (jpVoice) u.voice = jpVoice;
  u.rate = settings.speed;
  if (onEnd) { u.onend = onEnd; u.onerror = onEnd; }
  speechSynthesis.speak(u);
}

/* --- VOICEVOX：audio_query → synthesis --- */
function vvSynthesize(text) {
  var base = settings.vvUrl.replace(/\/+$/, '');
  var sp = settings.vvSpeaker == null ? 0 : settings.vvSpeaker;
  return fetch(base + '/audio_query?text=' + encodeURIComponent(text) + '&speaker=' + sp, { method: 'POST' })
    .then(function (r) { if (!r.ok) throw new Error('audio_query ' + r.status); return r.json(); })
    .then(function (q) {
      q.speedScale = settings.speed;
      return fetch(base + '/synthesis?speaker=' + sp, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(q)
      });
    })
    .then(function (r) { if (!r.ok) throw new Error('synthesis ' + r.status); return r.blob(); })
    .then(function (b) { return URL.createObjectURL(b); });
}

/* --- Azure AI Speech：浏览器 SDK（npmmirror 优先，unpkg 兜底） --- */
var AZ_CDNS = [
  'https://registry.npmmirror.com/microsoft-cognitiveservices-speech-sdk/latest/files/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle.js',
  'https://unpkg.com/microsoft-cognitiveservices-speech-sdk/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle.js'
];
function loadAzSdk() {
  if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
  if (azSdkPromise) return azSdkPromise;
  azSdkPromise = new Promise(function (resolve, reject) {
    var i = 0;
    (function tryNext() {
      if (i >= AZ_CDNS.length) { reject(new Error('SDK 加载失败')); return; }
      var s = document.createElement('script');
      s.src = AZ_CDNS[i++];
      s.onload = function () { window.SpeechSDK ? resolve(window.SpeechSDK) : reject(new Error('SDK 无效')); };
      s.onerror = function () { s.remove(); tryNext(); };
      document.head.appendChild(s);
    })();
  });
  return azSdkPromise;
}
function azSynthesize(text) {
  return loadAzSdk().then(function (SDK) {
    return new Promise(function (resolve, reject) {
      try {
        if (!settings.azKey) { reject(new Error('未填写 Key')); return; }
        var cfg = SDK.SpeechConfig.fromSubscription(settings.azKey, settings.azRegion);
        cfg.speechSynthesisOutputFormat = SDK.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
        var pct = Math.round((settings.speed - 1) * 100);
        var rate = (pct >= 0 ? '+' : '') + pct + '%';
        var ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP">'
          + '<voice name="' + esc(settings.azVoice) + '"><prosody rate="' + rate + '">'
          + esc(text) + '</prosody></voice></speak>';
        var syn = new SDK.SpeechSynthesizer(cfg);
        syn.speakSsmlAsync(ssml,
          function (r) {
            var data = r.audioData;
            syn.close();
            if (!data || data.byteLength === 0) { reject(new Error(r.errorDetails || '无音频数据')); return; }
            resolve(URL.createObjectURL(new Blob([data], { type: 'audio/wav' })));
          },
          function (err) { syn.close(); reject(new Error(String(err))); });
      } catch (e) { reject(e); }
    });
  });
}

/* --- 统一播放：缓存 → 合成 → 连播 --- */
function playClip(text, timesLeft) {
  if (settings.engine === 'browser') {
    setPlayStatus('播放中 · 浏览器语音 · ' + settings.speed.toFixed(1) + '×');
    speakBrowser(text, function () { repeatNext(text, timesLeft - 1); });
    return;
  }
  var key = clipKey(text);
  if (clipCache[key]) { playUrl(clipCache[key], text, timesLeft); return; }
  setPlayStatus('合成中 · ' + engineLabel() + '…');
  var synth = settings.engine === 'voicevox' ? vvSynthesize(text) : azSynthesize(text);
  synth.then(function (url) {
    clipCache[key] = url;
    playUrl(url, text, timesLeft);
  }).catch(function (err) {
    setPlayStatus(engineLabel() + ' 失败（' + err.message + '）· 已回退浏览器语音');
    speakBrowser(text, function () { repeatNext(text, timesLeft - 1); });
  });
}
function playUrl(url, text, timesLeft) {
  var a = new Audio(url);
  currentAudio = a;
  setPlayStatus('播放中 · ' + engineLabel() + ' · ' + settings.speed.toFixed(1) + '×');
  var done = function () { currentAudio = null; repeatNext(text, timesLeft - 1); };
  a.onended = done;
  a.onerror = done;
  a.play().catch(done);
}
function repeatNext(text, remain) {
  if (remain > 0) {
    playTimer = setTimeout(function () { playClip(text, remain); }, settings.gap * 1000);
  } else {
    var b = mainBody.querySelector('#btnPlay');
    if (b) b.disabled = false;
    setPlayStatus('已播放 ' + settings.repeats + ' 次 · ' + engineLabel() + ' · ' + settings.speed.toFixed(1) + '×');
  }
}
function setPlayStatus(t) {
  var el = mainBody.querySelector('#playStatus');
  if (el) el.textContent = t;
}

function playWord(timesLeft) {
  if (!session || session.finished) return;
  var item = session.queue[session.idx];
  if (!item) return;
  if (timesLeft === undefined) timesLeft = settings.repeats;
  stopPlayback();               // 干净地重新开始
  var b = mainBody.querySelector('#btnPlay');
  if (b) b.disabled = true;
  playClip(item.s || item.w, timesLeft);
}

/* ===== 工具 ===== */
function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shuffle(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function norm(s) { return (s || '').replace(/[\s\u3000]/g, '').replace(/〜/g, '').replace(/～/g, ''); }
function wordKey(w) { return norm(w.w) + '|' + norm(w.k); }

function checkAnswer(input, item) {
  var n = norm(input);
  if (!n) return false;
  if (settings.acceptMode === 'kana') return n === norm(item.k);
  if (settings.acceptMode === 'kanji') return n === norm(item.w);
  return n === norm(item.w) || n === norm(item.k);
}

/* ===== 错词本 ===== */
function wbAdd(item) {
  var k = wordKey(item);
  if (!wrongBook.some(function (x) { return wordKey(x) === k; })) {
    wrongBook.push({ w: item.w, k: item.k, m: item.m, p: item.p });
    saveWrongBook();
  }
  updateWbBadge();
}
function wbRemove(item) {
  var k = wordKey(item);
  var before = wrongBook.length;
  wrongBook = wrongBook.filter(function (x) { return wordKey(x) !== k; });
  if (wrongBook.length !== before) saveWrongBook();
  updateWbBadge();
}
function updateWbBadge() {
  wbBadge.textContent = wrongBook.length;
  wbBadge.className = 'wb-badge' + (wrongBook.length === 0 ? ' is-zero' : '');
  btnReview.disabled = wrongBook.length === 0;
}

/* ===== 视图：词单 ===== */
function renderLists() {
  var groups = {};
  window.DICTATION_LISTS.forEach(function (l) {
    (groups[l.group] = groups[l.group] || []).push(l);
  });
  var html = '';
  Object.keys(groups).forEach(function (g) {
    html += '<div class="list-group"><h3 class="list-group-title">' + esc(g) + '</h3><div class="list-grid">';
    groups[g].forEach(function (l) {
      var p = listProg(l.id);
      var done = Math.min(p.keys.length, l.words.length);
      html += '<button class="list-card" data-id="' + l.id + '" style="--lv-c: var(' + l.color + ')">'
        + '<span class="lc-badge">' + esc(g) + '</span>'
        + '<div class="lc-title">' + esc(l.title) + '</div>'
        + '<p class="lc-desc">' + esc(l.desc || '') + '</p>'
        + '<div class="lc-count">' + l.words.length + ' 词'
        + (done > 0 ? ' · <span class="done">已练 ' + done + '</span>' : '')
        + (p.err > 0 ? ' · 错 ' + p.err + ' 次' : '')
        + '</div></button>';
    });
    html += '</div></div>';
  });
  listGrid.innerHTML = html;
  listGrid.querySelectorAll('.list-card').forEach(function (b) {
    b.addEventListener('click', function () {
      var l = window.DICTATION_LISTS.find(function (x) { return x.id === b.dataset.id; });
      if (l) startList(l);
    });
  });
}

/* ===== 开始 / 切换 ===== */
function startList(list) {
  var p = listProg(list.id);
  var doneSet = {};
  p.keys.forEach(function (k) { doneSet[k] = true; });
  var rest = list.words.filter(function (w) { return !doneSet[wordKey(w)]; });
  var queue = rest.length > 0 ? rest.slice() : list.words.slice();  // 全练完则整表重练
  if (settings.orderMode === 'shuffle') shuffle(queue);

  session = {
    mode: 'list', listId: list.id, list: list,
    queue: queue, idx: 0, done: 0, err: 0, wordErr: 0,
    locked: false, finished: false
  };
  enterPractice();
}

function startReview() {
  if (wrongBook.length === 0) return;
  var queue = wrongBook.slice();
  if (settings.orderMode === 'shuffle') shuffle(queue);
  session = {
    mode: 'review', listId: null, list: null,
    queue: queue, idx: 0, done: 0, err: 0, wordErr: 0,
    locked: false, finished: false
  };
  enterPractice();
}

function enterPractice() {
  viewLists.style.display = 'none';
  viewPractice.style.display = '';
  renderChrome();
  renderTabs();
  renderBody();
  loadWord();
}

function backToLists() {
  stopPlayback();
  session = null;
  viewPractice.style.display = 'none';
  viewLists.style.display = '';
  renderLists();
}

/* ===== 头部 / 侧栏 / 页签 ===== */
function renderChrome() {
  var s = session;
  if (s.mode === 'review') {
    hdrTitle.textContent = '本地错词复习';
    hdrSub.textContent = wrongBook.length + ' 个错词 · 答对即从错词本移除';
    mainTitle.textContent = '本地错词复习';
    listPill.textContent = '错词本';
    sideListName.textContent = '错词本 · 本次 ' + s.queue.length + ' 词';
  } else {
    hdrTitle.textContent = '日语单词听写';
    hdrSub.textContent = s.list.title + ' · 答错后拼写正确再进入下一词';
    mainTitle.textContent = s.list.title;
    var group = window.DICTATION_LISTS.filter(function (l) { return l.group === s.list.group; });
    var gi = group.findIndex(function (l) { return l.id === s.list.id; });
    listPill.textContent = 'List ' + (gi + 1) + ' / ' + group.length;
    sideListName.textContent = s.list.title + ' · 独立进度';
  }
  updateSide();
}

function updateSide() {
  var s = session;
  statDone.textContent = s.done;
  statErr.textContent = s.err;
  sideStatus.textContent = s.finished ? '已完成' : '进行中';
  sideStatus.className = 'pill pill-run' + (s.finished ? ' is-done' : '');
}

function renderTabs() {
  if (session.mode === 'review') { listTabs.innerHTML = ''; return; }
  var group = window.DICTATION_LISTS.filter(function (l) { return l.group === session.list.group; });
  var html = '';
  group.forEach(function (l) {
    var p = listProg(l.id);
    var done = Math.min(p.keys.length, l.words.length);
    var isDone = done >= l.words.length;
    var cls = 'ltab' + (l.id === session.listId ? ' is-cur' : '') + (isDone ? ' is-done' : '');
    html += '<button class="' + cls + '" data-id="' + l.id + '">'
      + '<span class="dot"></span>' + esc(l.title)
      + '<span class="tn">' + done + '/' + l.words.length + (isDone ? ' ✓' : '') + '</span>'
      + '</button>';
  });
  listTabs.innerHTML = html;
  listTabs.querySelectorAll('.ltab').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.id === session.listId) return;
      var l = window.DICTATION_LISTS.find(function (x) { return x.id === b.dataset.id; });
      if (l) startList(l);
    });
  });
}

/* ===== 练习区渲染 ===== */
function renderBody() {
  mainBody.innerHTML =
    '<div class="play-row">'
    + '<button class="play-circle" id="btnPlay" title="播放当前单词 (Tab)">'
    + '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12z"/><path d="M14 3.8v2.06a6.5 6.5 0 0 1 0 12.28v2.06a8.5 8.5 0 0 0 0-16.4z"/></svg>'
    + '</button>'
    + '<div class="play-meta"><b>播放当前单词</b><span id="playStatus">未播放</span></div>'
    + '</div>'
    + '<div class="meaning-box" id="meaningBox"><span class="mb-label">中文释义</span><span class="mb-text" id="meaningText">—</span></div>'
    + '<label class="input-label" for="answerInput">输入听到的单词</label>'
    + '<input type="text" id="answerInput" class="answer-input" placeholder="在这里输入答案" autocomplete="off" spellcheck="false">'
    + '<div class="action-row"><button class="btn-hint" id="btnHint">提示</button><button class="btn-submit" id="btnSubmit">提交答案</button></div>'
    + '<p class="kbd-hints"><kbd>Tab</kbd> 重播当前单词 <kbd>Enter</kbd> 提交答案</p>'
    + '<p class="fb-line" id="fbLine"></p>';

  // 重新绑定（元素已重建）
  mainBody.querySelector('#btnPlay').addEventListener('click', function () {
    if (!session.locked) playWord();
  });
  mainBody.querySelector('#btnHint').addEventListener('click', toggleHint);
  mainBody.querySelector('#btnSubmit').addEventListener('click', function () {
    if (session && session.locked) advance(); else submitAnswer();
  });
  var inp = mainBody.querySelector('#answerInput');
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();   // 阻止冒泡到 document，否则同一次回车会先提交、又被判定为"已答对"而立即跳题
      submitAnswer();
    }
  });
}

function renderDone() {
  var s = session;
  var acc = s.done + s.err === 0 ? 100 : Math.round(s.done / (s.done + s.err) * 100);
  mainBody.innerHTML =
    '<div class="done-block">'
    + '<div class="db-ico">🎉</div>'
    + '<h3>' + (s.mode === 'review' ? '错词复习完成' : '本组练习完成') + '</h3>'
    + '<p>完成 ' + s.done + ' 词 · 错误 ' + s.err + ' 次' + (s.err > 0 ? ' · 本次正确率 ' + acc + '%' : ' · 全对！') + '</p>'
    + '<div class="done-actions">'
    + (wrongBook.length > 0 ? '<button class="hdr-btn back" id="dbReview">复习本地错词（' + wrongBook.length + '）</button>' : '')
    + (s.mode === 'list' ? '<button class="hdr-btn" id="dbAgain">再练一遍本表</button>' : '')
    + '<button class="hdr-btn" id="dbBack">← 返回词单</button>'
    + '</div></div>';
  var b1 = $('dbReview'), b2 = $('dbAgain'), b3 = $('dbBack');
  if (b1) b1.addEventListener('click', startReview);
  if (b2) b2.addEventListener('click', function () { startList(session.list); });
  b3.addEventListener('click', backToLists);
  footRemain.textContent = '还剩 0 个词';
  footFill.style.width = '100%';
  cntNow.textContent = s.queue.length;
}

/* ===== 当前词 ===== */
function loadWord() {
  var s = session;
  if (s.idx >= s.queue.length) {
    s.finished = true;
    updateSide();
    renderDone();
    return;
  }
  s.wordErr = 0;
  s.locked = false;
  var item = s.queue[s.idx];

  renderBody();
  setPlayStatus('未播放 · ' + engineLabel() + ' · ' + settings.speed.toFixed(1) + '×');
  var mb = mainBody.querySelector('#meaningBox');
  var mt = mainBody.querySelector('#meaningText');
  mt.textContent = item.m || '—';
  mb.className = 'meaning-box' + (settings.showHint ? '' : ' is-hidden');

  cntNow.textContent = s.idx + 1;
  cntTotal.textContent = s.queue.length;
  footRemain.textContent = '还剩 ' + (s.queue.length - s.idx) + ' 个词';
  footFill.style.width = (s.idx / s.queue.length * 100) + '%';

  wordResult.innerHTML = '<p class="wr-empty">提交答案后在此显示本词结果</p>';
  updateSide();

  mainBody.querySelector('#answerInput').focus();
  setTimeout(function () { if (session === s && !s.finished) playWord(); }, 250);
}

function toggleHint() {
  var mb = mainBody.querySelector('#meaningBox');
  if (!mb) return;
  mb.classList.toggle('is-hidden');
}

/* ===== 提交 ===== */
function submitAnswer() {
  var s = session;
  if (!s || s.finished || s.locked) return;
  var inp = mainBody.querySelector('#answerInput');
  var fb = mainBody.querySelector('#fbLine');
  var input = inp.value.trim();
  if (!input) { inp.focus(); return; }

  var item = s.queue[s.idx];
  var ok = checkAnswer(input, item);

  if (ok) {
    /* --- 正确：记录、展示本词结果、等 Enter 进入下一词 --- */
    s.locked = true;
    s.done++;
    inp.disabled = true;
    inp.className = 'answer-input is-ok';
    fb.textContent = (s.wordErr > 0 ? '纠错通过' : '正确') + '！按 Enter 进入下一词';
    fb.className = 'fb-line ok';

    if (s.mode === 'list') {
      var p = listProg(s.listId);
      var k = wordKey(item);
      if (p.keys.indexOf(k) < 0) { p.keys.push(k); saveProgress(); }
    }
    wbRemove(item);

    wordResult.innerHTML =
      '<p class="wr-word">' + esc(item.w) + '</p>'
      + '<p class="wr-kana">' + esc(item.k) + '</p>'
      + '<p class="wr-meaning">' + esc(item.m) + '</p>'
      + '<span class="wr-badge ok">' + (s.wordErr > 0 ? '纠错通过' : '一次通过') + '</span>';

    /* 提交键变为"下一词"，键位提示同步更新 */
    mainBody.querySelector('#btnSubmit').textContent = '下一词 →';
    var hb = mainBody.querySelector('#btnHint');
    if (hb) hb.disabled = true;
    var kh = mainBody.querySelector('.kbd-hints');
    if (kh) kh.innerHTML = '<kbd>Enter</kbd> 进入下一词';

    updateSide();
    renderTabs();

  } else {
    /* --- 错误：直接显示正确答案，输入框保持可写，照写一遍再提交 --- */
    s.err++;
    s.wordErr++;
    inp.className = 'answer-input is-err';
    fb.textContent = '拼写错误 · 正确答案：' + item.w + '（' + item.k + '）';
    fb.className = 'fb-line err';

    if (s.mode === 'list') { listProg(s.listId).err++; saveProgress(); }
    wbAdd(item);

    wordResult.innerHTML =
      '<p class="wr-yours">你的输入：' + esc(input) + '</p>'
      + '<p class="wr-word">' + esc(item.w) + '</p>'
      + '<p class="wr-kana">' + esc(item.k) + '</p>'
      + '<p class="wr-meaning">' + esc(item.m) + '</p>'
      + '<span class="wr-badge err">错误 ' + s.wordErr + ' 次 · 请照写一遍</span>';

    updateSide();
    setTimeout(function () {
      inp.value = '';
      inp.className = 'answer-input';
      inp.disabled = false;
      inp.focus();
      playWord();
    }, 650);
  }
}

/* ===== 进入下一词（答对后按 Enter / 点"下一词"） ===== */
function advance() {
  var s = session;
  if (!s || !s.locked || s.finished) return;
  s.idx++;
  loadWord();
}

/* ===== 当前词表弹窗 ===== */
function openWordList() {
  if (!session || session.mode !== 'list') return;
  var l = session.list;
  var p = listProg(l.id);
  var doneSet = {};
  p.keys.forEach(function (k) { doneSet[k] = true; });
  $('wlTitle').textContent = l.title;
  $('wlSub').textContent = l.words.length + ' 词 · 已练 ' + Math.min(p.keys.length, l.words.length) + ' · 组：' + l.group;
  var html = '';
  l.words.forEach(function (w, i) {
    var isCur = session.queue[session.idx] && wordKey(session.queue[session.idx]) === wordKey(w);
    var st = doneSet[wordKey(w)] ? '<td class="st done">✓ 已练</td>'
           : isCur ? '<td class="st cur">● 当前</td>'
           : '<td class="st">—</td>';
    html += '<tr' + (isCur ? ' class="is-cur"' : '') + '><td>' + (i + 1) + '</td>'
      + '<td class="w">' + esc(w.w) + '</td><td class="k">' + esc(w.k) + '</td>'
      + '<td class="m">' + esc(w.m) + '</td>' + st + '</tr>';
  });
  $('wlBody').innerHTML = html;
  wordListDialog.showModal();
}

/* ===== 设置 ===== */
function engineGroupsVisible() {
  $('grpVoicevox').style.display = settings.engine === 'voicevox' ? '' : 'none';
  $('grpAzure').style.display = settings.engine === 'azure' ? '' : 'none';
}

function loadVvSpeakers() {
  var sel = $('setVvSpeaker');
  var base = settings.vvUrl.replace(/\/+$/, '');
  sel.innerHTML = '<option value="">加载声中…</option>';
  fetch(base + '/speakers')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (list) {
      var html = '';
      list.forEach(function (sp) {
        sp.styles.forEach(function (st) {
          html += '<option value="' + st.id + '">' + esc(sp.name)
            + (sp.styles.length > 1 ? ' · ' + esc(st.name) : '') + '</option>';
        });
      });
      sel.innerHTML = html || '<option value="">（无声线）</option>';
      if (settings.vvSpeaker != null && sel.querySelector('option[value="' + settings.vvSpeaker + '"]')) {
        sel.value = String(settings.vvSpeaker);
      } else if (sel.options.length > 0) {
        sel.value = sel.options[0].value;
        settings.vvSpeaker = parseInt(sel.value, 10);
        saveSettings();
      }
    })
    .catch(function (err) {
      sel.innerHTML = '<option value="">连接失败：' + esc(err.message) + '</option>';
    });
}

function testVoice() {
  var msg = $('testVoiceMsg');
  msg.textContent = '播放中…';
  stopPlayback();
  var text = 'こんにちは。聴き取り練習のテストです。';
  function ok() { msg.textContent = '播放完成'; }
  function fail(e) { msg.textContent = '失败：' + e.message; }
  if (settings.engine === 'browser') { speakBrowser(text, ok); return; }
  var synth = settings.engine === 'voicevox' ? vvSynthesize(text) : azSynthesize(text);
  synth.then(function (url) {
    var a = new Audio(url);
    currentAudio = a;
    a.onended = function () { currentAudio = null; ok(); };
    a.onerror = function () { currentAudio = null; fail(new Error('音频解码失败')); };
    a.play().catch(function (e) { fail(e); });
  }).catch(fail);
}

function syncSettingsUI() {
  $('setSpeed').value = settings.speed;
  $('setSpeedVal').textContent = settings.speed.toFixed(1) + 'x';
  $('setRepeats').value = settings.repeats;
  $('setGap').value = settings.gap;
  $('setGapVal').textContent = settings.gap.toFixed(1) + 's';
  $('setShowHint').checked = settings.showHint;
  document.querySelectorAll('input[name="acceptMode"]').forEach(function (r) { r.checked = r.value === settings.acceptMode; });
  document.querySelectorAll('input[name="orderMode"]').forEach(function (r) { r.checked = r.value === settings.orderMode; });
  document.querySelectorAll('input[name="engine"]').forEach(function (r) { r.checked = r.value === settings.engine; });
  $('setVvUrl').value = settings.vvUrl;
  $('setAzKey').value = settings.azKey;
  $('setAzRegion').value = settings.azRegion;
  $('setAzVoice').value = settings.azVoice;
  $('testVoiceMsg').textContent = '';
  engineGroupsVisible();
  if (settings.engine === 'voicevox') loadVvSpeakers();
}
function bindSettings() {
  $('setSpeed').addEventListener('input', function () {
    settings.speed = parseFloat(this.value);
    $('setSpeedVal').textContent = settings.speed.toFixed(1) + 'x';
    saveSettings();
  });
  $('setRepeats').addEventListener('change', function () {
    settings.repeats = Math.max(1, Math.min(5, parseInt(this.value, 10) || 1));
    this.value = settings.repeats; saveSettings();
  });
  $('setGap').addEventListener('input', function () {
    settings.gap = parseFloat(this.value);
    $('setGapVal').textContent = settings.gap.toFixed(1) + 's';
    saveSettings();
  });
  $('setShowHint').addEventListener('change', function () {
    settings.showHint = this.checked; saveSettings();
    var mb = mainBody.querySelector('#meaningBox');
    if (mb) mb.className = 'meaning-box' + (settings.showHint ? '' : ' is-hidden');
  });
  document.querySelectorAll('input[name="acceptMode"]').forEach(function (r) {
    r.addEventListener('change', function () { settings.acceptMode = this.value; saveSettings(); });
  });
  document.querySelectorAll('input[name="orderMode"]').forEach(function (r) {
    r.addEventListener('change', function () { settings.orderMode = this.value; saveSettings(); });
  });
  document.querySelectorAll('input[name="engine"]').forEach(function (r) {
    r.addEventListener('change', function () {
      settings.engine = this.value; saveSettings();
      engineGroupsVisible();
      if (settings.engine === 'voicevox') loadVvSpeakers();
    });
  });
  $('setVvUrl').addEventListener('change', function () {
    settings.vvUrl = this.value.trim() || 'http://127.0.0.1:50021';
    this.value = settings.vvUrl; saveSettings(); loadVvSpeakers();
  });
  $('setVvSpeaker').addEventListener('change', function () {
    settings.vvSpeaker = this.value === '' ? null : parseInt(this.value, 10);
    saveSettings();
  });
  $('setAzKey').addEventListener('change', function () { settings.azKey = this.value.trim(); saveSettings(); });
  $('setAzRegion').addEventListener('change', function () { settings.azRegion = this.value.trim() || 'japaneast'; saveSettings(); });
  $('setAzVoice').addEventListener('change', function () { settings.azVoice = this.value.trim() || 'ja-JP-NanamiNeural'; saveSettings(); });
  $('btnTestVoice').addEventListener('click', testVoice);
}

/* ===== 全局事件 ===== */
function bindEvents() {
  $('btnBack').addEventListener('click', backToLists);
  $('btnReview').addEventListener('click', startReview);
  $('btnWordList').addEventListener('click', openWordList);
  $('btnSettings').addEventListener('click', function () { syncSettingsUI(); settingsDialog.showModal(); });
  $('btnCloseSettings').addEventListener('click', function () { settingsDialog.close(); });
  $('btnCloseWordList').addEventListener('click', function () { wordListDialog.close(); });
  settingsDialog.addEventListener('click', function (e) { if (e.target === settingsDialog) settingsDialog.close(); });
  wordListDialog.addEventListener('click', function (e) { if (e.target === wordListDialog) wordListDialog.close(); });

  document.addEventListener('keydown', function (e) {
    if (!session || session.finished) return;
    if (settingsDialog.open || wordListDialog.open) return;
    if (viewPractice.style.display === 'none') return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!session.locked) playWord();
    } else if (e.key === 'Enter') {
      if (session.locked) { e.preventDefault(); advance(); return; }
      if (document.activeElement && document.activeElement.id === 'answerInput') return; // 输入框自己处理
      e.preventDefault();
      submitAnswer();
    }
  });
}

/* ===== 初始化 ===== */
bindSettings();
bindEvents();
updateWbBadge();
renderLists();

/* 深链：#list=<id> 直达某词表开始练习 */
(function () {
  var m = location.hash.match(/list=([\w-]+)/);
  if (!m) return;
  var l = window.DICTATION_LISTS.find(function (x) { return x.id === m[1]; });
  if (l) startList(l);
})();

})();
