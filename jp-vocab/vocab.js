/* ============================================================
   课堂单词 · 单元页逻辑
   数据来自本页 <script type="application/json" id="vocab-data">，
   与同目录 data.json 内容一致（file:// 下 fetch 不可用，故内联为准）。

   相对原型的修正：
   - today() 改用本地日界（原为 UTC 日界，北京时间早上 8 点才翻日）
   - 进度 KEY 改用目录 slug（原用中文标题，单元改名即丢进度）
   - 音频按单元配置：数据顶层 audio:false 时不渲染播放入口
   - 测验的干扰项改为确定性抽样（原 while 凑数在中途会永不退出）
   ============================================================ */

var DATA = JSON.parse(document.getElementById('vocab-data').textContent);

/* ---- 单元 slug（用于进度 KEY，取路径中 <unit>/index.html 的 <unit>） ---- */
function unitSlug(){
  var parts = decodeURIComponent(location.pathname).replace(/\/+$/, '').split('/').filter(Boolean);
  var last = parts[parts.length - 1] || '';
  return /\.html?$/i.test(last) ? (parts[parts.length - 2] || 'unit') : (last || 'unit');
}

/* ---- header ---- */
document.getElementById('title').textContent = DATA.title;
document.getElementById('sub').textContent = DATA.reading;
document.getElementById('hmeaning').textContent = DATA.meaning_cn;
document.title = '课堂单词 · ' + DATA.title;

/* ---- flatten cards ---- */
const ALL_CARDS = [];
DATA.categories.forEach(cat=>{
  cat.cards.forEach(c=> ALL_CARDS.push(Object.assign({cat:cat.name, catreading:cat.reading}, c)));
});

/* ---- unit-specific study mode ---- */
const FOCUS_IDS = new Set([
  '1-2', '1-5', '2-1', '2-4', '3-1',
  '3-2', '3-5', '4-1', '4-4', '4-7',
  '4-9', '5-4', '5-6', '5-12', '5-15'
]);
const HAS_FOCUS_MODE = unitSlug() === 'yousu-no-fukushi';
const MODE_KEY = 'jp-vocab-mode-' + unitSlug();
let focusMode = HAS_FOCUS_MODE && localStorage.getItem(MODE_KEY) === 'focus';
let CARDS = focusMode ? ALL_CARDS.filter(c=>FOCUS_IDS.has(c.id)) : ALL_CARDS.slice();

function updateModeSwitch(){
  const root = document.getElementById('study-mode');
  if(!root) return;
  root.querySelectorAll('button[data-mode]').forEach(button=>{
    const active = (button.dataset.mode === 'focus') === focusMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setStudyMode(mode){
  focusMode = mode === 'focus';
  localStorage.setItem(MODE_KEY, focusMode ? 'focus' : 'all');
  CARDS = focusMode ? ALL_CARDS.filter(c=>FOCUS_IDS.has(c.id)) : ALL_CARDS.slice();
  cardIdx = 0;
  cardFlipped = false;
  qCurrent = null;
  qAnswered = false;
  srsQueue = [];
  srsCur = null;
  srsFlipped = false;
  updateModeSwitch();
  renderBrowse();
  showCard();
  updateDuePill();

  const activeTab = document.querySelector('#tabs button.active');
  if(activeTab && activeTab.dataset.tab === 'quiz') newQuiz();
  if(activeTab && activeTab.dataset.tab === 'srs') renderSrs();
}

function renderModeSwitch(){
  if(!HAS_FOCUS_MODE) return;
  const tabsRoot = document.getElementById('tabs');
  const root = document.createElement('div');
  root.id = 'study-mode';
  root.className = 'study-mode';
  root.innerHTML =
    '<span class="study-mode-label">词汇模式</span>' +
    '<button type="button" data-mode="all" aria-pressed="false">全部 '+ALL_CARDS.length+' 词</button>' +
    '<button type="button" data-mode="focus" aria-pressed="false">重点 '+FOCUS_IDS.size+' 词</button>';
  root.querySelectorAll('button[data-mode]').forEach(button=>{
    button.addEventListener('click', ()=>setStudyMode(button.dataset.mode));
  });
  tabsRoot.parentNode.insertBefore(root, tabsRoot);
  updateModeSwitch();
}

/* ---- audio + furigana display ---- */
/* 单元数据顶层 audio:false 表示该单元暂无音频：此时一个播放入口都不渲染，
   免得按钮点了没反应、也省掉必然 404 的请求。音频补齐后删掉那一行即可。 */
var HAS_AUDIO = DATA.audio !== false;
function play(id, kind){ try{ new Audio('audio/'+id+'-'+kind+'.wav').play(); }catch(e){} }
function playBtn(c, kind){
  if(!HAS_AUDIO) return '';
  return '<button onclick="play(\''+c.id+'\',\''+kind+'\')">▶ '+(kind==='w'?'副词':'例文')+'</button>';
}
function audioBtns(c){ return HAS_AUDIO ? playBtn(c,'w')+playBtn(c,'e') : ''; }
function exHtml(c){ return c.example_jp_ruby || c.example_jp; }   // ruby version for display, plain for fallback

/* ---- SRS (SM-2) in localStorage ---- */
const SRS_KEY='jp-vocab-srs-'+unitSlug();
let srs = JSON.parse(localStorage.getItem(SRS_KEY)||'{}');
function saveSrs(){ localStorage.setItem(SRS_KEY, JSON.stringify(srs)); }
function today(){
  const d = new Date();
  return Math.floor((d.getTime() - d.getTimezoneOffset()*60000) / 86400000);
}
function sm2(id, q){
  let s = srs[id] || {ef:2.5, interval:0, reps:0, due:today()};
  if(q>=3){
    s.reps+=1;
    if(s.reps===1) s.interval=1;
    else if(s.reps===2) s.interval=6;
    else s.interval=Math.round(s.interval*s.ef);
    s.ef = Math.max(1.3, s.ef + (0.1 - (5-q)*(0.08+(5-q)*0.02)));
    s.due = today()+s.interval;
  } else {
    s.reps=0; s.interval=1; s.due=today()+1;
    s.ef = Math.max(1.3, s.ef-0.2);
  }
  srs[id]=s; saveSrs();
}
function forceReview(id){
  let s = srs[id] || {ef:2.5, interval:0, reps:0, due:today()};
  s.due=today(); s.reps=0; s.interval=1; srs[id]=s; saveSrs();
}
function dueCards(){ return CARDS.filter(c=>{ let s=srs[c.id]; return !s || s.due<=today(); }); }
function renderContextPanel(){
  let root=document.getElementById('context-panel');
  if(!root){
    root=document.createElement('aside');
    root.id='context-panel';
    root.className='context-panel';
    root.innerHTML=
      '<div class="context-kicker">UNIT CONTEXT</div>'+
      '<h2 id="context-title"></h2>'+
      '<div id="context-reading" class="context-reading"></div>'+
      '<div class="context-rule"></div>'+
      '<div class="context-stat"><span>当前范围</span><strong id="context-count"></strong></div>'+
      '<div class="context-progress"><i id="context-progress-bar"></i></div>'+
      '<div id="context-progress-label" class="context-caption"></div>'+
      '<div class="context-stat"><span>待复习</span><strong id="context-due"></strong></div>'+
      '<div class="context-rule"></div>'+
      '<div class="context-kicker">CATEGORIES</div>'+
      '<div id="context-categories" class="context-categories"></div>'+
      '<a class="context-link" href="../index.html">切换其他单元 ↗</a>';
    document.querySelector('.left-rail').appendChild(root);
  }
  document.getElementById('context-title').textContent=DATA.title;
  document.getElementById('context-reading').textContent=DATA.reading;
  document.getElementById('context-count').textContent=CARDS.length+' 词';
  const mastered=CARDS.filter(c=>srs[c.id] && srs[c.id].reps>0).length;
  const percent=CARDS.length ? Math.round(mastered/CARDS.length*100) : 0;
  document.getElementById('context-progress-bar').style.width=percent+'%';
  document.getElementById('context-progress-label').textContent='已掌握 '+mastered+' / '+CARDS.length+' · '+percent+'%';
  document.getElementById('context-due').textContent=dueCards().length;
  const categories=document.getElementById('context-categories');
  categories.innerHTML='';
  DATA.categories.forEach(cat=>{
    const count=cat.cards.filter(c=>CARDS.some(active=>active.id===c.id)).length;
    if(!count) return;
    const row=document.createElement('div');
    row.innerHTML='<span>'+cat.name+'</span><b>'+count+'</b>';
    categories.appendChild(row);
  });
}
function updateDuePill(){
  const n=dueCards().length; const el=document.getElementById('duepill');
  if(n>0){ el.textContent=n; el.style.display='inline-block'; } else el.style.display='none';
  renderContextPanel();
}

/* ---- tabs ---- */
const tabs=document.querySelectorAll('#tabs button');
tabs.forEach(t=>t.addEventListener('click',()=>{
  tabs.forEach(x=>x.classList.remove('active')); t.classList.add('active');
  ['browse','card','quiz','srs'].forEach(s=>document.getElementById(s).style.display='none');
  document.getElementById(t.dataset.tab).style.display='block';
  if(t.dataset.tab==='srs') renderSrs();
  if(t.dataset.tab==='quiz') newQuiz();
  if(t.dataset.tab==='card') showCard();
}));

/* ---- browse ---- */
let cnHidden=false;
function renderBrowse(){
  const root=document.getElementById('browse'); root.innerHTML='';
  const toggle=document.createElement('button'); toggle.className='toggle-cn';
  toggle.textContent= cnHidden?'显示中文':'隐藏中文';
  toggle.onclick=()=>{ cnHidden=!cnHidden; renderBrowse(); };
  root.appendChild(toggle);
  const visibleIds = new Set(CARDS.map(c=>c.id));
  DATA.categories.forEach(cat=>{
    const cards = cat.cards.filter(c=>visibleIds.has(c.id));
    if(!cards.length) return;
    const wrap=document.createElement('div'); wrap.className='cat';
    const head=document.createElement('div');
    head.innerHTML='<span class="cname">'+cat.name+'</span><span class="creading">'+cat.reading+'</span>';
    wrap.appendChild(head);
    cards.forEach(c=>{
      const card=document.createElement('div'); card.className='card';
      card.innerHTML =
        '<div class="top"><span class="word">'+c.word+'</span><span class="kana">'+c.kana+'</span>'+
        '<span class="pos">'+c.pos+'</span><span class="meaning'+(cnHidden?' hide':'')+'">'+c.meaning_cn+'</span></div>'+
        '<div class="ex">'+exHtml(c)+'</div>'+
        '<div class="excn'+(cnHidden?' hide':'')+'">'+c.example_cn+'</div>'+
        (HAS_AUDIO ? '<div class="plays">'+playBtn(c,'w')+playBtn(c,'e')+'</div>' : '');
      wrap.appendChild(card);
    });
    root.appendChild(wrap);
  });
}

/* ---- flashcard ---- */
let cardIdx=0, cardFlipped=false;
function showCard(){
  const root=document.getElementById('card');
  if(!CARDS.length){ root.innerHTML='<p>无卡片</p>'; return; }
  if(cardIdx>=CARDS.length) cardIdx=0;
  const c=CARDS[cardIdx];
  root.innerHTML='';
  const stage=document.createElement('div'); stage.className='stage'; stage.style.cursor='pointer';
  stage.onclick=()=>{ cardFlipped=!cardFlipped; showCard(); };
  if(!cardFlipped){
    stage.innerHTML='<div class="big">'+c.word+'</div><div class="kana">'+c.kana+'</div>'+
      '<div class="ex">'+exHtml(c)+'</div>'+
      '<div class="muted" style="margin-top:16px;font-size:.8rem">点击翻转</div>';
  } else {
    stage.innerHTML='<div class="meaning">'+c.meaning_cn+'</div>'+
      '<div class="excn" style="margin-top:10px">'+c.example_cn+'</div>'+
      '<div class="muted" style="margin-top:16px;font-size:.8rem">'+c.cat+' · '+c.pos+'</div>';
  }
  root.appendChild(stage);
  const ctrl=document.createElement('div'); ctrl.className='ctrl';
  ctrl.innerHTML='<button class="ghost" onclick="cardPrev()">‹ 上一张</button>'+
    audioBtns(c)+
    '<button class="ghost" onclick="cardNext()">下一张 ›</button>';
  root.appendChild(ctrl);
}
function cardNext(){ cardIdx=(cardIdx+1)%CARDS.length; cardFlipped=false; showCard(); }
function cardPrev(){ cardIdx=(cardIdx-1+CARDS.length)%CARDS.length; cardFlipped=false; showCard(); }

/* ---- quiz ---- */
let qCurrent=null, qOptions=[], qAnswered=false;
function shuffle(a){
  const r=a.slice();
  for(let i=r.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=r[i]; r[i]=r[j]; r[j]=t; }
  return r;
}
function newQuiz(){
  const root=document.getElementById('quiz');
  if(CARDS.length<2){ root.innerHTML='<p>卡片不足2张，无法测验</p>'; return; }
  qCurrent=CARDS[Math.floor(Math.random()*CARDS.length)];
  // 干扰项：按释义去重后抽样。近义簇可能让去重后不足 3 个，此处按实际数量出题即可，不做凑数循环。
  const seen=new Set([qCurrent.meaning_cn]), pool=[];
  CARDS.forEach(c=>{
    if(c.id!==qCurrent.id && !seen.has(c.meaning_cn)){ seen.add(c.meaning_cn); pool.push(c); }
  });
  qOptions=shuffle([qCurrent].concat(shuffle(pool).slice(0,3)));
  qAnswered=false; renderQuiz();
}
function renderQuiz(){
  const c=qCurrent, root=document.getElementById('quiz'); root.innerHTML='';
  const stage=document.createElement('div'); stage.className='stage';
  stage.innerHTML='<div class="big">'+c.word+'</div><div class="kana">'+c.kana+'</div>'+
    '<div class="ex">'+exHtml(c)+'</div>'+
    '<div class="muted" style="margin-top:10px;font-size:.8rem">'+c.cat+' · 选择正确的中文释义</div>';
  root.appendChild(stage);
  const opts=document.createElement('div'); opts.className='quiz-opts';
  qOptions.forEach(o=>{
    const b=document.createElement('button'); b.textContent=o.meaning_cn;
    b.onclick=()=>answer(b,o); opts.appendChild(b);
  });
  root.appendChild(opts);
  const ctrl=document.createElement('div'); ctrl.className='ctrl';
  ctrl.innerHTML=audioBtns(c)+
    '<button class="ghost" onclick="newQuiz()">换一题</button>';
  root.appendChild(ctrl);
}
function answer(btn,o){
  if(qAnswered) return; qAnswered=true;
  btn.parentElement.querySelectorAll('button').forEach(b=>{
    b.disabled=true;
    if(b.textContent===qCurrent.meaning_cn) b.classList.add('correct');
    else if(b===btn) b.classList.add('wrong');
  });
  if(o.id!==qCurrent.id){ forceReview(qCurrent.id); updateDuePill(); }
}

/* ---- srs ---- */
let srsQueue=[], srsCur=null, srsFlipped=false;
function renderSrs(){
  const root=document.getElementById('srs');
  srsQueue=dueCards(); updateDuePill();
  if(!srsQueue.length){
    root.innerHTML='<div class="stage"><div class="big">✓</div><div class="muted" style="margin-top:10px">今日无待复习项</div></div>';
    return;
  }
  srsCur=srsQueue[0]; srsFlipped=false; showSrsCard();
}
function showSrsCard(){
  const root=document.getElementById('srs'); root.innerHTML='';
  const c=srsCur, stage=document.createElement('div'); stage.className='stage'; stage.style.cursor='pointer';
  stage.onclick=()=>{ srsFlipped=!srsFlipped; showSrsCard(); };
  if(!srsFlipped){
    stage.innerHTML='<div class="big">'+c.word+'</div><div class="kana">'+c.kana+'</div>'+
      '<div class="ex">'+exHtml(c)+'</div>'+
      '<div class="muted" style="margin-top:16px;font-size:.8rem">回想后点击翻面自评</div>';
  } else {
    stage.innerHTML='<div class="meaning">'+c.meaning_cn+'</div>'+
      '<div class="excn" style="margin-top:8px">'+c.example_cn+'</div>'+
      '<div class="muted" style="margin-top:10px;font-size:.8rem">'+c.cat+'</div>';
  }
  root.appendChild(stage);
  const ctrl=document.createElement('div'); ctrl.className='ctrl';
  ctrl.innerHTML='<button class="bad" onclick="srsRate(1)">不会</button>'+
    playBtn(c,'e')+
    '<button onclick="srsRate(4)">会</button>';
  root.appendChild(ctrl);
  const info=document.createElement('div'); info.className='muted';
  info.style.textAlign='center'; info.style.marginTop='10px';
  info.textContent='待复习 '+srsQueue.length;
  root.appendChild(info);
}
function srsRate(q){
  if(!srsCur) return;
  sm2(srsCur.id, q); srsQueue.shift(); updateDuePill();
  if(srsQueue.length){ srsCur=srsQueue[0]; srsFlipped=false; showSrsCard(); }
  else renderSrs();
}

/* ---- expose for inline handlers ---- */
window.play=play; window.cardNext=cardNext; window.cardPrev=cardPrev;
window.newQuiz=newQuiz; window.srsRate=srsRate; window.showSrsCard=showSrsCard;

/* ---- init ---- */
renderContextPanel();
renderModeSwitch();
renderBrowse(); showCard(); updateDuePill();
