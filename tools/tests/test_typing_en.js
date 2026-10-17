/* 英语打字页（en/typing/）的行为冒烟测试
 *   运行：node tools/tests/test_typing_en.js
 *
 * 驱动的是真页面 en/typing/index.html：词池（由 en/data/vocab.js 现算 + 搭配）、
 * 语言层覆盖对象、与日语侧共用的打字内核、传送带时长、竞技结算与最高分键。
 * 桩测不出手感（街机动画、音效听感），那些走人工 file:// 目检；这里只钉数据与状态。
 *
 * 关键不变量：
 *   ① 4 档词池的合计词数 = 词表词数 − 不可敲词（2）+ 搭配（37）：999+1000+809+993 = 3801
 *   ② 每个词池条目的 k 都必须是内核能接受的形（^[a-z-]+$，无空格无撇号），
 *      且 cfg.match(item, item.k) 必须 complete —— 这条一破，说明词池与判定器分叉了。
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

/* 语音桩：记下每次朗读的文本与参数（语音表刻意把 ja / en-GB 排在 en-US 之前，
   用来验证「精确 en-US 胜过前缀匹配 en-GB」） */
const VOICES = [
  { lang: 'ja-JP', name: 'ja' },
  { lang: 'en-GB', name: 'en-gb' },
  { lang: 'en-US', name: 'en-us' }
];
function speechSpy() {
  const said = [];
  const synth = {
    getVoices: () => VOICES,
    speak: (u) => { said.push(u); },
    cancel: () => {},
    addEventListener: () => {}
  };
  return { synth, said };
}

/* 开一个英语打字页；返回值直接就是 vm 沙箱（window === sandbox） */
function open(store, extra) {
  const spy = speechSpy();
  let tickFn = null;
  const sb = pageSandbox('en/typing/index.html', store, Object.assign({
    speechSynthesis: spy.synth,
    setInterval: (fn) => { tickFn = fn; return 1; }
  }, extra || {}));
  /* 内核是「播放时才 new」，所以脚本跑完后换掉构造函数即可记账（含 lang / rate / voice） */
  sb.SpeechSynthesisUtterance = function (t) {
    this.text = t; this.lang = ''; this.rate = 1; this.voice = null;
  };
  return { sb, said: spy.said, tick: () => tickFn && tickFn() };
}

const $ = (sb, id) => sb.__doc.getElementById(id);
const txt = (sb, id) => { const n = $(sb, id); return n ? String(n.textContent || '') : ''; };
const click = (sb, id) => $(sb, id).fire('click');

/* 逐字符敲对 n 个字符（跨词自动续），返回实际敲对数 */
function typeCorrect(sb, n) {
  const G = sb.TypingGame;
  let done = 0;
  while (done < n) {
    const cur = G.state.current;
    if (!cur) break;
    const k = String(cur.k);
    if (G.state.typed.length >= k.length) break;
    G.handleChar(k.charAt(G.state.typed.length));
    done++;
  }
  return done;
}
/* 敲一个「一定错」的字符 */
function typeWrong(sb) {
  const G = sb.TypingGame;
  const k = String(G.state.current.k);
  const expect = k.charAt(G.state.typed.length);
  G.handleChar(expect === 'z' ? 'q' : 'z');
}

function bestOf(sb) { return JSON.parse(sb.__store.get('jlpt-typing-best') || '{}'); }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/* ===================== A 词池与页头 ===================== */
section('A 词池（由 en/data/vocab.js 现算）与页头');
{
  const { sb } = open();
  const M = sb.EN_TYPING_META;
  eq(M.counts['1k'], 999, '1k 档 999 词（1000 − 撇号词 n\'t）');
  eq(M.counts['2k'], 1000, '2k 档 1000 词');
  eq(M.counts['3k'], 809, '3k 档 809 词');
  eq(M.counts['4k'], 993, '4k 档 993（957 词 − o\'clock + 37 搭配）');
  eq(M.phrases, 37, '搭配 37 条');
  eq(M.dropped.join(','), "n't,o'clock", '两个撇号词被排除（内核只收 a–z 与 -）');
  eq(M.counts['1k'] + M.counts['2k'] + M.counts['3k'] + M.counts['4k'], 3801, '四档合计 = 3766 − 2 + 37');

  const pools = ['1K', '2K', '3K', '4K'].map((t) => sb['TYPING_WORDS_' + t]);
  const names = ['1k', '2k', '3k', '4k'];
  names.forEach((b, i) => eq(pools[i].length, M.counts[b], b + ' 词池长度与 meta 一致'));
  ok(pools.every((p) => p.every((it) => it.w && it.k && typeof it.m === 'string' && typeof it.p === 'string')),
    '每条都是 { w, k, m, p } 四字段');
  ok(pools.every((p) => p.every((it) => /^[a-z][a-z-]*$/.test(it.k))),
    '每条 k 都是内核能敲的形（a–z 与 -，无空格无撇号）');
  ok(pools.every((p) => p.every((it) => it.k === it.w.replace(/ /g, ''))),
    'k 恒等于「w 去掉空格」');

  /* 难度轴：档位越高词越长；搭配只出现在 4k */
  const lengths = pools.map((p) => p.map((it) => it.k.length));
  ok(mean(lengths[0]) < mean(lengths[1]), '平均词长 1k < 2k', mean(lengths[0]).toFixed(2) + ' / ' + mean(lengths[1]).toFixed(2));
  ok(mean(lengths[1]) < mean(lengths[2]), '平均词长 2k < 3k', mean(lengths[1]).toFixed(2) + ' / ' + mean(lengths[2]).toFixed(2));
  const longShare = (a) => a.filter((n) => n >= 8).length / a.length;
  ok(longShare(lengths[0]) < longShare(lengths[2]), '8 字母以上占比 1k < 3k',
    (longShare(lengths[0]) * 100).toFixed(1) + '% / ' + (longShare(lengths[2]) * 100).toFixed(1) + '%');
  const multiword = (p) => p.filter((it) => it.w.indexOf(' ') >= 0);
  eq(multiword(pools[0]).length + multiword(pools[1]).length + multiword(pools[2]).length, 0, '1k/2k/3k 没有词组');
  eq(multiword(pools[3]).length, 37, '4k 含全部 37 条固定搭配');
  ok(multiword(pools[3]).every((it) => it.k.indexOf(' ') < 0 && it.m === ''), '词组：k 无空格、无中文释义');

  /* 页头与选档按钮 */
  eq(sb.document.title, '英语打字 · Language Library', '页面标题');
  ok(txt(sb, 'label-tier').indexOf('4k') >= 0, '难度标签提到 4k（固定搭配）');
  const tiers = sb.__doc.querySelectorAll('.ty-opt[data-tier]');
  eq(tiers.length, 4, '四个档位按钮');
  eq(tiers.map((b) => b.getAttribute('data-tier')).join(','), '1k,2k,3k,4k', '档位顺序 1k→4k');
  eq(tiers.map((b) => String(b.textContent)).join('|').indexOf('999 词') >= 0, true, '1k 按钮标 999 词');
  eq(tiers.map((b) => String(b.textContent)).join('|').indexOf('993 词') >= 0, true, '4k 按钮标 993 词');
  eq(sb.__doc.querySelectorAll('.ty-opt[data-mode]').length, 3, '三种模式按钮');
  eq(sb.__doc.querySelectorAll('.ty-opt[data-speed]').length, 5, '五档速度按钮');
  eq(String($(sb, 'typing-app').getAttribute('class')).indexOf('typing-app') >= 0, true, '页面根节点就位');

  /* 语言层接线：档位表来自 cfg，默认档位生效 */
  const G = sb.TypingGame;
  eq(Object.keys(G.cfg.tiers).join(','), '1k,2k,3k,4k', '内核档位表被覆盖成英语四档');
  eq(G.state.tier, '1k', '默认档位 1k');
  eq(G.cfg.srcPrefix, 'en/typing/', '加载失败文案的路径前缀');
  ok(typeof sb.Romaji === 'undefined', '英语页没有 romaji.js（内核守卫已按 CFG 放行）');
  const pageText = fs.readFileSync(path.join(ROOT, 'en/typing/index.html'), 'utf8');
  ok(!/<script[^>]+src="[^"]*romaji\.js"/.test(pageText), '页面没有以 <script src> 引入 romaji.js');
  ok(/<script[^>]+src="\.\.\/data\/vocab\.js"/.test(pageText), '词池来自 en/data/vocab.js（与词表同一份数据）');
}

/* ===================== B 语言层 ===================== */
section('B 语言层覆盖对象（TYPING_CFG）');
{
  const { sb } = open();
  const cfg = sb.TypingGame.cfg;
  eq(cfg.speechLang, 'en-US', '语音语言 en-US');
  eq(cfg.voiceMatch('en-US'), true, 'voiceMatch 认 en-US');
  eq(cfg.voiceMatch('en-GB'), true, 'voiceMatch 认 en-GB（前缀兜底）');
  eq(cfg.voiceMatch('ja-JP'), false, 'voiceMatch 不认日语');
  eq(cfg.voiceMatch(undefined), false, 'voiceMatch 对空值安全');

  eq(cfg.readings({ w: 'the', k: 'the' }).join(','), 'the', '单词 readings = [k]');
  eq(cfg.readings({ w: 'at once', k: 'atonce' }).join(','), 'atonce', '词组 readings = [去空格的 k]');
  eq(cfg.flowLength({ k: 'atonce' }), 6, 'flowLength = k 的字母数');

  const w = { w: 'the', k: 'the' };
  eq(cfg.match(w, '').status, 'ok', '空输入判 ok（与 Romaji.match 同契约：等着敲第一个字符）');
  eq(cfg.match(w, 'th').status, 'ok', '前缀判 ok');
  eq(cfg.match(w, 'th').expects.join(','), 'e', 'ok 时给出下一个期望字符');
  eq(cfg.match(w, 'the').status, 'complete', '整词判 complete');
  eq(cfg.match(w, 'thx').status, 'wrong', '错字符判 wrong');
  eq(cfg.match(w, 'thex').status, 'wrong', '超长判 wrong');
  const ph = { w: 'as soon as', k: 'assoonas' };
  eq(cfg.match(ph, 'assoonas').status, 'complete', '词组连续输入字母即完成（不按空格）');
  eq(cfg.match(ph, 'assoona').status, 'ok', '词组前缀判 ok');

  eq(cfg.bestKey, undefined, '未覆盖 bestKey → 与日语侧共用 jlpt-typing-best');
  eq(cfg.speedKey, undefined, '未覆盖 speedKey');
  eq(cfg.soundKey, undefined, '未覆盖 soundKey');
}

/* ===================== C 开局 / 出词 / 收词 / 错字 ===================== */
section('C 开局出词、收词计分、错字反馈');
{
  const { sb, said } = open();
  const G = sb.TypingGame;
  click(sb, 'btn-start');
  eq(G.state.screen, 'playing', '点开始进入 playing');
  eq($(sb, 'screen-game').hidden, false, '游戏屏显示');
  eq($(sb, 'screen-start').hidden, true, '选档屏隐藏');
  eq(txt(sb, 'hud-mode'), '练习·1k·1x', 'HUD 模式行 = 练习·1k·1x');
  eq(txt(sb, 'hud-time'), '∞', '练习模式时间显示 ∞');

  const cur = G.state.current;
  const pool = sb.TYPING_WORDS_1K.map((it) => it.k);
  ok(pool.indexOf(cur.k) >= 0, '出词来自 1k 词池');
  eq(txt(sb, 'ln-word'), cur.w, '卡片大字 = 词形');
  ok(txt(sb, 'ln-romaji').indexOf(cur.k) >= 0, '提示行含期望输入串');
  eq(txt(sb, 'ln-mean'), cur.m, '释义行 = 中文释义');

  /* 收一个词：分数 = 字母数 × 10，连击 +1，并朗读一次 */
  const len = cur.k.length;
  typeCorrect(sb, len);
  eq(txt(sb, 'hud-words'), '1', '收词数 1');
  eq(txt(sb, 'hud-combo'), '1', '连击 1');
  eq(txt(sb, 'hud-score'), String(len * 10), '分数 = 字母数 × 10');
  eq(said.length, 1, '收词后朗读一次');
  eq(said[0].text, cur.w, '朗读的是这个词（词组带空格）');
  eq(said[0].lang, 'en-US', '朗读语言 en-US');
  eq(said[0].rate, 0.9, '朗读语速 0.9');
  eq(said[0].voice, VOICES[2], '语音精确命中 en-US（胜过排在前面的 en-GB）');

  /* 敲错：练习模式不扣分、不换词，只给红字反馈 */
  const before = { w: txt(sb, 'hud-words'), s: txt(sb, 'hud-score'), k: G.state.current.k };
  typeWrong(sb);
  eq(txt(sb, 'hud-words'), before.w, '敲错不换词');
  eq(txt(sb, 'hud-score'), before.s, '练习模式敲错不扣分');
  eq(G.state.current.k, before.k, '当前词不变');
  eq($(sb, 'card').classList.contains('ty-wrong'), true, '卡片打上 ty-wrong');
  ok(txt(sb, 'sr-status').indexOf('敲错') >= 0, '无障碍播报「敲错了」');
  ok(txt(sb, 'ln-echo').indexOf('') === 0, '输入回显存在');

  /* 敲对前缀：回显 = 已输入，提示行把命中部分标出来。
     前缀必须**严格短于**整个词：词池用 shuffle()（Math.random）洗牌，如果首词是 "up" / "go"
     这种两字母词，敲满两下就收词了，回显被重置成空串 —— 这条断言曾因此偶发变红（CI 抽到就随机挂）。 */
  const key = String(G.state.current.k);
  const n = Math.min(2, key.length - 1);
  for (let i = 0; i < n; i++) G.handleChar(key.charAt(i));
  eq(txt(sb, 'ln-echo'), key.slice(0, n), '回显 = 已输入前缀');
  ok($(sb, 'ln-romaji').innerHTML.indexOf('ty-hit') >= 0, '提示行区分已命中 / 待输入');
}

/* ===================== D 传送带时长按字母数 ===================== */
section('D 传送带时长（flowLength = 字母数）');
{
  const { sb } = open();
  const G = sb.TypingGame;
  G.state.speed = 1;
  eq(G.flowDurationMs({ k: 'a'.repeat(1) }), 4200, '1 字母 → 4200ms 下限');
  eq(G.flowDurationMs({ k: 'a'.repeat(5) }), 8000, '5 字母 → 8000ms');
  eq(G.flowDurationMs({ k: 'congratulations' }), 16000, '15 字母 → 16000ms 上限');
  G.state.speed = 2;
  eq(G.flowDurationMs({ k: 'a'.repeat(5) }), 4000, '2x 速度 → 4000ms');
  G.state.speed = 1;
  click(sb, 'btn-start');
  ok(/^\d+ms$/.test(String($(sb, 'typing-app').style['--ty-flow-ms'])), '--ty-flow-ms 已写入（形如 8000ms）',
    $(sb, 'typing-app').style['--ty-flow-ms']);
}

/* ===================== E 竞技 60 秒：WPM / 准确率 / 最高分键 ===================== */
section('E 竞技模式：60 秒倒计时、WPM 与准确率、最高分复用同一存储键');
{
  const { sb, tick } = open();
  const G = sb.TypingGame;
  sb.__doc.querySelector('.ty-opt[data-mode="competition"]').fire('click');
  eq(G.state.mode, 'competition', '模式切到竞技');
  click(sb, 'btn-start');
  eq(txt(sb, 'hud-mode'), '竞技·1k·1x', 'HUD 显示竞技·1k·1x');
  eq(txt(sb, 'hud-time'), '60s', '竞技从 60 秒起算');

  const typed = typeCorrect(sb, 10);
  eq(typed, 10, '敲对 10 个字符');
  tick();
  ok(/^\d+s$/.test(txt(sb, 'hud-time')), '倒计时在走（HUD 显示剩余秒数）', txt(sb, 'hud-time'));
  /* 把开局时刻推到 60 秒前，再走一次 tick → 时间到 */
  G.state.startAt -= 61000;
  tick();
  eq(G.state.screen, 'over', '时间到自动结算');
  eq($(sb, 'screen-over').hidden, false, '结算屏显示');

  const over = txt(sb, 'over-title');
  ok(over.indexOf('竞技·1k·1x') >= 0, '结算标题含模式·档位·速度', over);
  ok(over.indexOf('时间到') >= 0, '结算标题带结束原因', over);
  const stats = $(sb, 'over-stats').innerHTML;
  ok(stats.indexOf('分数') >= 0 && stats.indexOf('收词数') >= 0, '结算含分数与收词数');
  ok(stats.indexOf('正确率') >= 0 && stats.indexOf('100%') >= 0, '全部敲对 → 正确率 100%');
  ok(stats.indexOf('WPM') >= 0 && stats.indexOf('（1x）') >= 0, '结算含 WPM 并标注速度倍率');
  ok(stats.indexOf('最高连击') >= 0 && stats.indexOf('本档历史最高') >= 0, '结算含最高连击与本档历史最高');
  eq($(sb, 'over-record').hidden, false, '首次成绩即新纪录');

  const best = bestOf(sb);
  eq(Object.keys(best).join(','), 'competition:1k:1', '最高分写进 jlpt-typing-best 的 competition:1k:1（与日语侧同键）');
  eq(best['competition:1k:1'].score, Number(txt(sb, 'hud-score')), '最高分与 HUD 分数一致');
  ok(typeof best['competition:1k:1'].at === 'string' && best['competition:1k:1'].at.length >= 10, '记录了时间戳');
  /* 10 个正确字符 ≈ 2 WPM（60 秒窗口） */
  eq(best['competition:1k:1'].wpm, 2, 'WPM = 正确字符 / 5 / 分钟');

  /* 再来一局按钮回到选档 → 可直接再开 */
  click(sb, 'btn-back');
  eq($(sb, 'screen-start').hidden, false, '返回选档屏');
  ok(txt(sb, 'best-list').indexOf('本档最高') >= 0, '选档屏显示本档记录');
}

/* ===================== F 最高分按档位 / 模式隔离（共用键不互相覆盖） ===================== */
section('F 最高分按「模式·档位·速度」隔离，日语侧记录不受影响');
{
  const seed = { 'jlpt-typing-best': JSON.stringify({ 'practice:n5:1': { score: 999, words: 99, wpm: 99, at: '2025-01-01T00:00:00.000Z' } }) };
  const { sb } = open(seed);
  const G = sb.TypingGame;
  /* 无尽模式：敲错即终 —— 用它来一局到底 */
  sb.__doc.querySelector('.ty-opt[data-mode="endless"]').fire('click');
  click(sb, 'btn-start');
  eq(txt(sb, 'hud-time'), '∞', '无尽模式无倒计时');
  typeCorrect(sb, 3);
  typeWrong(sb);
  eq(G.state.screen, 'over', '无尽模式敲错即结束');
  ok(txt(sb, 'over-title').indexOf('敲错了') >= 0, '结算原因 = 敲错了');

  /* 换 4k 档再来一局 */
  click(sb, 'btn-back');
  sb.__doc.querySelector('.ty-opt[data-tier="4k"]').fire('click');
  eq(G.state.tier, '4k', '档位切到 4k');
  click(sb, 'btn-start');
  eq(txt(sb, 'hud-mode'), '无尽·4k·1x', 'HUD 显示无尽·4k·1x');
  typeWrong(sb);

  const best = bestOf(sb);
  ok(!!best['endless:1k:1'], '1k 无尽成绩独立成键');
  ok(!!best['endless:4k:1'], '4k 无尽成绩独立成键');
  eq(best['practice:n5:1'].score, 999, '日语侧既有记录原样保留');
  eq(Object.keys(best).length, 3, '共三条记录，互不覆盖');
}

/* ===================== G 4k 档的固定搭配可敲 ===================== */
section('G 4k 档固定搭配：每条都必须是内核能敲、能判完的');
{
  const { sb } = open();
  const cfg = sb.TypingGame.cfg;
  const pool = sb.TYPING_WORDS_4K;
  let bad = null, phrases = 0;
  for (const it of pool) {
    if (it.w.indexOf(' ') >= 0) {
      phrases++;
      if (it.k.indexOf(' ') >= 0) { bad = it.w + ' 的 k 带空格'; break; }
    }
    /* 逐前缀判定：中途必须 ok，敲满必须 complete —— 即「全程没有敲不动的字符」 */
    const k = String(it.k);
    for (let i = 1; i <= k.length; i++) {
      const st = cfg.match(it, k.slice(0, i)).status;
      const want = (i === k.length) ? 'complete' : 'ok';
      if (st !== want) { bad = it.w + ' 第 ' + i + ' 个字符判成 ' + st; break; }
    }
    if (bad) break;
    if (cfg.readings(it)[0] !== it.k) { bad = it.w + ' readings 与 k 不一致'; break; }
  }
  eq(bad, null, '993 条全部可敲、可判完（含 37 条搭配）', bad);
  eq(phrases, 37, '其中 37 条是词组');
  ok(pool.some((it) => it.k.length === 11), '4k 档确实有更长的词（11 字母，如 according）');
}

/* ===================== H 门户入口与日语侧未被污染 ===================== */
section('H 门户入口、日语打字页与内核默认值不受影响');
{
  const portal = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(portal.indexOf('href="en/typing/index.html"') >= 0, '门户有英语打字入口');
  ok(/href="en\/typing\/index\.html"[\s\S]{0,200}?row-index" aria-hidden="true">04</.test(portal), '英语打字行编号 04');
  ok(/href="en\/dictation\/index\.html"[\s\S]{0,200}?row-index" aria-hidden="true">03</.test(portal), '英语听写行编号 03');
  ok(fs.existsSync(path.join(ROOT, 'en/typing/index.html')), '英语打字页文件存在');
  ok(fs.existsSync(path.join(ROOT, 'en/typing/words.js')) && fs.existsSync(path.join(ROOT, 'en/typing/cfg.js')),
    '词池与语言层脚本存在');

  /* 日语打字页：五档、无英语档位、无英语脚本 */
  const ja = fs.readFileSync(path.join(ROOT, 'typing/index.html'), 'utf8');
  ok(ja.indexOf('data-tier="n5"') >= 0 && ja.indexOf('data-tier="n1"') >= 0, '日语页仍是 n5–n1 五档');
  ok(ja.indexOf('data-tier="1k"') < 0, '日语页没有英语档位');
  ok(ja.indexOf('romaji.js') >= 0 && ja.indexOf('TYPING_CFG') < 0, '日语页仍引 romaji.js 且不设覆盖对象');

  const sb = pageSandbox('typing/index.html');
  const G = sb.TypingGame;
  eq(Object.keys(G.cfg).length, 0, '不设覆盖时内核 CFG 为空对象（日语侧逐字不变）');
  eq(G.state.tier, 'n5', '日语侧默认档位仍是 n5');
  ok(typeof sb.Romaji === 'object' && typeof sb.Romaji.match === 'function', '日语侧仍靠 romaji.js');
  eq(G.flowDurationMs({ k: 'あ'.repeat(3) }), 5700, '日语侧时长仍按假名数（3 假名 → 5700ms）');
  eq(G.flowDurationMs({ k: 'あ'.repeat(1) }), 4200, '日语侧 1 假名 → 4200ms');
}

/* ===================== 收尾 ===================== */
console.log('');
if (fails.length) {
  console.log('FAIL（' + fails.length + '）');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('✓ 全部通过 (' + pass + ')');
