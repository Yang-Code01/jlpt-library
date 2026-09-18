/* ============================================================
   动词专练 · 单元页逻辑
   数据来自本页 <script type="application/json" id="vocab-data">，
   与同目录 data.json 内容一致（file:// 下 fetch 不可用，故内联为准）。

   复制改造自 jp-vocab/vocab.js，与动词模块的差异：
   - 音频只有词读み（-w.wav），没有例文音频（-e.wav）
   - 数据顶层 examples:false 时（例文未起草完）不渲染任何例文区
   - 进度 KEY 前缀 verb-srs-（与 jp-vocab-srs- 隔离）
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
document.title = '动词专练 · ' + DATA.title;

/* ---- flatten cards ---- */
const CARDS = [];
DATA.categories.forEach(cat=>{
  cat.cards.forEach(c=> CARDS.push(Object.assign({cat:cat.name, catreading:cat.reading}, c)));
});

/* ---- audio + example display ---- */
/* 单元数据顶层 audio:false 表示该单元暂无音频：此时一个播放入口都不渲染，
   免得按钮点了没反应、也省掉必然 404 的请求。音频补齐后删掉那一行即可。
   examples:false 同理：例文未起草完时一个例文区都不渲染。 */
var HAS_AUDIO = DATA.audio !== false;
var HAS_EX = DATA.examples !== false;
function play(id, kind){ try{ new Audio('audio/'+id+'-'+kind+'.wav').play(); }catch(e){} }
function playBtn(c, kind){
  if(!HAS_AUDIO) return '';
  return '<button onclick="play(\''+c.id+'\',\''+kind+'\')">▶ '+(kind==='w'?'动词':'例文')+'</button>';
}
function audioBtns(c){ return HAS_AUDIO ? playBtn(c,'w') : ''; }
function exHtml(c){ return HAS_EX ? (c.example_jp_ruby || c.example_jp) : ''; }
function exCnHtml(c){ return HAS_EX ? c.example_cn : ''; }

/* ---- SRS (SM-2) in localStorage ---- */
const SRS_KEY='verb-srs-'+unitSlug();
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
function updateDuePill(){
  const n=dueCards().length; const el=document.getElementById('duepill');
  if(n>0){ el.textContent=n; el.style.display='inline-block'; } else el.style.display='none';
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
  DATA.categories.forEach(cat=>{
    const wrap=document.createElement('div'); wrap.className='cat';
    const head=document.createElement('div');
    head.innerHTML='<span class="cname">'+cat.name+'</span><span class="creading">'+cat.reading+'</span>';
    wrap.appendChild(head);
    cat.cards.forEach(c=>{
      const card=document.createElement('div'); card.className='card';
      card.innerHTML =
        '<div class="top"><span class="word">'+c.word+'</span><span class="kana">'+c.kana+'</span>'+
        '<span class="pos">'+c.pos+'</span><span class="meaning'+(cnHidden?' hide':'')+'">'+c.meaning_cn+'</span></div>'+
        (HAS_EX ? '<div class="ex">'+exHtml(c)+'</div>'+
        '<div class="excn'+(cnHidden?' hide':'')+'">'+exCnHtml(c)+'</div>' : '')+
        (HAS_AUDIO ? '<div class="plays">'+playBtn(c,'w')+'</div>' : '');
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
      (HAS_EX ? '<div class="ex">'+exHtml(c)+'</div>' : '')+
      '<div class="muted" style="margin-top:16px;font-size:.8rem">点击翻转</div>';
  } else {
    stage.innerHTML='<div class="meaning">'+c.meaning_cn+'</div>'+
      (HAS_EX ? '<div class="excn" style="margin-top:10px">'+exCnHtml(c)+'</div>' : '')+
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
    (HAS_EX ? '<div class="ex">'+exHtml(c)+'</div>' : '')+
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
      (HAS_EX ? '<div class="ex">'+exHtml(c)+'</div>' : '')+
      '<div class="muted" style="margin-top:16px;font-size:.8rem">回想后点击翻面自评</div>';
  } else {
    stage.innerHTML='<div class="meaning">'+c.meaning_cn+'</div>'+
      (HAS_EX ? '<div class="excn" style="margin-top:8px">'+exCnHtml(c)+'</div>' : '')+
      '<div class="muted" style="margin-top:10px;font-size:.8rem">'+c.cat+'</div>';
  }
  root.appendChild(stage);
  const ctrl=document.createElement('div'); ctrl.className='ctrl';
  ctrl.innerHTML='<button class="bad" onclick="srsRate(1)">不会</button>'+
    playBtn(c,'w')+
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
renderBrowse(); showCard(); updateDuePill();
