#!/usr/bin/env node
/*
 * 斯诺克信息区数据生成器：抓 snooker.org 的排名 + 赛历 + 冠军 + 单站对阵 → 写 assets/snooker-data.js
 *
 *   node tools/snooker.mjs                  # 抓 → 数据有变才写文件（无变则原样退出 0）
 *   node tools/snooker.mjs --check          # 只比对不写；有漂移 / 校验不过退出 1（给 CI 用）
 *   node tools/snooker.mjs --heal           # 离线：把「已结束但 >15 场」的站按冻结口径重裁并写盘
 *   node tools/snooker.mjs --local <file>   # 用本地已存的页面代替联网（离线调试 / 单测）
 *   --local-cal <f> --local-fin <f> --local-ev <f>    # 同上，分别替换赛历页 / 冠军页 / 单站对阵页
 *   --out <f>    只给 --check 用：把「本次要写入的产物」导到该文件，便于与入库文件逐字比（不写它）
 *   --ev <id>=<f>     （可重复）把一份对阵页喂给指定场次 id，供离线一次跑多站
 *   --ev-dir <dir>    目录下 2548-xxx.html 这样的文件按文件名前缀的 id 全部喂进来
 *   --local-1y <f>  用本地已存的单赛季榜页面代替联网
 *   node tools/snooker.mjs --local <f> --stdout      # 打印生成的 JS，不落盘
 *   --min <n>   少于 n 行排名视为抓坏并中止（默认：线上 100，--local 1）
 *
 * 为什么产出是 .js 而不是 .json：站点要能用 file:// 双击打开，那时 fetch('*.json')
 * 会被 CORS 拦死；<script src> 不受此限，所以数据以 window.SNOOKER = {...} 注入。
 * 抓取只发生在构建/CI 这一侧，页面自身不联网。
 *
 * 五个上游（都是同一家的静态 HTML 表格）：
 *   template=31  两年滚动排名（128 人）
 *   template=33  单赛季榜 One-Year list（164 人；可降级）
 *   template=2   本赛季赛历（62 行，含资格赛 / Q Tour / 女子 / 元老；本站只取 Main 正赛）
 *   template=7   已结束各站的冠军与比分
 *   event=<id>   单站对阵：轮次表头 + 场级行（「几点 谁 vs 谁」/ 父子对阵 / 冠军与亚军奖金）
 *
 * ⚠️ 已结束的单站页里，`scheduled` 单元格会被上游撤掉、换成 wst.tv 战报链接，
 *    也就是开赛时间在赛后就查不到了 —— 只有赛中抓过才留得下。这正是「赛后冻结」
 *    （frozen）与「赛周内 10 分钟一抓」这套策略的理由。
 *
 * 抓多少、留多少：
 *   已结束站 ≈2 KB/站（只冻 Last 16 起的 15 场），全季 ≈44 KB；全冻 128 场会是 330 KB，
 *   file:// 首屏太重。天梯图 / 冠军路径 / 历史回看用 15 场就够。
 *
 * 两年榜（template=31）抓不到算失败（不写脏数据）；单赛季榜 / 赛历 / 对阵 / 冠军抓不到只报警告，
 * 沿用上一次快照里的对应字段（页面退化成「只有两年榜」也不会白屏）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets/snooker-data.js');
/* 只给 --check 用的输出路径（接外部产物的套件用；不接就是写入路径）。 */
const OUT_ARG = '--out';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const URL_RANK = 'https://www.snooker.org/res/index.asp?template=31';
const URL_CAL = 'https://www.snooker.org/res/index.asp?template=2';
const URL_FIN = 'https://www.snooker.org/res/index.asp?template=7';
/* snooker.org 直连可能撞 Cloudflare 人机校验；calengoo 每天从它的数据生成一份 ICS 镜像，作降级源 */
const URL_ICS = 'http://calengoo.de/snooker/snooker.ics';
/* 单站对阵页：比分之外还给了轮次分组（Round 1 / Quarterfinals / Final…）与每场开赛时间。
   进度图要的「打到第几轮、每轮几场、当天排哪一轮」，天梯图要的「每场几点 谁 vs 谁」都从这里来。 */
const URL_EVENT = (id) => `https://www.snooker.org/res/index.asp?event=${id}`;
const SEASON_LABEL = '2026/27';
/* 单赛季榜（One-Year list）：与两年榜同一套模板，season 参数是纯数字年份（2026 ↔ 2026/27）。
   上游导航页里它叫 Season Points，球员格写 Position in the One-Year list。 */
const URL_RANK_1Y = `https://www.snooker.org/res/index.asp?template=33&season=${SEASON_LABEL.slice(0, 4)}`;
/* 总奖金表：上游（赛历页 / 对阵页 / help 页 / api.snooker.org）都不给总奖金，只能人工维护 */
const FUND_JSON = join(ROOT, 'tools/snooker-prize-fund.json');
/* 赛历页的 prize 列实测是**冠军**奖金（上海站 £210,000 与该站 Final 的 roundinfo 逐字一致），
   不是总奖金。所以 purse.win 以 Final 的 roundinfo 为权威来源，purse.fund 另查人工表。 */

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
  Malaysia: '马来西亚', 'Saudi Arabia': '沙特',
  Moldova: '摩尔多瓦', UAE: '阿联酋', Norway: '挪威',
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

/* 城市中文名：与上面几张表同风格，人工维护、增量补。
   查不到回退英文原文（不 exit 1，只在 --check 时报 warning 列出未覆盖的城市）。 */
const CITY_CN = {
  Belfast: '贝尔法斯特', Shanghai: '上海', Wuhan: '武汉', 'Hong Kong': '香港',
  Berlin: '柏林', Leicester: '莱斯特', Sheffield: '谢菲尔德', London: '伦敦',
  Cheltenham: '切尔滕纳姆', Brentwood: '布伦特伍德', Llandudno: '兰迪德诺',
  Telford: '特尔福德', York: '约克', Blackpool: '布莱克浦', Manchester: '曼彻斯特',
  Edinburgh: '爱丁堡', Taiyuan: '太原', Shenzhen: '深圳', Nanjing: '南京', Yushan: '玉山',
  Milton: '米尔顿凯恩斯', Wolverhampton: '伍尔弗汉普顿',
};

/* 城市 → IANA 时区。消费方一律用 Intl.DateTimeFormat 按 IANA 名算，
   这样英国夏令时由运行时处理 —— 这里绝不自己加减小时。
   未命中的城市回退 Europe/London（斯诺克绝大多数站都在英国）。 */
const TZ = {
  Belfast: 'Europe/London', Shanghai: 'Asia/Shanghai', Wuhan: 'Asia/Shanghai',
  'Hong Kong': 'Asia/Hong_Kong', Berlin: 'Europe/Berlin',
  Leicester: 'Europe/London', Sheffield: 'Europe/London', London: 'Europe/London',
  Cheltenham: 'Europe/London', Brentwood: 'Europe/London', Llandudno: 'Europe/London',
  Telford: 'Europe/London', York: 'Europe/London', Blackpool: 'Europe/London',
  Manchester: 'Europe/London', Edinburgh: 'Europe/London',
  Taiyuan: 'Asia/Shanghai', Shenzhen: 'Asia/Shanghai', Nanjing: 'Asia/Shanghai', Yushan: 'Asia/Shanghai',
  Milton: 'Europe/London', Wolverhampton: 'Europe/London',
};
const TZ_FALLBACK = 'Europe/London';

/* ---------------- 通用 ---------------- */
const ENT = {
  '&nbsp;': ' ', '&pound;': '£', '&euro;': '€', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#8216;': "'", '&#8217;': "'", '&hellip;': '…',
};
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
  /* 先剔掉 HTML 注释：template=33 的行里用 <!-- td ... --> 藏了两列（num / avg），
     不剔掉的话注释会吞掉后面那格，导致「总积分」被当成 avg 读到、积分全成 0。 */
  return [...String(tr).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)].map((m) => [cellClass(m[1]), text(m[2])]);
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

/* ---------------- template=33：单赛季榜（One-Year list） ---------------- */
/**
 * 与两年榜同一套表格模板，所以直接复用 parseRank；差异只在读页方式：
 *   1) 页面里有两张 <table>（导航 + 榜单），只认 id="oneyearrankings" 那张；
 *   2) 行数更多（164 行，含并列名次与 0 分选手）。
 * 列语义同形：第一个 class="sum" 是本赛季总积分，第一个 change 是名次变动，
 * 最后一个 change 是积分变动（不展示）。
 */
function parseRank1y(html) {
  const src = String(html);
  const at = src.indexOf('id="oneyearrankings"');
  if (at < 0) return parseRank(src);
  const end = src.indexOf('</table>', at);
  return parseRank(src.slice(at, end < 0 ? undefined : end));
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

/* ---------------- 单站对阵页：场次 → 轮次 → 奖金三格 ----------------
   ⚠️ 一页里有两张同 class 的表（正赛表 + 资格赛表），而且**正赛场级行不在轮次表头所在的那张表里**：
   正赛轮次表头（<thead> 里的 r15…r7）之后紧跟的是资格赛的行，`</table>` 在正赛场次之前就闭合了。
   所以表头只取第一张 class="display matches" 表，场次全页按 `<tr class="gradeA` 扫
   （页面自己的表头行是 `<tr>` 而不是 gradeA，不会混进来），两个游标各自独立。 */
const ROUND_CN = { 'Quarterfinals': '8 强', 'Semifinals': '半决赛', 'Final': '决赛' };

/* 一格比分 → 数字；空/非数字返回 null */
function scoreNum(raw) {
  const t = String(raw || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  return /^\d+$/.test(t) ? parseInt(t, 10) : null;
}

/* 一个场级行（<tr class="gradeA …>）→ 一场比赛 */
function parseMatch(tr) {
  const src = String(tr);
  const r = parseInt((/\bround(\d+)\b/.exec(src) || [])[1], 10) || 0;
  /* 两侧球员：class 含 player 的 <td>，要排除 h2h（历史交手）那一格 */
  const ps = [...src.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)]
    .filter((m) => {
      const cls = cellClass(m[1]);
      return cls.includes('player') && !cls.includes('h2h');
    })
    .map((m) => {
      const a = /<a\b[^>]*href="\/res\/index\.asp\?player=(\d+)[^>]*\btitle="([^"]*)"/i.exec(m[2]);
      /* 少数行的 title 带国籍后缀（"Elliot Slessor, England"），取逗号前那段。
         待定的格子是 <em>To be decided</em>，没有 <a> → n 与 id 都是 null。 */
      const name = a ? a[2].split(',')[0].trim() : '';
      return name ? { n: name, id: parseInt(a[1], 10) } : { n: null, id: null };
    });
  /* 完赛场次的比分格 class 带双空格（class="score  first-score"），所以只判子串 */
  const f = /class="[^"]*first-score[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(src);
  const l = /class="[^"]*last-score[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(src);
  const s1 = f ? scoreNum(f[1]) : null;
  const s2 = l ? scoreNum(l[1]) : null;
  const done = s1 !== null && s2 !== null;
  /* 每节 UTC 时间：<span class="scheduled" data-localtime-format="…">2026-10-18 12:00:00Z</span>，
     同一天第二场用 class="session"。已结束的场次上游会撤掉这个格，抓不到了。 */
  const ses = [...src.matchAll(/class="(?:scheduled|session)"[^>]*data-localtime-format[^>]*>([^<]*)</g)]
    .map((m) => m[1].trim()).filter(Boolean);
  /* 只有日期没时刻：<td class="scheduled editcell" title="Sat 24 Oct">Sat 24 Oct</td> */
  const dc = /<td[^>]*class="[^"]*scheduled[^"]*editcell[^"]*"[^>]*title="([^"]*)"/i.exec(src);
  return {
    r,
    p1: ps[0] || { n: null, id: null },
    p2: ps[1] || { n: null, id: null },
    s1: done ? s1 : null,        /* 未打完必须同时缺，不能一个有一个没有 */
    s2: done ? s2 : null,
    ses,
    day: dc && dc[1].replace(/&nbsp;/g, ' ').trim() ? dc[1].replace(/&nbsp;/g, ' ').trim() : '',
    st: done ? 'done' : (ses.length ? 'fut' : 'tbd'),
  };
}

/* 单站对阵页 → { rounds, matches }
   rounds 在旧结构（en/cn/bo/n/played/s/e）之上加 id（轮次锚点）与 prize（roundinfo 原文）。 */
function parseEvent(html) {
  const src = String(html);
  /* 轮次表头全页扫：正赛与资格赛各在一张同 class 的表里（NI 站 r15…r7 在第一张、r2/r1 在第二张），
     一页 8 个轮次各出现一次表头，按 id 去重就是全集。
     ⚠️ 一页两张 `class="display matches"` 表，而且正赛场级行不在轮次表头那张表里 ——
     `</table>` 在正赛场次之前就闭合了（r15 表头之后紧跟的是资格赛的行）。
     所以场次必须全页扫，两个游标各自独立，不能只取第一张表。 */
  const heads = [...src.matchAll(/<a name="r(\d+)"><\/a>\s*<span class="round">([^<]*)<\/span>([\s\S]*?)<\/div>/g)]
    .map((m) => ({ id: parseInt(m[1], 10), en: text(m[2]), info: text(m[3]) }));
  const ids = new Set(heads.map((h) => h.id));
  /* 场次全页扫 gradeA 行（页面自己的表头行是 <tr> 而非 gradeA，不会混进来）。 */
  const matches = [...src.match(/<tr class="gradeA[\s\S]*?<\/tr>/g)].map(parseMatch);

  /* 场次 → 轮次统计 */
  const stat = new Map();
  for (const m of matches) {
    if (!m.r) continue;
    let s = stat.get(m.r);
    if (!s) { s = { n: 0, played: 0, ds: [] }; stat.set(m.r, s); }
    s.n++;
    if (m.st === 'done') s.played++;
    for (const t of m.ses) {
      const d = /\d{4}-\d{2}-\d{2}/.exec(t);
      if (d) s.ds.push(d[0]);
    }
  }
  /* 同 id 的表头会出现多次（冠军联赛的小组赛 42 个小组共用 `r19`），按 id 去重，
     否则轮次列表会长出 42 个同名「Group」，轮次阶梯也就废了。 */
  const seen = new Set();
  const uniqHeads = heads.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
  const rounds = uniqHeads
    .map((h) => {
      const s = stat.get(h.id) || { n: 0, played: 0, ds: [] };
      const ds = s.ds.sort();
      const left = s.n * 2;   /* 本轮场数 ×2 = 打完这轮的参赛人数（32 场 → 64 强） */
      /* roundinfo 写了 "Last N" 就用它：轮次英文名不可靠（NI 站的 Round 2 是 Last 32，
         上海站的 Round 2 是 Last 16），优先级高于「场数×2」推断。 */
      const lm = /Last\s+(\d+)/i.exec(h.info);
      const lastN = lm ? parseInt(lm[1], 10) : 0;
      return {
        id: h.id,
        en: h.en,
        cn: lastN >= 4 ? lastN + ' 强' : (ROUND_CN[h.en] || (left >= 16 ? left + ' 强' : h.en)),
        bo: parseInt((/Best of\s+(\d+)/.exec(h.info) || [])[1], 10) || 0,
        n: s.n,
        played: s.played,
        s: ds.length ? ds[0] : '',
        e: ds.length ? ds[ds.length - 1] : '',
        prize: h.info,   /* roundinfo 原文，如 "(Best of 17; Winner: £210,000; Runner-up: £105,000)" */
      };
    })
    .filter((r) => r.n > 0)
    .sort((a, b) => a.id - b.id);   /* 按 id 升序 = 时间顺序（首轮 → 决赛；15=Final 最大，排在最后） */
  return { rounds, matches };
}

/* Last 16 轮次的 id：取最后一个「场数 n === 8」的轮次（不硬编码轮次 id —— 15/14/13 稳定，
   但 Last 16 及更浅的 id 逐站变化）。更浅的轮次（n = 4/2/1）自然都在它之后。 */
function last16Id(rounds) {
  const cands = (rounds || []).filter((r) => r.n === 8).map((r) => r.id);
  return cands.length ? Math.max(...cands) : 0;
}

/* 总奖金：查 tools/snooker-prize-fund.json。键优先 event id，退回英文站名；
   值可为数字或 { value, from, src }。查不到 null（页面显示 —）。 */
function fundLookup(ev) {
  const t = fundTable || {};
  const raw = t[String(ev.id)] != null ? t[String(ev.id)]
    : (t[ev.en] != null ? t[ev.en] : null);
  if (raw == null) return null;
  if (typeof raw === 'number') return { value: raw, from: null, src: null };
  if (typeof raw.value !== 'number') return null;
  return { value: raw.value, from: raw.from || null, src: raw.src || null };
}
let fundTable = {};
function loadFund() {
  if (!existsSync(FUND_JSON)) { warn('总奖金表不存在（' + FUND_JSON + '），purse.fund 全为 null'); return; }
  try {
    const raw = JSON.parse(readFileSync(FUND_JSON, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) fundTable = raw;
    else warn('总奖金表格式不对（应为 { 英文站名: 金额 }），purse.fund 全为 null');
  } catch (e) {
    warn('总奖金表读取失败：' + e.message + '（purse.fund 全为 null）');
  }
}

/* 奖金三格：冠军/亚军取该站 Final 轮次的 roundinfo 原文，总奖金查人工表。
   找 Final 用「场数 n === 1」而不是轮次名 —— 英文名不一定叫 Final（有的站写 Championship Match）。 */
function purseOf(ev, rounds) {
  /* ⚠️ 必须先「只按场数 n === 1」找一轮，再拿轮次名当回退 ——
     不能写成 find(r => r.n === 1 || /final/i.test(r.en))：那会先命中 "Quarterfinals"
     （名字里含 final），于是冠军/亚军奖金会取到八张赫那轮的 "Losers receive £…" 而全变 null。
     拿不到轮次名也不能救场时（有的站最后一轮不叫 Final），才退回名字匹配。 */
  const fin = (rounds || []).find((r) => r.n === 1) ||
    (rounds || []).find((r) => /final/i.test(r.en)) || null;
  const info = String((fin && fin.prize) || '');
  const money = (re) => {
    const m = re.exec(info);
    return m ? parseInt(m[1].replace(/[^\d]/g, ''), 10) : null;
  };
  const win = money(/Winner:\s*[£$€]?\s*([\d,]+)/i);
  const run = money(/Runner-up:\s*[£$€]?\s*([\d,]+)/i);
  /* 手工表：先按 event id 查（同名站只有 id 能区分），再退回英文站名。
     值是数字 = 本赛季口径；是 { value, from } = 沿用上届，页面加 ≈ 并说明。 */
  const hit = fundLookup(ev);
  const fund = hit ? hit.value : null;
  const missing = [];
  if (win == null) missing.push('冠军奖金');
  if (run == null) missing.push('亚军奖金');
  if (fund == null) missing.push('总奖金（tools/snooker-prize-fund.json 里没有 "' + (ev.id || ev.en) + '"）');
  if (missing.length) warn(ev.en + ' 缺 ' + missing.join(' / '));
  return { win, run, fund, fundFrom: hit ? hit.from : null };
}

/* 把一次抓取并进事件对象：轮次 + 场次 + 奖金三格。抛错时调用方负责沿用上次快照。 */
function applyEvent(ev, html) {
  const parsed = parseEvent(html);
  if (!parsed.rounds.length) throw new Error('对阵页没解析出轮次');
  if (!parsed.matches.length) throw new Error('对阵页没解析出场次');
  ev.rounds = parsed.rounds;
  ev.purse = purseOf(ev, parsed.rounds);
  /* 已结束站只留最后 15 场（8+4+2+1；全冻 128 场会让数据文件涨到 330 KB）。
     以前用 last16Id(rounds) 取一个阈值 id 再 filter(m.r >= cut)，遇到「轮次 id 不连续」的站会破：
     冠军联赛（组赛 253 场）一场没裁、中国公开赛多留 2 场。改成从决赛往回收整轮。 */
  const cut = todayIso() > ev.e;
  ev.matches = cut ? cutFrozenMatches(parsed.matches) : parsed.matches;
  if (cut) {
    const keep = new Set(ev.matches.map((m) => m.r));
    ev.rounds = (ev.rounds || []).filter((r) => keep.has(r.id));
  }
}

/* 冻结裁剪：只留「16 强及以后」的场次（8+4+2+1 = 15 场）。
   不能按轮次 id 或页面顺序切（各站行顺序不同），也不能只按「场数 ≤8」筛 ——
   中国公开赛 / 武汉 / 深圳都有 2 场的**外卡轮**，场数虽小却在这条链条之外。
   所以从决赛轮出发，用「本轮胜者出现在已保留的场次里」反复收敛：
   决赛 ← 半决赛 ← 8 强 ← 16 强，外卡轮没人连得上，自然被丢。 */
function cutFrozenMatches(matches) {
  const by = new Map();
  for (const m of matches) {
    if (!by.has(m.r)) by.set(m.r, []);
    by.get(m.r).push(m);
  }
  const nm = (x) => String((x && x.n) || '').trim().toLowerCase();
  const playersOf = (ms) => {
    const set = new Set();
    for (const m of ms) { set.add(nm(m.p1)); set.add(nm(m.p2)); }
    set.delete('');
    return set;
  };
  const winnersOf = (ms) => {
    const set = new Set();
    for (const m of ms) {
      if (m.s1 === null || m.s1 === undefined || m.s2 === null || m.s2 === undefined) continue;
      if (m.s1 > m.s2) set.add(nm(m.p1));
      else if (m.s2 > m.s1) set.add(nm(m.p2));
    }
    set.delete('');
    return set;
  };
  /* 候选：场数 ≤ 8 的轮（当场最多 15 场）。决赛轮 = 场数为 1 的那一轮。 */
  const cand = [...by.entries()].filter(([, ms]) => ms.length <= 8);
  const finId = (cand.find(([, ms]) => ms.length === 1) || [])[0];
  if (finId === undefined) return matches.slice(-15);   /* 没有决赛行（数据不全）：兜底 */
  /* 从决赛往外一层层数（depth 0 = 决赛），只留最近的四轮，凑够 15 场为止。
     用「层」而不是「场数」决定谁留下：上海站 24 强（8 场）的胜者也能连到 16 强，
     但它比 16 强更浅，该丢的是它；中国公开赛的外卡轮同理。 */
  const depth = new Map([[finId, 0]]);
  let frontier = [finId];
  for (let d = 0; frontier.length; d++) {
    const seen = playersOf(frontier.flatMap((id) => by.get(id)));
    const next = [];
    for (const [id, ms] of cand) {
      if (depth.has(id)) continue;
      if ([...winnersOf(ms)].some((x) => seen.has(x))) { depth.set(id, d + 1); next.push(id); }
    }
    frontier = next;
  }
  const keep = new Set();
  let total = 0;
  for (const [id] of [...depth].sort((a, b) => a[1] - b[1])) {
    const n = by.get(id).length;
    if (total + n > 15) break;
    keep.add(id);
    total += n;
  }
  const out = matches.filter((m) => keep.has(m.r));
  return out.length ? out : matches.slice(-15);
}

/* ---------------- 抓取状态机 ---------------- */
const HOUR = 3600 * 1000;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/* 该站是否已冻结：过了结束日，且 Final 双人齐备、有比分。
   必须带 Final 判据 —— 世锦赛这类跨夜决赛（结束日当天还比不完）会按日期被提前冻死，
   冠军比分就永久缺失了。 */
function frozen(e) {
  if (!e || !e.e || !(todayIso() > e.e)) return false;
  const fin = (e.rounds || []).find((r) => r.n === 1);
  const finId = fin ? fin.id : 15;   /* 决赛永远是 n === 1；id 找不到时退回固定值 15 */
  const ms = (e.matches || []).filter((m) => m.r === finId);
  return ms.length > 0 && ms.every((m) => m.st === 'done' && m.p1.n && m.p2.n);
}

/* 冻结自愈：frozen() 是**算出来的**（决赛轮打完 + 日期已过），一旦为真这一站就不再重抓
   （见 attachEvents 里的 continue）。于是「冻结前抓到的全量场次」会永久躺在快照里：
   北爱尔兰公开赛 2026 就这样留下 127 场，而 checkData 要求已结束站 ≤15 场。
   写盘/比对前统一按冻结口径重裁一遍，幂等；只动「今天 > 结束日」的站，未开赛站不碰。 */
function healFinished(calendar) {
  const today = todayIso();
  let healed = 0;
  for (const e of calendar || []) {
    const ms = e.matches || [];
    if (!e.e || !(today > e.e) || ms.length <= 15) continue;
    const cut = cutFrozenMatches(ms);
    if (cut.length < ms.length) { e.matches = cut; healed++; }
  }
  return healed;
}

/* 该站多久抓一次：赛周内 10min（要留住开赛时间）；距开赛 ≤7 天 6h；其余 24h。
   CI 每 10 分钟一轮，合起来约 300 次/天，比每轮全量抓（432 次/天）省。 */
/* 这一站多久该抓一次（分层）。三个坑：
 *  ① 已结束的站不能「按全局 updated 算间隔」—— 赛季进行中数据文件每几分钟就写一次，
 *     全局 updated 永远是新的，于是历史站永远轮不到；所以已结束的站改成「每天一次」，
 *     抓到就冻结（frozen()），冻结后不再进来。
 *  ② 赛程还很远的站（>7 天）返回 Infinity，即「不抓」——开赛前一周才可能有签表。
 *  ③ Infinity 不能被 due() 当成「没抓过」而放行。 */
function dueAt(e) {
  const today = todayIso();
  if (e.s <= today && today <= e.e) return 10 * 60 * 1000;
  const d = Date.parse(e.s + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z');
  if (d > 7 * 24 * HOUR) return Infinity;
  if (d > 0) return 6 * HOUR;
  return 24 * HOUR;
}

/* 把「这次抓到的时间」按抓取频率向下取整（10 分钟 / 6 小时 / 1 天一个桶）。
   为什么取整：fetchedAt 会进数据文件、也会参与「内容变没变」的比对，若存精确时刻，
   同一份内容每抓一次就得多提交一次；取整后同一个桶里重复抓取不会产生 diff。
   Infinity（赛程还远，不抓）不需要时间戳。 */
function fetchBucket(now, want) {
  if (!want || want === Infinity) return null;
  return new Date(Math.floor(now / want) * want).toISOString();
}

/* 距上次抓够 want 的间隔了吗（没给上次时间 = 第一次，抓） */
function due(now, want, lastFetchedAt) {
  if (!want || want === Infinity) return false;
  if (!lastFetchedAt || Number.isNaN(lastFetchedAt)) return true;
  return now - lastFetchedAt >= want;
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
        city_cn: CITY_CN[r.city] || r.city || '',   /* 查不到回退英文原文，不 exit 1 */
        nat_cn: NAT_CN[r.nat] || r.nat || '',
        s: r.s,
        e: r.e,
        level: r.type === 'Invitational' ? 'invitational' : 'ranking',
        prize: r.prize || 0,   /* 实测是**冠军**奖金；字段本身保持不动，purse.win 才是它的权威来源 */
        field: r.field || 0,
        winner: win ? { en: win.winner, cn: CN_NAME[win.winner] || '', nat_cn: NAT_CN[win.nat] || win.nat || '', score: win.score, runner: win.runner, runner_cn: CN_NAME[win.runner] || win.runner } : null,
        rounds: null,   /* 以下三个由 attachEvents / purseOf 填 */
        matches: [],
        purse: null,
        tz: TZ[r.city] || TZ_FALLBACK,
      };
    })
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
}

function buildData(ranking, calendar, updated, prev, ranking1y, updated1y) {
  /* 只带页面要用的两张查表：球员中文名 / 国籍中文名（都是人工维护，不做机翻）。
     与上一份产物合并：排名页有时只拿到部分行（离线 fixture / 上游截断），
     若直接重建，上一份里的中文名会成批消失，树和赛程表就退回英文了。 */
  const names = Object.assign({}, prev && prev.names);
  const nats = Object.assign({}, prev && prev.nats);
  /* 上游会给女选手加后缀，如 'Bai Yulu (f)'；查表时去掉后缀再查一次 */
  const bare = (n) => String(n).replace(/\s*\([a-z]\)$/i, '');
  /* 单赛季榜会包含两年榜 Top128 之外的人（业余 / 外卡 / 女选手），两张榜要一起收，
     否则那些行的中文名会缺。 */
  for (const r of ranking.concat(ranking1y || [])) {
    const cn = CN_NAME[r[2]] || CN_NAME[bare(r[2])];
    if (cn) names[r[2]] = cn;
    if (NAT_CN[r[3]]) nats[r[3]] = NAT_CN[r[3]];
  }
  /* 每站无论走哪条路进来（赛历页 / ICS 降级 / 沿用上次快照），都补齐时区与中文地名 ——
     页面靠这两个字段算「当地小字」和「武汉 · Wuhan」。 */
  for (const e of calendar) {
    /* 手工表优先：表里后来补了中文名，旧快照里的英文回退值也要跟着更新 */
    e.city_cn = CITY_CN[e.city] || e.city_cn || e.city || '';
    e.tz = TZ[e.city] || e.tz || TZ_FALLBACK;
    /* 总奖金是手工表，与「这轮有没有抓到对阵页」无关 —— 逐站无条件填，
       否则只有本轮抓过的那一两站在页面上有总奖金。 */
    e.purse = e.purse || {};
    const f = fundLookup(e);
    e.purse.fund = f ? f.value : null;
    e.purse.fundFrom = f ? f.from : null;
    if (e.purse.win == null) e.purse.win = e.prize || null;
    if (!e.matches) e.matches = [];
    if (e.rounds === undefined) e.rounds = null;
    if (e.purse === undefined) e.purse = null;
  }
  return {
    updated,
    /* 单赛季榜单独记一次抓取时间：它可降级（沿用上次），所以榜的年龄可能比快照老 */
    updated1y: updated1y || updated,
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
    ranking1y: ranking1y || [],
  };
}

function toJsFile(obj) {
  const row = (r) => '    ' + JSON.stringify(r);
  return '/* 由 tools/snooker.mjs 生成，勿手改。数据源：snooker.org（两年滚动排名 / 单赛季榜 / 赛季赛历 / 冠军 / 单站对阵） */\n' +
    'window.SNOOKER = {\n' +
    '  "updated": ' + JSON.stringify(obj.updated) + ',\n' +
    '  "updated1y": ' + JSON.stringify(obj.updated1y || obj.updated) + ',\n' +
    '  "source": ' + JSON.stringify(obj.source) + ',\n' +
    '  "names": ' + JSON.stringify(obj.names) + ',\n' +
    '  "nats": ' + JSON.stringify(obj.nats) + ',\n' +
    '  "season": ' + JSON.stringify(obj.season) + ',\n' +
    '  "calendar": [\n' + obj.calendar.map(row).join(',\n') + (obj.calendar.length ? '\n' : '') + '  ],\n' +
    '  "ranking": [\n' + obj.ranking.map(row).join(',\n') + (obj.ranking.length ? '\n' : '') + '  ],\n' +
    '  "ranking1y": [\n' + (obj.ranking1y || []).map(row).join(',\n') + ((obj.ranking1y || []).length ? '\n' : '') + '  ]\n' +
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

/* 只比「数据」：updated / updated1y 是元数据，每次抓取都会变，不能算变化，否则天天提交空 diff。
   matches / purse / tz / city_cn 都在 calendar 里，被这一份对比带上。 */
function snapOf(d) {
  return d ? [d.season, d.names, d.nats, d.calendar, d.ranking, d.ranking1y] : null;
}
function sameData(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(snapOf(a)) === JSON.stringify(snapOf(b));
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

/* ---------------- --check 的额外校验（纯逻辑，联网抓完顺带跑） ---------------- */
function checkData(data) {
  const bad = [];
  const today = todayIso();
  for (const e of data.calendar) {
    const ms = e.matches || [];
    if (e.id) {
      /* matches[].r 都要落在 rounds 的 id 集合里 */
      const ids = new Set((e.rounds || []).map((r) => r.id));
      for (const m of ms) if (!ids.has(m.r)) bad.push(`${e.en} 有场次指向不存在的轮次 r=${m.r}`);
    }
    /* s1/s2 必须同时有或同时无 */
    for (const m of ms) if ((m.s1 === null) !== (m.s2 === null)) bad.push(`${e.en} 比分不成对（s1=${m.s1} s2=${m.s2}）`);
    /* 每节开赛时刻都要能被 new Date() 解析（消费方直接 new Date(时刻) 转本地时区） */
    for (const m of ms) {
      for (const t of m.ses || []) if (Number.isNaN(new Date(t).getTime())) bad.push(`${e.en} 开赛时刻无法解析：${t}`);
    }
    /* 已结束站只留 Last 16 起的 15 场 */
    if (e.e && today > e.e && ms.length > 15) bad.push(`${e.en} 已结束却留了 ${ms.length} 场（应 ≤15）`);
  }
  /* 手工表覆盖不全只报 warning（可增量补），不算失败 */
  const miss = [...new Set(data.calendar.map((e) => e.city).filter((c) => c && !(c in CITY_CN)))];
  if (miss.length) warn(`CITY_CN 未覆盖 ${miss.length} 个城市（暂回退英文原文）：${miss.join(', ')}`);
  return bad;
}

/* ---------------- 单站对阵页：抓 / 冻 / 沿用 ---------------- */
/* 给 calendar 里每一站补 rounds / matches / purse：
   抓当前站、下一站，以及所有未冻结且已开赛或临近的站；其余站沿用 existing.calendar 里的快照。
   任一站失败只报 warning 并保留上次快照，绝不写空数据。 */
async function attachEvents(calendar, existing, opts) {
  const now = Date.now();
  const today = todayIso();
  const prevById = new Map();
  const prevList = Array.isArray(existing) ? existing : (existing && Array.isArray(existing.calendar) ? existing.calendar : []);
  for (const e of prevList) if (e && e.id) prevById.set(e.id, e);
  const focus = calendar.find((e) => e.s <= today && today <= e.e) ||
    calendar.find((e) => e.s > today) || null;
  let fetched = 0, kept = 0, noId = 0, missed = 0;

  for (const ev of calendar) {
    if (!ev.id) { noId++; continue; }
    const prev = prevById.get(ev.id);
    if (prev) {   /* 先把上次快照铺上：抓失败 / 到期未到时都还有内容 */
      ev.rounds = prev.rounds || null;
      ev.matches = prev.matches || [];
      ev.purse = prev.purse || null;
      ev.fetchedAt = prev.fetchedAt || null;   /* 每站自己的抓取时刻，不能用全局 updated 代替 */
      ev.fails = prev.fails || 0;
      kept++;
    }
    /* 离线喂文件：--local-ev 喂 focus 站；--ev <id>=<f> / --ev-dir 喂指定站。
       显式喂了文件就绕过「冻结 / 重试上限」—— 那是给测试和补历史用的，
       否则冻结过的站永远没法用新解析器重新跑一遍。 */
    let file = opts.evFiles.get(ev.id) || null;
    if (!file && focus && focus.id === ev.id) file = opts.evFiles.get('__focus__') || null;
    if (!file && frozen(ev)) continue;    /* 赛后冻结：不再抓这一站 */
    if (!file && ev.fails >= 3) continue; /* 连抓三次都没拿到对阵页（上游撤页等），别再白请求 */
    let html = null;
    if (file) {
      html = readFileSync(file, 'utf8');
    } else {
      if (opts.offline) continue;   /* 离线模式不联网 */
      const want = dueAt(ev);
      /* ⚠️ 必须用**这一站自己的** fetchedAt，不能用 prev.updated：
         赛季进行中数据文件每 10 分钟就写一次，全局 updated 永远是新的，
         于是「已结束、还没有对阵数据」的历史站永远轮不到抓（这是真实踩过的坑）。 */
      const last = ev.fetchedAt ? Date.parse(ev.fetchedAt) : 0;
      if (!due(now, want, last)) { missed++; continue; }
      try {
        html = await get(URL_EVENT(ev.id));
      } catch (e) {
        warn(ev.en + ' 对阵页抓取失败，沿用上次快照：' + e.message);
        ev.fails = (ev.fails || 0) + 1;
        continue;
      }
    }
    try {
      applyEvent(ev, html);
      ev.fails = 0;
      ev.fetchedAt = fetchBucket(now, dueAt(ev));
      fetched++;
    } catch (e) {
      warn(ev.en + ' 对阵页解析失败，沿用上次快照：' + e.message);
    }
  }
  if (noId) warn(`${noId} 站没有 event id（多半来自 ICS 降级源），本轮没有对阵数据`);
  if (missed) warn(`${missed} 站未到抓取间隔，本轮跳过`);
  if (fetched) console.log(`对阵页：本次更新 ${fetched} 站（沿用 ${kept} 站上次快照）`);
}

/* ---------------- CLI ---------------- */
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

/* 离线时喂的对阵页：--ev <id>=<路径> 可重复；--ev-dir <目录> 按文件名前缀的 id；
   --local-ev <路径> 喂 focus 站（保持旧行为）。 */
function collectEventFiles() {
  const m = new Map();
  const put = (spec) => {
    const i = spec.indexOf('=');
    if (i > 0) m.set(spec.slice(0, i).trim(), resolve(spec.slice(i + 1).trim()));
  };
  for (let i = 0; i < argv.length; i++) {
    const hit = /^--ev=(.+)$/.exec(argv[i]);
    if (hit) put(hit[1]);
    /* 也接受 `--ev <id>=<路径>` 的空格写法（两种都常见，别只认一种） */
    else if (argv[i] === '--ev' && argv[i + 1] && !argv[i + 1].startsWith('--') && argv[i + 1].includes('=')) put(argv[++i]);
  }
  const one = opt('--local-ev');
  if (one) m.set('__focus__', resolve(one));
  const dir = opt('--ev-dir');
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      const id = /^(\d+)[-_ ]/.exec(f);
      if (id) m.set(id[1], resolve(dir, f));
    }
  }
  return m;
}

async function main() {
  const local = opt('--local');
  const stdout = flag('--stdout');
  const check = flag('--check');
  const localCal = opt('--local-cal');
  const localFin = opt('--local-fin');
  const local1y = opt('--local-1y');
  const evFiles = collectEventFiles();
  /* --check 可配 --out <文件> 把「本次要写入的产物」导到临时文件，好和 committed 文件逐字比。
     不带这个开关时行为与原来一模一样：写入路径就是 OUT。 */
  const outPath = opt(OUT_ARG) ? resolve(opt(OUT_ARG)) : OUT;

  /* --heal：不联网，只把已入库快照里「已结束却存着全量场次」的站重裁后写回。
     存在意义：frozen() 的站不再重抓，联网路径永远碰不到它们。 */
  if (flag('--heal')) {
    const data = readDataFile(outPath);
    if (!data) { console.error(`无法解析数据文件：${outPath}`); return 1; }
    const n = healFinished(data.calendar || []);
    if (!n) { console.log('已无需要重裁的站点（已结束站均 ≤15 场）'); return 0; }
    writeFileSync(outPath, toJsFile(data));
    console.log(`已按冻结口径重裁 ${n} 站并写入 ${outPath}`);
    return 0;
  }
  const readOnly = !!check || !!stdout;
  if (readOnly && !existsSync(outPath)) {
    throw new Error(`要写入的文件不存在（${OUT_ARG}）：${outPath}`);
  }
  const existing = readDataFile(outPath);
  /* 读进来立刻拍一份快照：calendar 抓不到时会直接沿用它（同一个数组引用），
     attachEvents 又是原地改对象 —— 不先拍，最后比对是拿自己跟自己比，
     对咯数据永远「无变化」、写不进文件。 */
  const beforeSnap = existing ? JSON.stringify(snapOf(existing)) : null;
  /* 只要给了任何离线来源，就完全不联网（--local 的用途就是离线调试 / 单测） */
  const offline = !!(local || localCal || localFin || local1y || evFiles.size);
  /* 1) 排名（必需） */
  const rankHtml = local ? readFileSync(local, 'utf8') : await get(URL_RANK);
  const min = opt('--min') ? parseInt(opt('--min'), 10) : (local ? 1 : 100);
  const ranking = parseRank(rankHtml);
  if (ranking.length < min) {
    throw new Error(`排名只解析到 ${ranking.length} 行（应约 ${min} 行以上），页面可能改版，已中止`);
  }

  /* 1b) 单赛季榜（可降级：抓不到就沿用上一次；从未成功过就留空，页面显示占位） */
  let ranking1y = (existing && existing.ranking1y) || [];
  let got1y = false;
  if (local1y) {
    try {
      const rows1y = parseRank1y(readFileSync(local1y, 'utf8'));
      if (!rows1y.length) throw new Error('一行为空，页面可能不对');
      ranking1y = rows1y;
      got1y = true;
    } catch (e) {
      warn('单赛季榜本地页读取失败，' + (ranking1y.length ? '沿用上次的榜' : '本次留空') + '：' + e.message);
    }
  } else if (!local) {
    try {
      const rows1y = parseRank1y(await get(URL_RANK_1Y));
      if (rows1y.length < min) throw new Error(`只解析到 ${rows1y.length} 行（应约 ${min} 行以上），页面可能改版`);
      ranking1y = rows1y;
      got1y = true;
    } catch (e) {
      warn('单赛季榜抓取失败，' + (ranking1y.length ? '沿用上次的榜' : '本次留空') + '：' + e.message);
    }
  }

  loadFund();

  /* 2) 赛历 + 冠军（可降级：抓不到就沿用上一次的） */
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
    try {
      finals = parseFinals(localFin ? readFileSync(localFin, 'utf8') : await get(URL_FIN));
    } catch (e) { warn('冠军表抓取失败（不影响赛历）：' + e.message); }
    calendar = toEvents(rows, finals);
  }
  if (!calendar.length) warn('本次没有赛历数据，页面将只显示排名');

  /* 3) 单站对阵页（当前站 / 下一站 / 未冻结且已开赛或临近的站） */
  await attachEvents(calendar, existing, { evFiles, offline });

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  /* 榜龄只记「这份 list 上次真被抓到」的时刻：抓失败沿用旧榜时不刷新它，页面据此提示「沿用」 */
  const updated1y = got1y ? nowIso : ((existing && existing.updated1y) || '');
  const built = buildData(ranking, calendar, nowIso, existing, ranking1y, updated1y);
  const next = beforeSnap && JSON.stringify(snapOf(built)) === beforeSnap
    ? buildData(ranking, calendar, existing.updated, existing, ranking1y, updated1y) : built;

  /* 写盘/比对前统一自愈：冻结站可能存着冻结前的全量场次（见 healFinished） */
  const healed = healFinished(next.calendar);
  if (healed) warn(`自愈：${healed} 个已结束站被重裁回冻结口径`);

  if (stdout) { process.stdout.write(toJsFile(next)); return 0; }

  const bad = checkData(next);
  if (check) {
    if (bad.length) {
      for (const b of bad) console.error('校验不通过：' + b);
      return 1;
    }
    if (beforeSnap && JSON.stringify(snapOf(next)) === beforeSnap) { console.log(`无漂移（${ranking.length} 人 / ${next.calendar.length} 站）`); return 0; }
    console.error('数据有漂移：assets/snooker-data.js 需要重新生成（node tools/snooker.mjs）');
    return 1;
  }

  if (bad.length) for (const b of bad) warn(b);
  /* 旧快照里还没有 updated1y 时强制写一次：否则元数据永远补不上，页面一直不知道榜龄 */
  if (beforeSnap && JSON.stringify(snapOf(next)) === beforeSnap && existing.updated1y) { console.log(`无变化，未写文件（${ranking.length} 人 / ${next.calendar.length} 站）`); return 0; }
  writeFileSync(outPath, toJsFile(next));
  console.log(`已写入 assets/snooker-data.js：${ranking.length} 人 / 单赛季 ${ranking1y.length} 人，赛程 ${next.calendar.length} 站（其中已完赛 ${next.calendar.filter((e) => e.winner).length} 站）`);
  return 0;
}

/* 供离线单测 import 用（直接 node 跑时照旧执行 main） */
export { parseEvent, parseMatch, parseRank, parseRank1y, toJsFile, loadFund, parseCalendar, parseIcs, parseFinals, pickEvents, toEvents, buildData, frozen, dueAt, fetchBucket, last16Id, cutFrozenMatches, healFinished, sameData, checkData, CITY_CN, TZ };

const invokedDirectly = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]); }
  catch { return true; }
})();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error('失败：' + (err && err.message ? err.message : err));
    process.exitCode = 1;
  });
}