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
    ok(rs.every((x, i) => i === 0 || rs[i - 1].n > x.n), '轮次场次逐轮减半 · ' + e.en);
    const tot = rs.reduce((a, x) => a + x.n, 0);
    ok(tot === rs[0].n * 2 - 1, '总场次 = 首轮场次 ×2 −1 · ' + e.en, String(tot));
    ok(rs.some((x) => x.played < x.n) || rs.every((x) => x.played === x.n), '未打完的轮次存在或全部完赛');
  }
} catch (e) { ok(false, '读取快照失败', String(e.message).slice(0, 120)); }

try { fs.unlinkSync(tmp); fs.unlinkSync(tiny); } catch {}

/* ===================== 结论 ===================== */
console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 条失败 / ' + (pass + fails.length) : '✓ 全部通过 (' + pass + ')'));
if (fails.length) {
  fails.forEach((f) => console.log('  × ' + f));
  process.exit(1);
}
