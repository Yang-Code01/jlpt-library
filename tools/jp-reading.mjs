#!/usr/bin/env node
/* ============================================================================
   日语阅读 · 生成管线（三段命令）

     node tools/jp-reading.mjs fetch            # 取正文 + 词典，落到 .scratch/jp-reading/
     node tools/jp-reading.mjs fetch --refresh  # 忽略已有缓存，重新下载
     node tools/jp-reading.mjs gen              # 读缓存 + notes 真源 → 写页面
     node tools/jp-reading.mjs check            # 只校验，不改文件；失败退出码 1

   为什么这么取（而不是从 aozora.gr.jp 直接下）：
   · 官方站的 図書カード 只给「著者ID + 作品ID」，正文文件名里还夹一个不可推导的
     ファイルID，必须列目录才拿得到；镜像站把目录结构原样复制，正好可以列。
   · 正文是 Shift_JIS，且「底本／入力／校正」在**文件尾部**（不在抬头），抬头是
     「【テキスト中に現れる記号について】」说明块 —— 剥离逻辑按这个形状写。
   · 「文字遣い種別」不在正文里（只在図書カード 上），所以清单里声明 + 正文粗筛
     双保险：旧仮名标记一出现就拒收，宁可漏收也不收进一篇读不动的东西。

   本机若被 TLS 中间人挡（公司代理常见），加 --insecure 或设 JP_READING_INSECURE=1。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writePreservingEol } from './lib/eol.mjs';
import { parseAozora, oldKanaHits, rubyCount, kanjiRate, decodeSjis } from './lib/aozora.mjs';
import { generate } from './lib/jp-reading-gen.mjs';
import { runCheckCli } from './lib/jp-reading-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'reading', 'works.json');
const SCRATCH = path.join(ROOT, '.scratch', 'jp-reading');
const AOZORA_DIR = path.join(SCRATCH, 'aozora');
const DICT_FILE = path.join(SCRATCH, 'jmdict-eng-common.json');

const ARGS = process.argv.slice(2);
const MODE = ARGS.find((a) => !a.startsWith('-')) || 'fetch';
const has = (f) => ARGS.includes(f);
const opt = (f) => {
  const i = ARGS.indexOf(f);
  if (i < 0) return null;
  const v = ARGS[i + 1];
  return v && !v.startsWith('-') ? v : '';
};
const INSECURE = has('--insecure') || process.env.JP_READING_INSECURE === '1';
const REFRESH = has('--refresh');
const ONLY = opt('--only');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

const log = (...a) => console.log(...a);
const warn = (...a) => console.error(...a);

/* ------------------------------------------------------------------ HTTP */

function get(url, { redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('坏 URL：' + url));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const headers = {
      'user-agent': 'jlpt-library-jp-reading/1 (+https://github.com/Yang-Code01/jlpt-library)',
      accept: '*/*',
    };
    if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
    const req = mod.get(u, { rejectUnauthorized: !INSECURE, headers }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('重定向太多：' + url));
        return resolve(get(new URL(res.headers.location, u).href, { redirects: redirects + 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (status !== 200) {
          const err = new Error('HTTP ' + status + '：' + url + '\n' + buf.toString('utf8').slice(0, 300));
          err.status = status;
          return reject(err);
        }
        resolve(buf);
      });
    });
    req.on('error', (e) => {
      if (/CERT|certificate|SELF_SIGNED|UNABLE_TO_VERIFY|EPROTO/i.test(e.message + ' ' + (e.code || ''))) {
        e.hint = '本机 TLS 被中间人挡了：加 --insecure（或设 JP_READING_INSECURE=1）再跑。';
      }
      reject(e);
    });
    req.setTimeout(45000, () => req.destroy(new Error('请求超时：' + url)));
  });
}

async function getJson(url) {
  const buf = await get(url);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error('不是 JSON：' + url + '\n' + buf.toString('utf8').slice(0, 200));
  }
}

/* --------------------------------------------------------------- tar.gz */

/** 从 .tgz 里取出第一个以 suffix 结尾的成员 */
function tgzMember(tgz, suffix) {
  const tar = zlib.gunzipSync(tgz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim(), 8) || 0;
    if (name.endsWith(suffix)) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('压缩包里找不到 ' + suffix);
}

/* ------------------------------------------------------------- 青空文庫 */

/** 列出镜像里的 files 目录，找到「作品ID_ruby_*」这一套文件 */
async function findSourceText(work) {
  const mirror = manifest.aozora.mirror;
  const base = `https://api.github.com/repos/${mirror}/contents/cards/${work.personId}/files`;
  let list;
  try {
    list = await getJson(base);
  } catch (e) {
    if (e.status === 404) throw new Error(`镜像里没有著者目录 ${work.personId}（${work.title}）`);
    throw e;
  }
  if (!Array.isArray(list)) throw new Error(`列目录返回异常：${base}`);
  const dirs = list
    .filter((e) => e.type === 'dir' && new RegExp(`^${work.workId}_(?:ruby|ruby_|)`).test(e.name))
    .filter((e) => /^\d+_/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!dirs.length) throw new Error(`镜像里没有作品 ${work.workId}（${work.title}）的正文目录`);
  // 同一作品常有多个版本（racy 上标注 / 旧版），取文件名序最后一份
  const dir = dirs[dirs.length - 1];
  const inner = await getJson(dir.url);
  const txt = (Array.isArray(inner) ? inner : []).find((e) => e.type === 'file' && e.name.endsWith('.txt'));
  if (!txt) throw new Error(`目录 ${dir.name} 里没有 .txt`);
  return { dir: dir.name, file: txt.name, download: txt.download_url };
}

/* ------------------------------------------------------------------ 缓存 */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ fetch */

async function fetchDict() {
  const m = manifest.jmdict;
  if (fs.existsSync(DICT_FILE) && !REFRESH) {
    const size = (fs.statSync(DICT_FILE).size / 1048576).toFixed(1);
    log(`  · 词典已缓存（${size} MB），跳过`);
    return false;
  }
  const tag = encodeURIComponent(m.tag);
  const url = `https://github.com/${m.repo}/releases/download/${tag}/${m.asset}-${tag}.json.tgz`;
  log(`  · 下载 JMdict ${m.tag} …`);
  const tgz = await get(url);
  const json = tgzMember(tgz, '.json');
  ensureDir(path.dirname(DICT_FILE));
  fs.writeFileSync(DICT_FILE, json);
  const parsed = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
  log(`  · 词典落盘：${(json.length / 1048576).toFixed(1)} MB，${parsed.words.length} 词条`);
  return true;
}

async function fetchWork(work) {
  const txtFile = path.join(AOZORA_DIR, work.id + '.txt');
  const metaFile = path.join(AOZORA_DIR, work.id + '.json');
  if (fs.existsSync(txtFile) && fs.existsSync(metaFile) && !REFRESH) {
    log(`  · ${work.id} 已缓存，跳过`);
    return { skipped: true };
  }

  const src = await findSourceText(work);
  const buf = await get(src.download);
  const raw = decodeSjis(buf);
  const p = parseAozora(raw);
  if (!p.body.trim()) throw new Error(`${work.id} 正文切空了（抬头格式变了？）`);

  if (work.kanaType !== '新字新仮名') {
    throw new Error(`${work.id}（${work.title}）清单标的是「${work.kanaType}」，本模块只收新字新仮名`);
  }
  const hits = oldKanaHits(p.body);
  if (hits.length) {
    throw new Error(
      `${work.id}（${work.title}）正文里出现旧仮名标记：${hits.join(' / ')}\n` +
      `  清单声明「新字新仮名」与正文不符，拒绝入库（缓存未写入）。`
    );
  }

  const cardUrl = `https://www.aozora.gr.jp/cards/${work.personId}/card${work.workId}.html`;
  const meta = {
    id: work.id,
    band: work.band,
    no: work.no,
    personId: work.personId,
    workId: work.workId,
    title: work.title,
    kana: work.kana,
    author: work.author,
    kanaType: work.kanaType,
    cardUrl,
    mirror: manifest.aozora.mirror,
    sourcePath: `cards/${work.personId}/files/${src.dir}/${src.file}`,
    bib: p.bib,
    parentBib: p.parentBib,
    input: p.input,
    proof: p.proof,
    released: p.released,
    revised: p.revised,
    chars: p.body.replace(/\s/g, '').length,
    kanjiRate: kanjiRate(p.body),
    ruby: rubyCount(p.body),
    sha256: crypto.createHash('sha256').update(p.body).digest('hex'),
    fetchedAt: new Date().toISOString().slice(0, 10),
  };

  ensureDir(AOZORA_DIR);
  writePreservingEol(txtFile, p.body);
  writePreservingEol(metaFile, JSON.stringify(meta, null, 2) + '\n');
  return { meta, wrote: true };
}

async function cmdFetch() {
  log('■ fetch　青空文庫 正文 + JMdict 词典');
  const targets = manifest.works.filter((w) => !ONLY || w.id === ONLY || w.band === ONLY);
  if (!targets.length) throw new Error('清单里没有匹配的作品（--only ' + ONLY + '）');

  await fetchDict();

  const rows = [];
  for (const work of targets) {
    const r = await fetchWork(work);
    if (r.wrote) {
      const m = r.meta;
      rows.push(m);
      log(
        `  · ${m.id} ${m.title}（${m.author}）` +
        `　${m.chars} 字 / 汉字 ${m.kanjiRate}% / 注記 ${m.ruby} / 底本 ${m.bib || '—'}`
      );
      if (!m.input || !m.proof) warn(`    ! ${m.id} 缺 入力／校正 字段，页脚会不完整`);
    }
  }

  const all = manifest.works
    .map((w) => {
      const f = path.join(AOZORA_DIR, w.id + '.json');
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    })
    .filter(Boolean);

  log('');
  log(`缓存：${path.relative(ROOT, SCRATCH)}`);
  for (const m of all) {
    log(
      `  ${m.id}  ${String(m.chars).padStart(6)} 字  ` +
      `注記 ${String(m.ruby).padStart(4)}  ${m.title}　${m.author}` +
      `${m.bib ? '　底本：' + m.bib : ''}`
    );
  }
  const missing = manifest.works.filter((w) => !all.some((m) => m.id === w.id));
  if (missing.length) {
    log(`未缓存：${missing.map((w) => w.id).join('、')}`);
    return 1;
  }
  log('三篇齐备。');
  return 0;
}

/* ------------------------------------------------------------------- gen */

async function cmdGen() {
  log('■ gen　注释真源 + 缓存正文 → 页面');
  const r = generate({ root: ROOT, works: manifest.works, only: ONLY, log });
  if (!r.written.length && !r.skipped.length) log('  全部已是最新。');
  return 0;
}

/* ------------------------------------------------------------------- check */

async function cmdCheck() {
  return runCheckCli({ root: ROOT, works: manifest.works, log, tier2: has("--tier2") });
}

/* ------------------------------------------------------------------ 入口 */

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  warn('读不到 reading/works.json：' + e.message);
  process.exit(2);
}

const CMDS = { fetch: cmdFetch, gen: cmdGen, check: cmdCheck };

if (!CMDS[MODE]) {
  warn(`未知子命令「${MODE}」。可用：fetch · gen · check`);
  process.exit(2);
}

try {
  const code = await CMDS[MODE]();
  process.exit(code || 0);
} catch (e) {
  warn('');
  warn('✗ ' + (e.hint ? e.hint + '\n  ' : '') + e.message);
  process.exit(1);
}
