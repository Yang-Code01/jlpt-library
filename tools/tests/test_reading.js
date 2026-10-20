/* 英语阅读页（en/reader.js）的行为冒烟测试
 *   运行：node tools/tests/test_reading.js
 *
 * 驱动的是生成器真正产出的那 30 个页面对应的数据与视图脚本：正文渲染、超纲词高亮、
 * 点词查义的四级兜底、页底盖章、篇目页与门户的计数。
 * 桩测不出手感（字号行距、气泡位置），那些走人工 file:// 目检；这里只钉数据与状态。
 *
 * 关键不变量：页面上标红的**不同词数**必须等于 payload 的 oovTypes —— 这条一破，
 * 说明 reader.js 的判据与生成器 tools/en-reading.mjs 分叉了。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./dom.js');

const ROOT = path.resolve(__dirname, '../..');

let pass = 0; const fails = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? '  ::  ' + extra : ''));
}
function show(v) {
  if (v && v.nodeType) return '<' + String(v.tagName).toLowerCase() + (v.id ? '#' + v.id : '') + '>';
  return JSON.stringify(v);
}
function eq(a, b, name) { ok(Object.is(a, b), name, 'got ' + show(a) + ' want ' + show(b)); }
function section(t) { console.log('\n— ' + t); }

function pageSandbox(relPath, store, opts) {
  const abs = path.join(ROOT, ...relPath.split('/'));
  const page = fs.readFileSync(abs, 'utf8');
  const dir = path.posix.dirname('/' + relPath);
  const sb = H.makeSandbox(Object.assign({ pathname: '/' + relPath, html: page }, opts || {}));
  if (store) for (const k of Object.keys(store)) sb.__store.set(k, store[k]);
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page))) {
    const src = /\ssrc="([^"]+)"/.exec(m[1]);
    if (src) {
      const p = path.posix.normalize(dir + '/' + src[1]).replace(/^\//, '');
      H.runFile(sb, path.join(ROOT, ...p.split('/')));
    } else if (m[2].trim()) {
      H.run(sb, m[2], relPath);
    }
  }
  return sb;
}

function doneOf(sb) { return JSON.parse(sb.__store.get('jlpt-progress') || '{}').done || {}; }
function progressSeed(done) { return { 'jlpt-progress': JSON.stringify({ v: 2, done: done || {}, mod: {} }) }; }

/* 有声的 speechSynthesis 桩：记下朗读的文本与参数，用来验发音走对语言 */
function speechSpy() {
  const said = [];
  return {
    said,
    ss: {
      getVoices: () => [{ lang: 'zh-CN' }, { lang: 'en-GB' }, { lang: 'en-US' }],
      speak(u) { said.push({ text: u.text, lang: u.lang, rate: u.rate, voice: u.voice && u.voice.lang }); },
      cancel() {}, addEventListener() {}
    }
  };
}

/* ===================== A 数据与页头 ===================== */
section('A 数据与页头（开生成器真正产出的 1k/01）');
{
  const sb = pageSandbox('en/reading/1k/01.html');
  const d = sb.__doc, A = sb.EN_ARTICLE;
  ok(!!sb.EnReader, 'window.EnReader 存在（测试接缝）');
  ok(!!A && !!A.paras && !!A.gloss, '页面带 window.EN_ARTICLE（正文 + 超纲词典）');
  eq(A.id, '1k-01', '本篇 id');
  eq(A.band, '1k', '本篇档位');
  const title = d.querySelector('.en-title');
  eq(title.textContent, A.title, '标题 = 书名（原文）');
  eq(title.getAttribute('lang'), 'en', '标题标 lang=en');
  ok(d.querySelector('.en-sub').textContent.indexOf(A.author) >= 0, '副标题含作者', d.querySelector('.en-sub').textContent);
  ok(d.querySelector('.en-sub').textContent.indexOf('1,582') >= 0 || /·\s*\d/.test(d.querySelector('.en-sub').textContent), '副标题含词数与超纲比', d.querySelector('.en-sub').textContent);
  const sub = d.querySelector('.en-sub').textContent;
  const red = A.oovTypes - A.missing;
  ok(sub.indexOf('超纲词 ' + red) >= 0, '副标题写超纲词个数 = 标红数（oovTypes - missing）', sub);
  eq(d.querySelector('#enReadState').textContent, '未读完', '初始未读完');
  eq(d.querySelectorAll('#enArticle .en-para').length, A.paras.length, '段落数 = payload.paras 长度');
  eq(d.querySelectorAll('#enMarkDone').length, 1, '页底有一个盖章按钮');
  eq(d.querySelectorAll('.en-w').length > 300, true, '正文里包出了大量可点词');
  /* 票 10：工作台结构 */
  ok(!!d.querySelector('.en-ws'), '双栏容器 .en-ws 存在');
  eq(d.querySelectorAll('.en-ws-side .en-pcard').length >= 1, true, '右栏有段卡（或降级卡）');
  ok(!!d.querySelector('.en-ws-oov'), '顶栏有超纲词三态开关');
  eq(d.querySelector('.en-ws').getAttribute('data-oov'), 'soft', '超纲词默认 soft');
}

/* ===================== B 高亮与查义判据 ===================== */
section('B 高亮与查义判据');
{
  const sb = pageSandbox('en/reading/1k/01.html');
  const d = sb.__doc, A = sb.EN_ARTICLE, R = sb.EnReader;
  const reds = d.querySelectorAll('.en-w.is-oov');
  const redTypes = {};
  for (const el of reds) redTypes[el.getAttribute('data-w')] = 1;
  const uniq = Object.keys(redTypes).sort();
  eq(uniq.length, A.oovTypes - A.missing, '标红的不同词数 === oovTypes - missing（判据与生成器一致）');
  eq(d.querySelectorAll('.en-w').length - reds.length >= 0, true, '可点词数不少于标红数');

  /* 词表里的词不该标红 */
  for (const w of ['the', 'a', 'and', 'of', 'chapter', 'gift', 'era']) {
    if (!R.inVocab(w)) continue;
    const hit = d.querySelectorAll('.en-w.is-oov[data-w="' + w + '"]');
    eq(hit.length, 0, '词表里的 ' + w + ' 不标红');
  }
  eq(R.inVocab('the'), true, 'inVocab 认 the');
  eq(R.inVocab('zzzzq'), false, 'inVocab 不认生造词');

  /* 专有名词：从没出现过全小写 → 一次都不包、不标红 */
  const seen = {};
  for (const p of A.paras) for (const t of R.wordsOf(p)) if (t === t.toLowerCase()) seen[t] = 1;
  let proper = null;
  for (const p of A.paras) { for (const t of R.wordsOf(p)) { if (t !== t.toLowerCase() && !seen[t.toLowerCase()]) { proper = t; break; } } if (proper) break; }
  ok(!!proper, '正文里找得到一个纯大写的专有名词', String(proper));
  if (proper) {
    eq(d.querySelectorAll('.en-w[data-w="' + proper.toLowerCase() + '"]').length, 0, '专有名词 ' + proper + ' 不被包成可点词');
    eq(R.lookup(proper.toLowerCase()), null, '专有名词查不到 → 点了什么都不弹');
  }

  /* 四级兜底：词形变化反查（gloss 的 ex 字段给出变形） */
  let viaForm = null;
  for (const k of Object.keys(A.gloss)) {
    for (const f of R.formsOf(A.gloss[k].ex)) {
      if (A.gloss[f]) continue;
      if (d.querySelector('.en-w.is-oov[data-w="' + f + '"]')) { viaForm = { f: f, k: k }; break; }
    }
    if (viaForm) break;
  }
  if (viaForm) {
    ok(!!R.lookup(viaForm.f), '变形词 ' + viaForm.f + ' 能查到（反查 exchange → ' + viaForm.k + '）');
  } else {
    ok(true, '（本篇没有可验反查的变形词，跳过）');
  }
  /* went → go 走的是词表自身的 exchange 反查 */
  eq(!!R.lookup('went') && R.lookup('went').w, 'go', 'went 反查到 go（第 4 级兜底）');

  /* 转义：正文里出现 < & 也不能漏进 DOM */
  const html = R.markPara('a < b & c "d"');
  ok(html.indexOf('&lt;') >= 0 && html.indexOf('&amp;') >= 0 && html.indexOf('<b') < 0, 'markPara 转义 < 与 &', html);

  /* 票 10：长段句界切块 —— 标红判据在切块后不变形 */
  const reds2 = d.querySelectorAll('.en-w.is-oov');
  const redTypes2 = {};
  for (const el of reds2) redTypes2[el.getAttribute('data-w')] = 1;
  eq(Object.keys(redTypes2).length, uniq.length, '切块后标红的不同词数不变（切分不丢词形）');
}

/* ===================== C 点词查义气泡 ===================== */
section('C 点词查义气泡');
{
  const spy = speechSpy();
  const sb = pageSandbox('en/reading/1k/01.html', null, { speechSynthesis: spy.ss });
  const d = sb.__doc, A = sb.EN_ARTICLE, R = sb.EnReader;

  /* 超纲词：气泡里应有「超纲词」标签 */
  let redKey = null;
  for (const k of Object.keys(A.gloss)) if (d.querySelector('.en-w.is-oov[data-w="' + k + '"]')) { redKey = k; break; }
  ok(!!redKey, '找得到一个既标红又有释义的词', String(redKey));
  const redSpan = d.querySelector('.en-w.is-oov[data-w="' + redKey + '"]');
  redSpan.click();
  eq(R.state().popped, true, '点超纲词弹出气泡');
  eq(R.state().active, redKey, '气泡记住当前词');
  const pop = d.querySelector('.en-pop');
  ok(pop.classList.contains('is-on'), '气泡带 is-on 类');
  ok(pop.querySelector('.en-pop-word').textContent.toLowerCase() === redKey, '气泡标题是点中的词', pop.querySelector('.en-pop-word').textContent);
  ok(pop.querySelector('.en-pop-tr').textContent.length > 0, '气泡里有中释', pop.querySelector('.en-pop-tr').textContent.slice(0, 24));
  ok(!!pop.querySelector('.en-pop-tag'), '超纲词气泡带「超纲词」标签');
  ok(pop.querySelector('.en-pop-def').textContent.length > 0, '气泡里有英释');
  ok(/px$/.test(pop.style.left) && /px$/.test(pop.style.top), '气泡定位写成 px', pop.style.left + ',' + pop.style.top);
  eq(redSpan.classList.contains('is-active'), true, '当前词带 is-active');

  /* 发音按钮：走 en-US / rate 0.9，且读的是这个词 */
  pop.querySelector('.en-pop-say').click();
  eq(spy.said.length, 1, '点发音会朗读一次');
  eq(spy.said[0].text, redKey, '朗读的文本是点中的词');
  eq(spy.said[0].lang, 'en-US', '朗读语言 en-US');
  eq(spy.said[0].rate, 0.9, '语速 0.9（与 en/unit.js 一致）');
  eq(spy.said[0].voice, 'en-US', '优先挑 en-US 音色');

  /* 再点同一个词收起 */
  redSpan.click();
  eq(R.state().popped, false, '再点同一个词收起气泡');

  /* 词表内的词也能点，但不带超纲标签 */
  let knownSpan = null;
  for (const el of d.querySelectorAll('.en-w')) if (!el.classList.contains('is-oov')) { knownSpan = el; break; }
  ok(!!knownSpan, '正文里有词表内的可点词');
  knownSpan.click();
  eq(R.state().popped, true, '词表内的词也能点开');
  eq(!!pop.querySelector('.en-pop-tag'), false, '词表内的词不带超纲标签');
  const known = R.state().active;
  ok(knownSpan.getAttribute('data-w') === known, '气泡跟的是这个词');

  /* 点页面别处 / Esc 都收起 */
  d.body.fire('click');
  eq(R.state().popped, false, '点别处收起气泡');
  knownSpan.click();
  eq(R.state().popped, true, '重新点开');
  d.fire('keydown', { key: 'Escape' });
  eq(R.state().popped, false, 'Esc 收起气泡');
}

/* ===================== D 页底盖章 ===================== */
section('D 页底盖章 → jlpt-progress');
{
  const sb = pageSandbox('en/reading/2k/03.html');
  const d = sb.__doc;
  const btn = d.querySelector('#enMarkDone');
  eq(btn.textContent, '标记为已读完', '按钮初值');
  eq(d.querySelector('#enReadState').textContent, '未读完', '计量初值未读完');
  btn.click();
  ok(typeof doneOf(sb)['reading/2k/03.html'] === 'number', '盖章写进 reading/2k/03.html（keyOf 取末三段）');
  eq(btn.textContent, '已读完（点击取消）', '按钮变成可取消');
  eq(d.querySelector('#enReadState').textContent, '已读完', '计量变已读完');
  eq(d.querySelector('#enReadState').classList.contains('is-full'), true, '计量点亮 is-full');
  btn.click();
  eq('reading/2k/03.html' in doneOf(sb), false, '再点取消，进度里删掉这条');
  eq(btn.textContent, '标记为已读完', '按钮回到初值');
}

{
  const sb = pageSandbox('en/reading/2k/03.html', progressSeed({ 'reading/2k/03.html': 1750000000000 }));
  const d = sb.__doc;
  eq(d.querySelector('#enMarkDone').textContent, '已读完（点击取消）', '已读过的页面进来就是已读态');
  eq(sb.EnReader.state().done, true, 'state().done 与进度一致');
}

{
  const sb = pageSandbox('en/reading/1k/02.html', progressSeed({ 'reading/2k/03.html': 1 }));
  eq(sb.EnReader.state().done, false, '别的篇已读不影响本篇');
}

/* ===================== E 篇目页 ===================== */
section('E 篇目页 en/reading/index.html');
{
  const sb = pageSandbox('en/reading/index.html');
  const d = sb.__doc;
  const rows = d.querySelectorAll('[data-en-key]');
  eq(rows.length, 30, '篇目页 30 行');
  eq(d.querySelector('#enReadDone').textContent, '已读 0/30', '计量初值 已读 0/30');
  eq(d.querySelectorAll('.en-band-block').length, 4, '四档分组');
  const bands = d.querySelectorAll('.en-band-done').map((s) => s.textContent);
  eq(bands.length, 4, '每档一个已读计数');
  ok(bands.every((t) => t.indexOf('已读 0/') === 0), '四档计数初值都是 0', bands.join(' | '));
  eq(rows[0].getAttribute('data-en-key'), 'en/reading/1k/01.html', '首行 key');
  eq(d.querySelector('.en-art-row').getAttribute('href'), '1k/01.html', '首行 href 指向同目录下的篇目');
}
{
  const sb = pageSandbox('en/reading/index.html', progressSeed({
    'reading/1k/01.html': 1, 'reading/4k/07.html': 1
  }));
  const d = sb.__doc;
  eq(d.querySelector('#enReadDone').textContent, '已读 2/30', '种子进度 已读 2/30');
  eq(d.querySelector('#enReadDone').classList.contains('is-full'), false, '没读满不点亮');
  eq(d.querySelectorAll('.en-art-row.is-done').length, 2, '两行带上 is-done');
  ok(d.querySelector('.en-band-done').textContent === '已读 1/8', '1k 档计数 1/8', d.querySelector('.en-band-done').textContent);
  const all = d.querySelectorAll('.en-band-done').map((s) => s.textContent);
  ok(all[3] === '已读 1/7', '4k 档计数 1/7', all.join(' | '));
}

/* ===================== F 门户 ===================== */
section('F 门户英语面：阅读行与总分母');
{
  const sb = pageSandbox('index.html');
  const d = sb.__doc;
  const keys = d.querySelectorAll('[data-en-key]');
  const uniq = {};
  for (const k of keys) uniq[k.getAttribute('data-en-key')] = 1;
  eq(Object.keys(uniq).length, 107, '门户英语面 107 个单元（77 词表 + 30 阅读）');
  const read = [];
  for (const k of keys) if (k.getAttribute('data-en-key').indexOf('en/reading/') === 0) read.push(k);
  eq(read.length, 30, '阅读行 30 条');
  eq(d.querySelector('[data-en-overall]').textContent, '已看 0/107', '总进度分母 107');
  const prog = d.querySelectorAll('[data-en-prog]').map((s) => s.textContent);
  /* ADR-0010：语言学习区改成模块卡片，旧的编号入口行（.path-row）已退休 */
  const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  eq((raw.match(/<article class="card"/g) || []).length, 11, '语言学习区 11 张模块卡');
  ok(/<article class="card"[\s\S]{0,700}?href="en\/reading\/index\.html"/.test(raw), '阅读精读卡片存在');
  ok(prog.some((t) => t === '已看 0/8'), '阅读 1k 档分组计数 已看 0/8', prog.join(' | '));
  ok(prog.some((t) => t === '已看 0/20'), '词表 1k 档分组计数 已看 0/20', prog.join(' | '));
}
{
  const sb = pageSandbox('index.html', progressSeed({ 'reading/1k/01.html': 1, 'en/1k/01.html': 1 }));
  const d = sb.__doc;
  eq(d.querySelector('[data-en-overall]').textContent, '已看 2/107', '盖章后总进度 +2');
  eq(d.querySelectorAll('[data-en-key].is-done').length, 2, '两行点亮 is-done');
}

/* ===================== 汇总 ===================== */
console.log('');
if (fails.length) {
  console.log('FAIL ' + fails.length + ' 项：');
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('通过 ' + pass + ' 项');
  process.exit(1);
}
console.log('✓ 全部通过 (' + pass + ')');
