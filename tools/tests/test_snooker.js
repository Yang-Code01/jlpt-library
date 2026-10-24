/* 斯诺克排名解析器测试（无框架，node tools/tests/test_snooker.js）
 *
 * 只测 `tools/snooker.mjs` 的解析与落盘契约，不联网：用 --local 传一份假页面。
 * 上游页面改版时，这里会先红，比 CI 里「抓到 0 行」早一步。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const TOOL = path.join(ROOT, 'tools/snooker.mjs');
const DATA = path.join(ROOT, 'assets/snooker-data.js');

let pass = 0; const fails = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? '  ::  ' + extra : ''));
}

/* snooker.org 的真实行结构（2026-10 抓版）：15 个 td，class 会重复出现 */
function row(pos, chg, name, nat, pts, fmt) {
  return '<tr class="trow">' +
    `<td class="position">${pos}.</td>` +
    '<td class="chng-sort"><div class="rch">' +
    (chg ? `<div class="rc plus">${chg}</div>` : '<div class="rc">-</div>') +
    '</div></td>' +
    `<td class="change">${chg || ''}</td>` +
    `<td class="player"><a href="/player/${pos}.asp">${name}</a></td>` +
    `<td class="nationality"><img src="/flag.png" alt="" /> ${nat}</td>` +
    `<td class="change-2">${chg ? '+100' : ''}</td>` +
    `<td class="sum">${pts ? '+' + pts : '0'}</td>` +
    `<td class="points">0</td>` +
    `<td class="sum">${fmt || (pts ? pts.toLocaleString('en-GB') : '0')}</td>` +
    '<td class="irrelevant">x</td><td class="irrelevant">x</td>' +
    '<td class="irrelevant">x</td><td class="irrelevant">x</td>' +
    '<td class="irrelevant">x</td><td class="irrelevant">x</td>' +
    '</tr>';
}

const head = '<table><tr><th>#</th><th>Chng</th><th>&plusmn;</th><th>Name</th></tr>';
const html = head +
  row(1, '+0', 'Zhao&nbsp;Xintong', 'China', 1265550) +
  row(2, '+2', 'Wu Yize', 'China', 1238900) +
  row(3, '-1', 'Judd Trump', 'England', 1114050) +
  row(127, '', 'Mina&nbsp;Awad', 'Egypt', 0) +
  '</table>';

const tmp = path.join(os.tmpdir(), 'snooker-fixture-' + process.pid + '.html');
fs.writeFileSync(tmp, html, 'utf8');

/* ===================== A 解析 ===================== */
const r = spawnSync(process.execPath, [TOOL, '--local', tmp, '--stdout'], { cwd: ROOT, encoding: 'utf8' });
ok(r.status === 0, '解析假页面应成功', (r.stderr || '').slice(0, 300));
let data = null;
if (r.status === 0) {
  const src = r.stdout;
  const at = src.indexOf('window.SNOOKER');
  const brace = src.indexOf('{', at);
  const end = src.lastIndexOf('}');
  try { data = JSON.parse(src.slice(brace, end + 1)); } catch (e) { ok(false, '输出应是合法 JS 数据文件', e.message); }
}
if (data) {
  ok(Array.isArray(data.ranking) && data.ranking.length === 4, '应解析出 4 行（表头被跳过）', JSON.stringify(data.ranking && data.ranking.length));
  const [p1, c1, n1, nat1, s1] = data.ranking[0] || [];
  ok(p1 === 1, '第 1 行名次 = 1', String(p1));
  ok(n1 === 'Zhao Xintong', '&nbsp; 被归一成空格', JSON.stringify(n1));
  ok(nat1 === 'China', '国籍字段', JSON.stringify(nat1));
  ok(s1 === 1265550, '积分取原始值而非千分位值', String(s1));
  ok(data.ranking[1][1] === '+2', '名次变动取第一个 change 格（不是积分变动）', JSON.stringify(data.ranking[1][1]));
  ok(data.ranking[3][1] === '', '无变动时是空串（不是 "-"、不是 0）', JSON.stringify(data.ranking[3][1]));
  ok(data.ranking[3][4] === 0, '0 分选手保留在榜上', String(data.ranking[3][4]));
  ok(data.ranking.every((x) => Array.isArray(x) && x.length === 5), '每行固定 5 个字段');
  ok(typeof data.updated === 'string' && /^\d{4}-\d\d-\d\dT/.test(data.updated), 'updated 是 ISO 时间', String(data.updated));
  ok(data.source === 'snooker.org', 'source 标注数据源');
  ok(Array.isArray(data.calendar), 'calendar 恒为数组（无赛程表时是空数组）');
}

/* ===================== B 半页防护 ===================== */
const tiny = path.join(os.tmpdir(), 'snooker-tiny-' + process.pid + '.html');
fs.writeFileSync(tiny, head + row(1, '+0', 'A', 'England', 100) + '</table>', 'utf8');
const r2 = spawnSync(process.execPath, [TOOL, '--local', tiny, '--stdout', '--min', '100'], { cwd: ROOT, encoding: 'utf8' });
ok(r2.status !== 0, '只抓到 1 行时应中止（不写坏数据）', 'exit=' + r2.status);
ok(/应约\s*100\s*行以上/.test(r2.stderr || ''), '中止信息应说明预期行数下限', (r2.stderr || '').slice(0, 200));

/* ===================== C 已落盘的数据文件 ===================== */
if (fs.existsSync(DATA)) {
  const src = fs.readFileSync(DATA, 'utf8');
  const brace = src.indexOf('{', src.indexOf('window.SNOOKER'));
  const d = JSON.parse(src.slice(brace, src.lastIndexOf('}') + 1));
  ok(d.ranking.length >= 128, '正式数据应含全部 128 人', String(d.ranking.length));
  /* 上游允许并列（末尾大量 0 分选手会并列 125 / 127），所以只断言从 1 开始、非递减 */
  ok(d.ranking[0][0] === 1 && d.ranking.every((x, i) => i === 0 || x[0] >= d.ranking[i - 1][0]), '名次升序（允许并列）');
  const cn = d.ranking.slice(0, 16).filter((x) => x[3] === 'China').length;
  ok(cn >= 4, '前 16 里应有中国球员（当前 ' + cn + ' 位）');
  ok(d.season && d.season.label, 'season 标签存在');
  /* 两张中文查表：页面靠它们显示中文名与国籍，漏写会让整列退回英文 */
  ok(d.names && Object.keys(d.names).length >= 20, '带球员中文名表', String(Object.keys(d.names || {}).length));
  ok(d.nats && d.nats.China === '中国', '带国籍中文名表');
  ok(d.ranking.slice(0, 16).filter((x) => x[3] === 'China').every((x) => d.names[x[2]]), '中国球员都有中文名');
  /* 单赛季榜（One-Year List）：同一份快照里的第二张榜，形状与世界排名一致 */
  ok(Array.isArray(d.ranking1y) && d.ranking1y.length >= 100, '正式数据含单赛季榜', String((d.ranking1y || []).length));
  if (d.ranking1y && d.ranking1y.length) {
    ok(d.ranking1y.every((x) => Array.isArray(x) && x.length === 5), '单赛季榜每人 5 个字段');
    ok(d.ranking1y[0][0] === 1 && d.ranking1y.every((x, i) => i === 0 || x[0] >= d.ranking1y[i - 1][0]), '单赛季榜名次升序（允许并列）');
    ok(d.ranking1y.filter((x) => x[4] > 0).length > 50, '单赛季榜有积分（不是全 0）',
      d.ranking1y.filter((x) => x[4] > 0).length + ' / ' + d.ranking1y.length);
    /* 上游每行开头是「位置」，单赛季榜第一格不是 0 */
    ok(d.updated1y && d.updated1y.length >= 10, '带单赛季榜的抓取时间', String(d.updated1y));
  }
  if (d.calendar.length) {
    ok(d.calendar.every((e) => e.s && e.e && e.s <= e.e), '赛程日期区间合法');
    ok(d.calendar.every((e, i) => i === 0 || d.calendar[i - 1].s <= e.s), '赛程按开始日升序');
    ok(d.season.start === d.calendar[0].s && d.season.end === d.calendar[d.calendar.length - 1].e, '赛季边界与赛程首尾一致');
  }
}

/* ===================== D 快照里的轮次结构 =====================
   单站对阵页解析出来的 rounds 直接决定进度图：轮次名、场次、是否已打完。
   这里只查已提交的快照（生成器跑过才有），不联网。 */
try {
  const saved = fs.readFileSync(DATA, 'utf8');
  const at = saved.indexOf('window.SNOOKER');
  const d2 = JSON.parse(saved.slice(saved.indexOf('{', at), saved.lastIndexOf('}') + 1));
  const withR = (d2.calendar || []).filter((e) => e.rounds && e.rounds.length);
  ok(withR.length >= 1, '快照里至少有一站带轮次结构', String(withR.length));
  for (const e of withR) {
    const rs = e.rounds;
    ok(rs.every((x) => x.n > 0 && x.cn && x.played <= x.n), '轮次场次合法 · ' + e.en);
    /* 轮次表有两种形状，不能用一个「不递增」一刀切：
       · 正常站：8,4,2,1（逐级对半）
       · 带预赛的站：3,64,32,16,8,4,2,1（131 强先打 3 场 play-in，再进 128 强）——
         预赛轮的场次**比后面少**，所以旧断言「不递增」在这类站上必然误报（2026-10 的
         International Championship 就踩了这条，CI 红、main 也红）。
       真正的不变式是三条：主赛段从末尾起逐级对半、末轮是决赛 1 场、预赛轮不超过它喂的那一轮。 */
    let k = 0;
    for (let i = rs.length - 1; i > 0; i--) {
      if (rs[i - 1].n === rs[i].n * 2) k = i - 1; else break;
    }
    const mainDraw = rs.slice(k);
    ok(rs[rs.length - 1].n === 1, '末轮是决赛（1 场） · ' + e.en, String(rs[rs.length - 1].n));
    ok(mainDraw.every((x, i) => i === 0 || mainDraw[i - 1].n === x.n * 2),
      '主赛段逐级对半 · ' + e.en, mainDraw.map((x) => x.n).join(','));
    ok(rs.slice(0, k).every((x) => x.n <= rs[k].n),
      '预赛轮场次不超过它所喂的那一轮 · ' + e.en, rs.slice(0, k).map((x) => x.n).join(','));
    const tot = mainDraw.reduce((a, x) => a + x.n, 0);
    ok(tot === rs[k].n * 2 - 1, '主赛段总场次 = 首轮场次 ×2 −1 · ' + e.en, String(tot));
    ok(rs.some((x) => x.played < x.n) || rs.every((x) => x.played === x.n), '未打完的轮次存在或全部完赛');
  }
} catch (e) { ok(false, '读取快照失败', String(e.message).slice(0, 120)); }

/* ===================== E 单站对阵页 → 场级数据 =====================
   用真实抓下的两页做样本（tools/tests/fixtures/，已入库）：
   北爱尔兰站是「赛周中·后程全是待定」，上海站是「已完赛·可完整成树」。
   上游改版时这里先红，比线上树空掉早一步。 */
const FIX_NI = path.join(ROOT, 'tools/tests/fixtures/snooker-event-niopen.html');
const FIX_SH = path.join(ROOT, 'tools/tests/fixtures/snooker-event-shanghai.html');
const TREE_JS = path.join(ROOT, 'assets/snooker-tree.js');

if (fs.existsSync(FIX_NI) && fs.existsSync(FIX_SH)) {
  const { pathToFileURL } = require('url');
  const probe = `
import { parseEvent, last16Id, frozen } from ${JSON.stringify(pathToFileURL(TOOL).href)};
import fs from 'node:fs';
const ni = parseEvent(fs.readFileSync(${JSON.stringify('FIX_NI')}.replace('FIX_NI', ${JSON.stringify(FIX_NI)}), 'utf8'));
const sh = parseEvent(fs.readFileSync(${JSON.stringify(FIX_SH)}, 'utf8'));
const fin = sh.rounds.find((r) => r.n === 1);
const doneEv = { e: '2026-09-01', rounds: sh.rounds, matches: sh.matches };
const noFinal = { e: '2026-09-01', rounds: sh.rounds, matches: sh.matches.filter((m) => m.r !== fin.id) };
const liveEv = { e: '2026-10-25', rounds: ni.rounds, matches: ni.matches };
console.log(JSON.stringify({
  ni: { m: ni.matches.length, r: ni.rounds.length,
        tbd: ni.matches.filter((m) => m.st === 'tbd').length,
        timed: ni.matches.filter((m) => m.ses && m.ses.length).length },
  sh: { m: sh.matches.length, done: sh.matches.filter((m) => m.st === 'done').length, cut: last16Id(sh.rounds) },
  frozenDone: frozen(doneEv), frozenNoFinal: frozen(noFinal), frozenLive: frozen(liveEv)
}));`;
  const pr = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  ok(pr.status === 0, '能 import 生成器并解析样本页', (pr.stderr || '').slice(0, 300));
  let ev = null;
  try { ev = JSON.parse(pr.stdout); } catch (e) { ok(false, '样本解析结果应是 JSON', (pr.stdout || '').slice(0, 200)); }
  if (ev) {
    ok(ev.ni.m === 127, '北爱站解析出 127 场', String(ev.ni.m));
    ok(ev.ni.r === 8, '北爱站 8 个轮次', String(ev.ni.r));
    ok(ev.ni.tbd > 0, '赛周中后程有「待定」场次', String(ev.ni.tbd));
    ok(ev.ni.timed > 0, '有开赛时刻的场次被留下（赛后上游会撤掉）', String(ev.ni.timed));
    ok(ev.sh.m === 23 && ev.sh.done === 23, '上海站 23 场且全部有比分', ev.sh.m + '/' + ev.sh.done);
    ok(ev.sh.cut === 8, '冻结切点 = 16 强的轮次 id', String(ev.sh.cut));
    /* 冻结必须等到决赛打完：按日期一刀切会把跨夜的决赛比分永久切掉 */
    ok(ev.frozenDone === true, '决赛有比分 → 可冻结');
    ok(ev.frozenNoFinal === false, '过了结束日但决赛没比分 → 不许冻结');
    ok(ev.frozenLive === false, '赛周内 → 不许冻结');
  }

  /* ---- 天梯图几何：同一条不变式「每轮场次 × span = 总行数」，决赛必然落在正中 ---- */
  const vm = require('vm');
  const ctx = { Intl, Date, Math, JSON, String, Number, Object, Array, RegExp, isNaN, parseInt, parseFloat, encodeURIComponent };
  ctx.window = ctx;
  vm.createContext(ctx);
  try {
    vm.runInContext(fs.readFileSync(TREE_JS, 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(DATA, 'utf8'), ctx);
  } catch (e) { ok(false, '天梯图组件应可独立加载', e.message); }
  const T = ctx.SnookerTree, DD = ctx.SNOOKER;
  ok(T && typeof T.render === 'function', '天梯图组件导出 render');
  if (T && DD) {
    const eSH = DD.calendar.find((x) => x.en === 'Shanghai Masters');
    const eNI = DD.calendar.find((x) => x.en === 'Northern Ireland Open');
    if (eSH && eSH.matches && eSH.matches.length) {
      const g = T.geometry(T.buildTree(eSH), 8);
      ok(g.rows === 8, '上海（16 强起）8 行', String(g.rows));
      ok(g.cols.length === 4 && g.cols.every((c) => c.trusted), '上海 4 轮，每轮场次 × span = 行数',
        g.cols.map((c) => c.n + '/' + c.span).join(','));
      ok(g.finalCenter === 4, '决赛落在正中（4）', String(g.finalCenter));
      ok(g.linked === 14 && g.inferred === 0 && g.orphans === 0,
        '14 条连线全部由「胜者出现在父场」核实', g.linked + '/' + g.inferred + '/' + g.orphans);
      ok(g.champion === 'Judd Trump', '冠军路径可识别', String(g.champion));
      const hv = T.render(eSH, { fromId: 8, dir: 'v' });
      const hh = T.render(eSH, { fromId: 8, dir: 'h' });
      ok(/tn-card/.test(hv) && !/NaN/.test(hv), '纵向渲染：有卡片、无 NaN');
      ok(/tn-card/.test(hh) && !/NaN/.test(hh), '横向渲染：有卡片、无 NaN');
      ok((hv.match(/<path /g) || []).length === 14, '纵向渲染画了 14 条连线',
        String((hv.match(/<path /g) || []).length));
    }
    if (eNI && eNI.matches && eNI.matches.length) {
      const g2 = T.geometry(T.buildTree(eNI), 7);
      ok(g2.rows === 32 && g2.cols.length === 6, '北爱（64 强起）32 行 × 6 轮', g2.rows + 'x' + g2.cols.length);
      ok(g2.cols.every((c) => c.trusted), '北爱每列场次 × span = 行数（列容量自洽）',
        g2.cols.map((c) => c.n + '/' + c.span).join(','));
      /* 赛周里陆续出比分会让实线从 0 往上长，所以这里只锁与快照无关的不变式；
         「只挂一个事实孩子时不偏半格」另用合成签表钉死（下面 D 段）。 */
      ok(g2.finalCenter === g2.rows / 2, '北爱决赛落在正中（' + g2.rows / 2 + '）', String(g2.finalCenter));
      ok(g2.inferred > 0, '未出胜者的场次仍画虚线', g2.inferred + '/' + (g2.nodes.length - 1));
      ok(g2.orphans === 0, '没有落不下位置的场次', String(g2.orphans));
      ok(!/NaN/.test(T.render(eNI, { fromId: 7, dir: 'v' })), '北爱纵向渲染无 NaN');
    }

    /* ---- D2. 半格回归：父场只挂上一个事实孩子时，位置不能偏半格 ----
       2026-10-18 快照就是这个形态（首轮 32 场里刚打完 1 场，其余待定）：
       父场只拿「已挂上的那个孩子」取中心 → 每层偏 0.5 行 → 决赛中心落到 16.5、
       整棵树上半格。合成一张 4/2/1 的小签表把它钉死，不依赖快照。 */
    {
      const mm = (r, p1, p2, s1, s2) => ({
        r: r, p1: p1 ? { n: p1 } : null, p2: p2 ? { n: p2 } : null,
        s1: s1 == null ? null : s1, s2: s2 == null ? null : s2,
        ses: [], day: '', st: s1 == null ? 'sched' : 'done'
      });
      const synth = {
        rounds: [{ id: 7, n: 4, played: 1 }, { id: 8, n: 2, played: 0 }, { id: 9, n: 1, played: 0 }],
        matches: [
          mm(7, null, null, null, null), mm(7, null, null, null, null),
          mm(7, 'A', 'B', 4, 2), mm(7, null, null, null, null),      /* 只有第 3 场打完 */
          mm(8, null, null, null, null),
          mm(8, 'A', null, null, null),                             /* 胜者 A 已进父场，另一个待定 */
          mm(9, null, null, null, null)
        ]
      };
      const g3 = T.geometry(T.buildTree(synth), 7);
      ok(g3.rows === 4 && g3.cols.length === 3, '合成签表 4 行 × 3 轮', g3.rows + 'x' + g3.cols.length);
      ok(g3.cols.every((c) => c.trusted), '合成签表每列容量自洽',
        g3.cols.map((c) => c.n + '/' + c.span).join(','));
      ok(g3.cols[1].nodes[1].mid === 3, '只挂一个事实孩子时父场仍居中（3）', String(g3.cols[1].nodes[1].mid));
      ok(g3.finalCenter === 2, '合成签表决赛落在正中（2）', String(g3.finalCenter));
      ok(g3.linked === 1, '只有一条事实边画实线', String(g3.linked));
    }
  }
}

/* ============ G. 冻结裁剪 + 抓取频率（三个踩过的坑） ============ */
{
  /* 造一个「16 强 8 + 8 强 4 + 半决赛 2 + 决赛 1 + 外卡 2」的站：
     外卡轮的胜者会出现在 16 强里（所以它连得上，不是孤儿），但它比 16 强更浅，
     裁剪时必须靠「离决赛的层数」丢掉它，而不是靠「场数 ≤8」或轮次 id。 */
  const m = (r, a, b, sa, sb) => ({ r, p1: { n: a }, p2: { n: b }, s1: sa, s2: sb, st: 'done', ses: [] });
  const ms = [
    m(20, 'W1', 'X1', 4, 2), m(20, 'W2', 'X2', 4, 3),           /* 外卡轮：2 场 */
    m(10, 'A', 'W1', 5, 1), m(10, 'B', 'W2', 5, 2), m(10, 'C', 'F', 5, 0), m(10, 'D', 'G', 5, 1),
    m(10, 'E', 'H', 5, 2), m(10, 'I', 'J', 5, 3), m(10, 'K', 'L', 5, 4), m(10, 'M', 'N', 5, 0),
    m(11, 'A', 'E', 6, 3), m(11, 'C', 'I', 6, 4), m(11, 'B', 'K', 6, 2), m(11, 'D', 'M', 6, 1),
    m(12, 'A', 'C', 6, 5), m(12, 'B', 'D', 6, 2),
    m(15, 'A', 'B', 10, 6),
  ];
  const code = "import { cutFrozenMatches, dueAt, fetchBucket } from " + JSON.stringify(new URL('file://' + TOOL).href) + ';'
    + 'const ms = JSON.parse(process.argv[1]);'
    + 'const out = cutFrozenMatches(ms);'
    + 'const t = new Date().toISOString().slice(0,10);'
    + 'const day = (n) => { const d = new Date(Date.parse(t + "T00:00:00Z") + n * 86400000); return d.toISOString().slice(0,10); };'
    + 'const far = dueAt({ s: day(30), e: day(35) });'
    + 'const week = dueAt({ s: day(3), e: day(9) });'
    + 'const past = dueAt({ s: day(-10), e: day(-3) });'
    + 'const live = dueAt({ s: day(-1), e: day(6) });'
    + 'const b1 = fetchBucket(1e12, 6 * 3600 * 1000), b2 = fetchBucket(1e12 + 60e3, 6 * 3600 * 1000);'
    + 'process.stdout.write(JSON.stringify({ n: out.length, rounds: [...new Set(out.map(x => x.r))], far, week, past, live, b1, b2 }));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, '--', JSON.stringify(ms)], { encoding: 'utf8' });
  let got = null;
  try { got = JSON.parse(r.stdout || 'null'); } catch {}
  ok(got && got.n === 15, '冻结裁剪留 15 场（8+4+2+1）', got ? String(got.n) : (r.stderr || '').slice(0, 300));
  ok(got && got.rounds.length === 4 && !got.rounds.includes(20), '外卡轮被丢掉、只留决赛起四轮', got ? JSON.stringify(got.rounds) : '');
  ok(got && got.far === null, '赛程 30 天外的站不抓（dueAt = Infinity）', got ? String(got.far) : '');
  ok(got && got.week === 6 * 3600 * 1000, '开赛前一周 6 小时一次', got ? String(got.week) : '');
  ok(got && got.past === 24 * 3600 * 1000, '已结束但仍没数据的站每天补一次（不能靠全局 updated）', got ? String(got.past) : '');
  ok(got && got.live === 10 * 60 * 1000, '赛周内 10 分钟一次', got ? String(got.live) : '');
  ok(got && got.b1 === got.b2, '同一时间桶里的 fetchedAt 相同（不会为了时间戳反复提交）', got ? got.b1 + ' / ' + got.b2 : '');
}

try { fs.unlinkSync(tmp); fs.unlinkSync(tiny); } catch {}

/* ============ H. 单赛季榜（template=33）的解析契约 ============
 * 上游那一页把两列（num / avg）写成 HTML 注释：`<!-- td class="num" >0</td> <td class="avg" ></td -->`。
 * 注释里结尾是 `</td -->` 而不是 `</td>`，不先剔注释就会把后面的 sum 格吞掉，
 * 结果整张榜的积分全是 0（2026-10 真踩过）。这里用合成页钉住。 */
{
  const y1 = (pos, chg, name, nat, pts) =>
    '<tr>' +
      '<td class="position">' + pos + '</td>' +
      '<td class="change">' + chg + '</td>' +
      '<td class="position">' + pos + '</td>' +
      '<td class="seed">0</td>' +
      '<td class="player">' + name + '</td>' +
      '<td class="nationality">' + nat + '</td>' +
      '<!-- <td class="num" >0</td> <td class="avg" ></td -->' +
      '<td class="sum">' + pts + '</td>' +
      '<td class="change">' + chg + '</td>' +
    '</tr>';
  const yHtml = '<table id="oneyearrankings"><tr><th>Pos</th><th>&plusmn;</th><th>Name</th></tr>' +
    y1(1, '', 'Mark Selby', 'England', '348&nbsp;350') +
    y1(2, '', 'Chang Bingyu', 'China', '207&nbsp;100') +
    y1(3, '+28', 'Wu Yize', 'China', '204&nbsp;000') +
    y1(4, '-2', 'Nobody  Here', 'Egypt', '0') +
    '</table>';
  const yFile = path.join(os.tmpdir(), 'snooker-1y-' + process.pid + '.html');
  fs.writeFileSync(yFile, yHtml);
  /* 配套的两年榜小页：只验「同一次运行里两张榜互不干扰」 */
  const wFile = path.join(os.tmpdir(), 'snooker-w-' + process.pid + '.html');
  fs.writeFileSync(wFile, head + row(1, '+0', 'Zhao Xintong', 'China', 1265550) +
    row(2, '+2', 'Wu Yize', 'China', 1238900) + '</table>');

  const run = (extra) => spawnSync(process.execPath,
    [TOOL, '--local', wFile, '--local-1y', extra === null ? yFile : extra, '--stdout', '--min', '1'],
    { cwd: ROOT, encoding: 'utf8' });

  const r3 = run(null);
  ok(r3.status === 0, '能解析单赛季榜并产出数据', (r3.stderr || '').slice(0, 300));
  /* --stdout 打的是完整数据文件（window.SNOOKER = {...}），按 A 段同样方式切出 JSON */
  const jsonOf = (out) => {
    const at = String(out).indexOf('window.SNOOKER');
    const brace = String(out).indexOf('{', at);
    return JSON.parse(String(out).slice(brace, String(out).lastIndexOf('}') + 1));
  };
  let j = null;
  try { j = jsonOf(r3.stdout); } catch (e) { ok(false, '单赛季榜结果应是 JSON', String(e.message)); }
  if (j) {
    const one = j.ranking1y || [];
    ok(one.length === 4, '单赛季榜解析出 4 行', String(one.length));
    ok(one[0] && one[0][4] === 348350, 'HTML 注释里的 num/avg 不能吞掉总积分', JSON.stringify(one[0]));
    ok(one[2] && one[2][1] === '+28', '单赛季榜保留名次变动', JSON.stringify(one[2]));
    ok(one[3] && one[3][2] === 'Nobody Here', '球员名里的连续空格归一', JSON.stringify(one[3]));
    ok(one[3] && one[3][4] === 0, '0 分球员保留在榜上', JSON.stringify(one[3]));
    ok((j.ranking || []).length === 2, '同一次运行里两年榜照旧解析', String((j.ranking || []).length));
    ok(typeof j.updated1y === 'string' && j.updated1y.length >= 10, '抓到单赛季榜时写 updated1y', String(j.updated1y));
  }

  /* 单赛季榜抓取失败只降级、不失败：世界排名依然是完整结果 */
  const r4 = run(path.join(os.tmpdir(), 'snooker-1y-missing-' + process.pid + '.html'));
  ok(r4.status === 0, '单赛季榜抓不到时不中断生成', (r4.stderr || '').slice(0, 300));
  ok(/单赛季榜本地页读取失败/.test(r4.stderr || ''), '本地页读不到时只报警告', (r4.stderr || '').trim().slice(0, 160));
  let j4 = null;
  try { j4 = jsonOf(r4.stdout); } catch (e) { ok(false, '降级后的结果应是 JSON', String(e.message)); }
  if (j4) ok(Array.isArray(j4.ranking1y) && j4.ranking.length === 2,
    '降级时 ranking1y 仍是数组、两年榜不受影响', JSON.stringify([j4.ranking1y.length, j4.ranking.length]));
  try { fs.unlinkSync(yFile); fs.unlinkSync(wFile); } catch {}
}

/* ============ F. 已入库快照必须满足落盘契约（不联网） ============
 * `--check` 是联网版的守门人（本机被 Cloudflare 挡，跑不了），所以这里用
 * checkData() 对**已提交的** assets/snooker-data.js 做同一套契约校验：
 * 场次指向的轮次存在、比分成对、开赛时刻可解析、已结束站 ≤15 场。
 * 上游改版或手改快照会先在这里红。 */
{
  const code = [
    "import fs from 'fs'; import vm from 'vm';",
    "import { checkData } from " + JSON.stringify(new URL('file://' + TOOL).href) + ';',
    "const ctx = { window: {} }; vm.createContext(ctx);",
    "vm.runInContext(fs.readFileSync(" + JSON.stringify(DATA) + ", 'utf8'), ctx);",
    "const bad = checkData(ctx.window.SNOOKER);",
    "process.stdout.write(JSON.stringify(bad));",
  ].join(String.fromCharCode(10));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  let bad = null;
  try { bad = JSON.parse(r.stdout || 'null'); } catch {}
  ok(r.status === 0, 'checkData 可对已入库快照运行', (r.stderr || '').slice(0, 300));
  ok(Array.isArray(bad), 'checkData 应返回问题清单', String(r.stdout).slice(0, 200));
  ok(Array.isArray(bad) && bad.length === 0, '已入库快照满足落盘契约',
    Array.isArray(bad) ? bad.slice(0, 4).join(' | ') : '');

  /* 手工总奖金表：能解析、每条都是正数（键用 id 或英文站名都行） */
  const FUND = path.join(ROOT, 'tools/snooker-prize-fund.json');
  let fund = null;
  try { fund = JSON.parse(fs.readFileSync(FUND, 'utf8')); } catch (e) { /* 下面的断言会报 */ }
  ok(fund && typeof fund === 'object', '总奖金手工表可解析', String(!fund));
  const entries = Object.keys(fund || {}).filter((k) => k.charAt(0) !== '_').map((k) => [k, fund[k]]);
  const badVal = entries.filter(([, v]) => {
    const n = typeof v === 'number' ? v : (v && v.value);
    return !(typeof n === 'number' && n > 0);
  });
  ok(entries.length >= 20 && badVal.length === 0, '总奖金手工表每条都是正数',
    entries.length + ' 条，异常：' + badVal.map(([k]) => k).join(','));
}

/* ===================== 结论 ===================== */
console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 条失败 / ' + (pass + fails.length) : '✓ 全部通过 (' + pass + ')'));
if (fails.length) {
  fails.forEach((f) => console.log('  × ' + f));
  process.exit(1);
}
