#!/usr/bin/env node
/*
 * 斯诺克信息区数据生成器：抓 snooker.org 的排名 + 赛历 + 冠军 → 写 assets/snooker-data.js
 *
 *   node tools/snooker.mjs                  # 抓 → 数据有变才写文件（无变则原样退出 0）
 *   node tools/snooker.mjs --check          # 只比对不写；有漂移退出 1（给 CI 用）
 *   node tools/snooker.mjs --local <file>   # 用本地已存的页面代替联网（离线调试 / 单测）
 *   --local-cal <f> --local-fin <f>          # 同上，分别替换赛历页 / 冠军页
 *   node tools/snooker.mjs --local <f> --stdout      # 打印生成的 JS，不落盘
 *   --min <n>   少于 n 行排名视为抓坏并中止（默认：线上 100，--local 1）
 *
 * 为什么产出是 .js 而不是 .json：站点要能用 file:// 双击打开，那时 fetch('*.json')
 * 会被 CORS 拦死；<script src> 不受此限，所以数据以 window.SNOOKER = {...} 注入。
 * 抓取只发生在构建/CI 这一侧，页面自身不联网。
 *
 * 三个上游（都是同一家的静态 HTML 表格）：
 *   template=31  两年滚动排名（128 人）
 *   template=2   本赛季赛历（62 行，含资格赛 / Q Tour / 女子 / 元老；本站只取 Main 正赛）
 *   template=7   已结束各站的冠军与比分
 * 赛历/冠军抓不到不算致命（页面退化成「只有排名」），排名抓不到才算失败。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets/snooker-data.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const URL_RANK = 'https://www.snooker.org/res/index.asp?template=31';
const URL_CAL = 'https://www.snooker.org/res/index.asp?template=2';
const URL_FIN = 'https://www.snooker.org/res/index.asp?template=7';
/* snooker.org 直连可能撞 Cloudflare 人机校验；calengoo 每天从它的数据生成一份 ICS 镜像，作降级源 */
const URL_ICS = 'http://calengoo.de/snooker/snooker.ics';
/* 单站对阵页：比分之外还给了轮次分组（Round 1 / Quarterfinals / Final…）与每场开赛时间，
   进度图要的「打到第几轮、每轮几场、当天排哪一轮」都从这里来。 */
const URL_EVENT = (id) => `https://www.snooker.org/res/index.asp?event=${id}`;
const SEASON_LABEL = '2026/27';

/* 球员中文名：不做机翻，查不到就回退英文 */
const CN_NAME = {
  'Zhao Xintong': '赵心童', 'Wu Yize': '吴宜泽', 'Xiao Guodong': '肖国栋', 'Ding Junhui': '丁俊晖',
  'Zhou Yuelong': '周跃龙', 'Chang Bingyu': '常冰玉', 'Zhang Anda': '张安达', 'Si Jiahui': '斯佳辉',
  'Yuan Sijun': '袁思俊', 'Lei Peifan': '雷佩凡', 'Pang Junxu': '庞俊旭', 'Xu Si': '徐思',
  'He Guoqiang': '何国强', 'Fan Zhengyi': '范争一', 'Liu Hongyu': '刘宏宇', 'Long Zehuang': '龙泽煌',
  'Jiang Jun': '江俊', 'Lyu Haotian': '吕昊天', 'Gong Chenzhi': '巩晨智', 'Huang Jiahao': '黄佳浩',
  'Judd Trump': '贾德·特鲁姆普', 'Neil Robertson': '尼尔·罗伯逊', 'Mark Selby': '马克·塞尔比',
  'John Higgins': '约翰·希金斯', 'Shaun Murphy': '肖恩·墨菲', 'Mark J Williams': '马克·威廉姆斯',
  'Kyren Wilson': '凯伦·威尔逊', 'Barry Hawkins': '巴里·霍金斯', 'Chris Wakelin': '克里斯·沃克林',
  'Mark Allen': '马克·艾伦', "Ronnie O'Sullivan": '罗尼·奥沙利文', 'Ali Carter': '阿里·卡特',
  'Jack Lisowski': '杰克·利索夫斯基', 'Stuart Bingham': '斯图尔特·宾汉姆',
  'Mark Davis': '马克·戴维斯', 'Tom Ford': '汤姆·福德', 'Ricky Walden': '里基·沃顿',
  'David Gilbert': '大卫·吉尔伯特', 'Stephen Maguire': '斯蒂芬·马奎尔', "Joe O'Connor": '乔·奥康纳',
  'Jak Jones': '杰克·琼斯', 'Noppon Saengkham': '努蓬·赛恩坎', 'Bai Yulu': '白雨露',
  'Gary Wilson': '加里·威尔逊', 'Anthony McGill': '安东尼·麦克吉尔', 'David Gilbert ': '大卫·吉尔伯特',
};
const NAT_CN = {
  England: '英格兰', China: '中国', Scotland: '苏格兰', Wales: '威尔士',
  'N.Ireland': '北爱尔兰', 'Northern Ireland': '北爱尔兰', Australia: '澳大利亚',
  'Hong Kong': '中国香港', Ireland: '爱尔兰', Belgium: '比利时', Thailand: '泰国',
  Iran: '伊朗', 'Rep. of Ireland': '爱尔兰', Cyprus: '塞浦路斯', India: '印度',
  Egypt: '埃及', Malta: '马耳他', Switzerland: '瑞士', France: '法国', Germany: '德国',
  Poland: '波兰', Ukraine: '乌克兰', Brazil: '巴西', Pakistan: '巴基斯坦',
  Malaysia: '马来西亚', 'Saudi Arabia': '沙特', UAE: '阿联酋', Norway: '挪威',
  Finland: '芬兰', Sweden: '瑞典', Israel: '以色列', Morocco: '摩洛哥',
  'New Zealand': '新西兰', Canada: '加拿大', USA: '美国', Austria: '奥地利',
  Bulgaria: '保加利亚', Hungary: '匈牙利', Latvia: '拉脱维亚', Lithuania: '立陶宛',
  Netherlands: '荷兰', Spain: '西班牙', Italy: '意大利', Turkey: '土耳其',
};

/* 赛事中文名：查不到就回退英文，不猜 */
const CN_EVENT = {
  'Championship League': '冠军联赛',
  'Shanghai Masters': '上海大师赛',
  'China Open': '中国公开赛',
  'Wuhan Open': '武汉公开赛',
  'Shenzhen Open': '深圳公开赛',
  'British Open': '英国公开赛',
  'English Open': '英格兰公开赛',
  'Northern Ireland Open': '北爱尔兰公开赛',
  'International Championship': '国际锦标赛',
  'Champion of Champions': '冠中冠',
  'UK Championship': '英锦赛',
  'Shoot Out': '单局限时赛',
  'Scottish Open': '苏格兰公开赛',
  'Masters': '大师赛',
  'German Masters': '德国大师赛',
  'Welsh Open': '威尔士公开赛',
  'World Grand Prix': '世界大奖赛',
  'Players Championship': '球员锦标赛',
  'World Open': '世界公开赛',
  'Tour Championship': '巡回锦标赛',
  'World Championship': '世锦赛',
};

/* ---------------- 通用 ---------------- */
const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function text(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&#8209;/g, '-')
    .replace(/&[a-z#0-9]+;/gi, (m) => (m in ENT ? ENT[m] : m))
    .replace(/\s+/g, ' ')
    .trim();
}
function cellClass(attr) {
  const m = /class\s*=\s*"([^"]*)"/i.exec(attr || '');
  return m ? m[1].toLowerCase() : '';
}
function cells(tr) {
  return [...String(tr).matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)].map((m) => [cellClass(m[1]), text(m[2])]);
}

/* ---------------- template=31：两年滚动排名 ---------------- */
/**
 * 每行 15 个 <td>，但同名 class 会重复（change 两次：名次变动 / 积分变动；sum 两次：
 * 原始值与千分位值），所以按 class 取「第一次出现」的那格。
 * 返回 [[名次, 变动, 英文名, 国籍, 积分], ...]，按名次升序。
 */
function parseRank(html) {
  const out = [];
  for (const tr of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cs = cells(tr[1]);
    if (!cs.length) continue;
    let pos = 0, chg = '', name = '', nat = '', pts = 0;
    let chgTaken = false, ptsTaken = false;
    for (const [cls, t] of cs) {
      if (!pos && cls.includes('position')) { pos = parseInt(t, 10); continue; }
      if (cls.includes('change') && !chgTaken) { chgTaken = true; chg = /^[+-]/.test(t) ? t : ''; continue; }
      if (cls.includes('player') && !name) { name = t; continue; }
      if (cls.includes('nationality') && !nat) { nat = t; continue; }
      if (cls.includes('sum') && !ptsTaken) { ptsTaken = true; pts = parseInt(t.replace(/[^\d]/g, ''), 10) || 0; continue; }
    }
    if (!pos || !name) continue;
    out.push([pos, chg, name, nat, pts]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/* ---------------- template=2：本赛季赛历 ---------------- */
function parseCalendar(html) {
  /* 注意：`id="diary"` 在 <body> 上也有一份（站点给 body 挂了这个 id），
     所以不能直接搜 id，要先落到表格自己的 class 上 */
  const src = String(html);
  let at = src.indexOf('class="display matches"');
  if (at < 0) at = src.indexOf('id="diary"', src.indexOf('</head>'));
  if (at < 0) return [];
  const seg = src.slice(at, src.indexOf('</table>', at));
  const out = [];
  for (const tr of seg.split(/<tr/i).slice(1)) {
    const cs = cells(tr);
    if (cs.length < 14) continue;
    const v = cs.map((x) => x[1]);
    const s = v[2].replace(/\./g, '-');
    const e = v[3].replace(/\./g, '-');
    if (!/^\d{4}-\d\d-\d\d$/.test(s) || !/^\d{4}-\d\d-\d\d$/.test(e)) continue;
    const id = (/event=(\d+)/.exec(tr) || [])[1] || '';
    out.push({
      id, tour: v[0], s, e, en: v[5], type: v[6], venue: v[7],
      city: v[8], nat: v[9],
      prize: parseInt(v[11], 10) || 0,
      field: parseInt(v[13], 10) || 0,
    });
  }
  return out;
}

/* 只留 Main Tour 的正赛；冠军联赛的 8 个 Group 行合并成一站 */
function pickEvents(rows) {
  const keep = rows.filter((r) => r.tour === 'Main' && r.type !== 'Qualifying' && r.en);
  const out = [];
  let cl = null;
  for (const r of keep) {
    if (/^Championship League - /.test(r.en)) {
      if (!cl) { cl = { ...r, en: 'Championship League', field: 0 }; out.push(cl); }
      else {
        if (r.s < cl.s) cl.s = r.s;
        if (r.e > cl.e) cl.e = r.e;
        if (r.field > cl.field) cl.field = r.field;
      }
      continue;
    }
    out.push(r);
  }
  return out;
}

/* ---------------- 单站对阵页：轮次 → 场次 / 比分 / 日期 ----------------
   返回按时间顺序（首轮→决赛）的数组；只有日期能确定时才带 s/e，未排期的轮次留空。 */
const ROUND_CN = { 'Quarterfinals': '8 强', 'Semifinals': '半决赛', 'Final': '决赛' };
function parseRounds(html) {
  const t = html.match(/<table[^>]*class="display matches"[^>]*>[\s\S]*?<\/table>/);
  if (!t) return [];
  const out = [];
  let cur = null;
  for (const tr of t[0].match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const head = tr.match(/<a name="r\d+"><\/a>\s*<span class="round">([^<]+)<\/span>/);
    if (head) {
      cur = { en: head[1].trim(), bo: parseInt((tr.match(/Best of (\d+)/) || [])[1], 10) || 0, n: 0, played: 0, ds: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const tds = tr.match(/<td[^>]*>/g) || [];
    if (tds.length < 6) continue;
    cur.n++;
    const d = tr.match(/\d{4}-\d{2}-\d{2}/);
    if (d) cur.ds.push(d[0]);
    const sc = tr.match(/class="score[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (sc && /\d/.test(sc[1].replace(/<[^>]*>/g, ''))) cur.played++;
  }
  return out.reverse().map((r) => {
    const ds = r.ds.sort();
    const left = r.n * 2;   /* 本轮场数 ×2 = 打完这轮的参赛人数（64 场 → 128 强） */
    return {
      en: r.en,
      cn: ROUND_CN[r.en] || (left >= 16 ? left + ' 强' : r.en),
      bo: r.bo,
      n: r.n,
      played: r.played,
      s: ds.length ? ds[0] : '',
      e: ds.length ? ds[ds.length - 1] : '',
    };
  }).filter((r) => r.n > 0);
}

/* ---------------- template=7：已结束各站的冠军 ---------------- */
function parseFinals(html) {
  const map = new Map();
  for (const tr of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const v = cells(tr[1]).map((x) => x[1]);
    if (v.length < 13) continue;
    const name = v[5];
    if (!name || !v[9]) continue;
    map.set(name, { winner: v[9], nat: v[10], score: v[11], runner: v[12] });
  }
  return map;
}

/* ---------------- ICS 降级源（calengoo 从 snooker.org 每日生成） ---------------- */
function parseIcs(txt) {
  const day = (raw) => {
    const m = /(\d{4})(\d{2})(\d{2})/.exec(raw || '');
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  };
  const prev = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const out = [];
  for (const blk of String(txt).split('BEGIN:VEVENT').slice(1)) {
    const g = (k) => {
      const m = new RegExp('^' + k + '[^:\\r\\n]*:(.*)$', 'mi').exec(blk);
      return m ? m[1].trim() : '';
    };
    const en = g('SUMMARY');
    const desc = g('DESCRIPTION').replace(/\\n/g, ' ');
    const s = day(g('DTSTART'));
    const e = day(g('DTEND'));
    if (!en || !s) continue;
    /* 只保留职业巡回赛正赛：Q Tour / 女子 / 元老 / 资格赛都不要 */
    if (/#QTour|#Women|#Seniors|Qualifier/i.test(en + ' ' + desc)) continue;
    if (/Qualif|Women|Seniors/i.test(en)) continue;
    const loc = g('LOCATION').replace(/\\,/g, ',');
    const parts = loc.split(',').map((x) => x.trim()).filter(Boolean);
    out.push({
      id: '',
      tour: 'Main',
      s,
      e: e ? prev(e) : s,          /* ICS 的 DTEND 是「次日」，减一天才是真实结束日 */
      en: en.replace(/ - (Group|Round) .*$/i, ''),
      type: /Type:\s*Invitational/i.test(desc) ? 'Invitational' : 'Ranking',
      venue: '',
      city: parts.length > 1 ? parts[parts.length - 2] : '',
      nat: parts.length ? parts[parts.length - 1] : '',
      prize: 0,
      field: 0,
    });
  }
  /* 同名多段（冠军联赛的各个 Group）合并成一站 */
  const byName = new Map();
  for (const r of out) {
    const k = r.en;
    if (!byName.has(k)) byName.set(k, { ...r });
    else {
      const m = byName.get(k);
      if (r.s < m.s) m.s = r.s;
      if (r.e > m.e) m.e = r.e;
    }
  }
  return [...byName.values()];
}

/* ---------------- 组装 ---------------- */
function toEvents(rows, finals) {
  const today = new Date().toISOString().slice(0, 10);
  const used = new Set();   /* 同名的两站（6 月的排名版 / 12 月的邀请版冠军联赛）只认先发生的那个 */
  return rows
    .map((r) => {
      const win = finals.get(r.en) && r.e < today && !used.has(r.en) ? (used.add(r.en), finals.get(r.en)) : null;
      return {
        id: r.id,
        en: r.en,
        cn: CN_EVENT[r.en] || '',
        city: r.city || '',
        nat_cn: NAT_CN[r.nat] || r.nat || '',
        s: r.s,
        e: r.e,
        level: r.type === 'Invitational' ? 'invitational' : 'ranking',
        prize: r.prize || 0,
        field: r.field || 0,
        winner: win ? { en: win.winner, cn: CN_NAME[win.winner] || '', nat_cn: NAT_CN[win.nat] || win.nat || '', score: win.score, runner_cn: CN_NAME[win.runner] || win.runner } : null,
      };
    })
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
}

function buildData(ranking, calendar, updated) {
  /* 只带页面要用的两张查表：球员中文名 / 国籍中文名（都是人工维护，不做机翻） */
  const names = {};
  const nats = {};
  /* 上游会给女选手加后缀，如 'Bai Yulu (f)'；查表时去掉后缀再查一次 */
  const bare = (n) => String(n).replace(/\s*\([a-z]\)$/i, '');
  for (const r of ranking) {
    const cn = CN_NAME[r[2]] || CN_NAME[bare(r[2])];
    if (cn) names[r[2]] = cn;
    if (NAT_CN[r[3]]) nats[r[3]] = NAT_CN[r[3]];
  }
  return {
    updated,
    source: 'snooker.org',
    names,
    nats,
    season: {
      label: SEASON_LABEL,
      start: calendar.length ? calendar[0].s : '',
      end: calendar.length ? calendar[calendar.length - 1].e : '',
    },
    calendar,
    ranking,
  };
}

function toJsFile(obj) {
  const row = (r) => '    ' + JSON.stringify(r);
  return '/* 由 tools/snooker.mjs 生成，勿手改。数据源：snooker.org（两年滚动排名 / 赛季赛历 / 冠军） */\n' +
    'window.SNOOKER = {\n' +
    '  "updated": ' + JSON.stringify(obj.updated) + ',\n' +
    '  "source": ' + JSON.stringify(obj.source) + ',\n' +
    '  "names": ' + JSON.stringify(obj.names) + ',\n' +
    '  "nats": ' + JSON.stringify(obj.nats) + ',\n' +
    '  "season": ' + JSON.stringify(obj.season) + ',\n' +
    '  "calendar": [\n' + obj.calendar.map(row).join(',\n') + (obj.calendar.length ? '\n' : '') + '  ],\n' +
    '  "ranking": [\n' + obj.ranking.map(row).join(',\n') + (obj.ranking.length ? '\n' : '') + '  ]\n' +
    '};\n';
}

function readDataFile(path) {
  if (!existsSync(path)) return null;
  const src = readFileSync(path, 'utf8');
  const at = src.indexOf('window.SNOOKER');
  if (at < 0) return null;
  const brace = src.indexOf('{', at);
  const end = src.lastIndexOf('}');
  if (brace < 0 || end < brace) return null;
  try { return JSON.parse(src.slice(brace, end + 1)); } catch { return null; }
}

/* 只比「数据」：updated 每次抓取都会变，不能算变化，否则天天提交空 diff */
function sameData(a, b) {
  if (!a || !b) return false;
  return JSON.stringify([a.season, a.names, a.nats, a.calendar, a.ranking]) ===
         JSON.stringify([b.season, b.names, b.nats, b.calendar, b.ranking]);
}

/* ---------------- 抓取 ---------------- */
async function get(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
  return await res.text();
}

const warn = (msg) => {
  /* ::warning:: 在 GitHub Actions 里会亮成黄条，不进 Red；本地就是普通 stderr */
  console.error('::warning::' + msg);
};

/* ---------------- CLI ---------------- */
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

async function main() {
  const local = opt('--local');
  const stdout = flag('--stdout');
  const check = flag('--check');
  const existing = readDataFile(OUT);

  /* 1) 排名（必需） */
  const rankHtml = local ? readFileSync(local, 'utf8') : await get(URL_RANK);
  const min = opt('--min') ? parseInt(opt('--min'), 10) : (local ? 1 : 100);
  const ranking = parseRank(rankHtml);
  if (ranking.length < min) {
    throw new Error(`排名只解析到 ${ranking.length} 行（应约 ${min} 行以上），页面可能改版，已中止`);
  }

  /* 2) 赛历 + 冠军（可降级：抓不到就沿用上一次的） */
  const localCal = opt('--local-cal');
  let calendar = existing ? existing.calendar : [];
  let rows = [];
  if (localCal) {
    rows = pickEvents(parseCalendar(readFileSync(localCal, 'utf8')));
  } else if (!local) {
    try {
      rows = pickEvents(parseCalendar(await get(URL_CAL)));
    } catch (e) {
      warn('赛历抓取失败，改试 ICS 镜像：' + e.message);
      try {
        rows = parseIcs(await get(URL_ICS));
      } catch (e2) {
        warn('ICS 镜像也失败，沿用上次赛历：' + e2.message);
      }
    }
  }
  if (rows.length) {
    let finals = new Map();
    const localFin = opt('--local-fin');
    try {
      finals = parseFinals(localFin ? readFileSync(localFin, 'utf8') : await get(URL_FIN));
    } catch (e) { warn('冠军表抓取失败（不影响赛历）：' + e.message); }
    calendar = toEvents(rows, finals);
  }
  if (!calendar.length) warn('本次没有赛历数据，页面将只显示排名');

  /* 3) 当前站（或下一站）的对阵表：进度图要的轮次结构。抓不到就让页面退回简版进度条。 */
  const todayIso = new Date().toISOString().slice(0, 10);
  const focus = calendar.find((e) => e.s <= todayIso && todayIso <= e.e) ||
    calendar.find((e) => e.s > todayIso) || null;
  if (focus && focus.id) {
    const localEv = opt('--local-ev');
    const cached = (existing && existing.calendar || []).find((e) => e.id === focus.id);
    try {
      const evHtml = localEv ? readFileSync(localEv, 'utf8') : await get(URL_EVENT(focus.id));
      const rounds = parseRounds(evHtml);
      if (rounds.length) focus.rounds = rounds;
      else warn('对阵页没解析出轮次，进度图退回简版');
    } catch (e) {
      warn('对阵页抓取失败，进度图' + (cached && cached.rounds ? '沿用上次轮次' : '退回简版') + '：' + e.message);
      if (cached && cached.rounds) focus.rounds = cached.rounds;
    }
  }

  const updated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const next = buildData(ranking, calendar, sameData(existing, buildData(ranking, calendar, updated)) ? existing.updated : updated);

  if (stdout) { process.stdout.write(toJsFile(next)); return 0; }

  if (check) {
    if (sameData(existing, next)) { console.log(`无漂移（${ranking.length} 人 / ${next.calendar.length} 站）`); return 0; }
    console.error('数据有漂移：assets/snooker-data.js 需要重新生成（node tools/snooker.mjs）');
    return 1;
  }

  if (sameData(existing, next)) { console.log(`无变化，未写文件（${ranking.length} 人 / ${next.calendar.length} 站）`); return 0; }
  writeFileSync(OUT, toJsFile(next));
  console.log(`已写入 assets/snooker-data.js：${ranking.length} 人，赛程 ${next.calendar.length} 站（其中已完赛 ${next.calendar.filter((e) => e.winner).length} 站）`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('失败：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
