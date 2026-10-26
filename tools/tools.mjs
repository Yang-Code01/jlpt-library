#!/usr/bin/env node
/*
 * 工具开发（Tools）模块：清单生成 / 校验 / 打包
 *
 *   node tools/tools.mjs gen        # 由 tools-dev/data.json 生成 index.html 里的工具清单区
 *   node tools/tools.mjs check      # 校验 data.json / 详情页 / 下载包 / 清单区一致性，有问题退出码 1
 *   node tools/tools.mjs pack <id>  # 把工具目录打成 tools-dev/downloads/<id>-<version>.zip 并写 manifest.json
 *   node tools/tools.mjs pack --all
 *
 * 真源是 tools-dev/data.json；每个工具的详情页是 tools-dev/<page>（自包含 HTML，
 * 有的是手写稿，有的是生成物 —— 例如 pi-toolchain.html 由 tools/pi-toolchain-gen.mjs
 * 从 tools-dev/pi-toolchain.data.json 生成，见 ADR-0012），
 * 工具本体在 data.json 的 dir 指向的目录里。index.html 的标记区由 gen 写，勿手改。
 *
 * 「下载」不依赖任何服务：pack 把目录打成 store-only（不压缩）zip 随仓库发布，
 * 详情页直接 <a download href="…zip">。zip 与 manifest 里的 sha256 由 check 校验，
 * 改了工具源码却忘记重新 pack 会被 check 抓到。
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickEol, toEol } from './lib/eol.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = join(ROOT, 'tools-dev/data.json');
const TOOLS_DIR = join(ROOT, 'tools-dev');
const DOWNLOAD_DIR = join(TOOLS_DIR, 'downloads');
const MANIFEST_PATH = join(DOWNLOAD_DIR, 'manifest.json');
const INDEX_PATH = join(ROOT, 'index.html');

const LIST_START = '<!-- wb:tool-list:start -->';
const LIST_END = '<!-- wb:tool-list:end -->';
const STATUSES = ['可用', '试验', '暂停'];
const SKIP = new Set(['node_modules', '.git', '.scratch', 'dist', '__pycache__']);

const problems = [];
const bad = (msg) => problems.push(msg);

/* ------------------------------------------------------------------ 工具 */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function kb(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readData() {
  if (!existsSync(DATA_PATH)) {
    bad('找不到 tools-dev/data.json');
    return null;
  }
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    bad(`tools-dev/data.json 不是合法 JSON：${e.message}`);
    return null;
  }
}

/** 递归列出目录里的文件（相对路径，正斜杠），跳过二手产物。 */
function walk(dir, base = dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs, base));
    else if (ent.isFile()) out.push(relative(base, abs).split(sep).join('/'));
  }
  return out.sort();
}

/* ------------------------------------------------------------------ zip */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** store-only zip：够用、无依赖、可被任何解压工具打开（不压缩，体积略大）。 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, data } of entries) {
    const nameBuf = Buffer.from(path, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date（1980-01-01，稳定可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

/* --------------------------------------------------------- 清单区渲染 */

function renderItem(tool) {
  // 下载体积现算：手写进 data.json 会随 pack 漂移
  if (tool.download) {
    const abs = join(TOOLS_DIR, tool.download);
    tool.size = existsSync(abs) ? kb(statSync(abs).size) : '';
  }
  const tags = (tool.tags || []).map((t) => `          <span class="tag">${esc(t)}</span>`).join('\n');
  const dl = tool.download
    ? `<a class="tool-dl" href="tools-dev/${esc(tool.download)}" download>↓ 下载 zip <span class="n">${esc(tool.size || '')}</span></a>`
    : '<span class="tool-dl off">未打包</span>';
  return [
    `      <div class="survey-item tool-item" data-tags="${esc((tool.tags || []).join(' '))}">`,
    `        <span class="survey-date">${esc(tool.updated)}</span>`,
    `        <span>`,
    `          <span class="survey-title"><a href="tools-dev/${esc(tool.page)}">${esc(tool.title)}</a></span>`,
    `          <span class="survey-desc">${esc(tool.summary)}</span>`,
    `          <span class="survey-tags">`,
    tags,
    `          </span>`,
    `        </span>`,
    `        <span class="survey-src">`,
    `          <span class="src-main">${dl}</span>`,
    `          <span class="src-sub">v${esc(tool.version)} · ${esc(tool.status)}</span>`,
    `        </span>`,
    `      </div>`,
  ].join('\n');
}

function renderFilterBar(tags, tools) {
  const count = (t) => tools.filter((x) => (x.tags || []).includes(t)).length;
  const chips = tags.map((t) => {
    const n = count(t);
    const dis = n === 0 ? ' disabled' : '';
    return `        <button type="button" class="filter-chip" data-filter="${esc(t)}"${dis}>${esc(t)} <span class="n">${n}</span></button>`;
  });
  return [
    `      <div class="filter-bar" role="group" aria-label="按标签筛选工具">`,
    `        <span class="filter-label">标签</span>`,
    `        <button type="button" class="filter-chip on" data-filter="all">全部 <span class="n">${tools.length}</span></button>`,
    ...chips,
    `      </div>`,
  ].join('\n');
}

function renderRegion(data) {
  const tools = data.tools || [];
  const body = [
    `      <div class="zone-head zone-first">`,
    `        <div class="zone-head-main">`,
    `          <h2 class="zone-title">全部工具 <span class="zone-en">Tools</span></h2>`,
    `          <p class="zone-sub">按更新日期倒序。点标题进详情页看用法与下载；标签筛选只影响本页显示。</p>`,
    `        </div>`,
    `        <div class="zone-aside"><span class="zone-count">${tools.length} 个</span></div>`,
    `      </div>`,
    ``,
    renderFilterBar(data.tags || [], tools),
    ``,
    `      <div class="survey-list" id="tool-list">`,
    ...tools.map(renderItem),
    `      </div>`,
    ``,
    `      <p class="filter-empty" id="tool-empty" hidden>这个标签下还没有工具。</p>`,
    LIST_END,
  ].join('\n');
  return `${LIST_START}\n${body}`;
}

function readIndex() {
  if (!existsSync(INDEX_PATH)) {
    bad('找不到 index.html');
    return null;
  }
  return readFileSync(INDEX_PATH, 'utf8');
}

function regionBounds(disk) {
  const i = disk.indexOf(LIST_START);
  const j = disk.indexOf(LIST_END);
  if (i < 0 || j < 0 || j < i) {
    bad(`index.html 里找不到 ${LIST_START} / ${LIST_END}`);
    return null;
  }
  return { i, j };
}

/* -------------------------------------------------------------- 校验 */

const norm = (s) => s.replace(/\r\n/g, '\n');

/**
 * 工具版本的真源。默认是 <dir>/package.json 的 version；源码仓库（Go / 自带版本常量、
 * 不该被塞一个只为凑版本的 package.json）可用 data.json 里的
 *   "versionFrom": { "file": "src/cmd/server/main.go", "pattern": "appVersion = \"([0-9.]+)" }
 * 从源码里取，pattern 必须带一个捕获组（版本号）。
 */
function sourceVersion(t, dir) {
  const vf = t.versionFrom;
  if (!vf || typeof vf !== 'object' || typeof vf.file !== 'string' || typeof vf.pattern !== 'string') {
    return { error: 'versionFrom 需要 { file, pattern }（两个字符串）' };
  }
  const abs = join(dir, vf.file);
  if (!existsSync(abs)) return { error: `${t.dir}/${vf.file} 不存在（versionFrom.file）` };
  let re;
  try {
    re = new RegExp(vf.pattern);
  } catch (e) {
    return { error: `versionFrom.pattern 不是合法正则：${e.message}` };
  }
  const m = re.exec(readFileSync(abs, 'utf8'));
  if (!m) return { error: `${t.dir}/${vf.file} 里匹配不到 versionFrom.pattern（源码改了写法？）` };
  if (!m[1]) return { error: 'versionFrom.pattern 必须带一个捕获组（版本号）' };
  return { version: m[1], file: `${t.dir}/${vf.file}` };
}

function validate(data, disk) {
  if (!data || typeof data !== 'object') return;
  const tags = data.tags || [];
  const tools = data.tools || [];

  if (!Array.isArray(tags) || !tags.length) bad('tools-dev/data.json 缺少 tags 受控词表');
  if (!Array.isArray(tools)) bad('tools-dev/data.json 的 tools 必须是数组');

  const seen = new Set();
  for (const t of tools) {
    const at = `工具 ${t.id || '(无 id)'}`;
    for (const key of ['id', 'title', 'status', 'version', 'updated', 'summary', 'page']) {
      if (!t[key]) bad(`${at} 缺少字段 ${key}`);
    }
    if (t.id && seen.has(t.id)) bad(`${at}：id 重复`);
    seen.add(t.id);
    if (t.status && !STATUSES.includes(t.status)) bad(`${at}：status「${t.status}」不在 ${STATUSES.join(' / ')} 里`);
    if (t.updated && !/^\d{4}-\d{2}-\d{2}$/.test(t.updated)) bad(`${at}：updated 必须是 YYYY-MM-DD`);
    for (const tag of t.tags || []) {
      if (!tags.includes(tag)) bad(`${at}：标签「${tag}」没在 tags 里登记`);
    }
    if (t.page && !existsSync(join(TOOLS_DIR, t.page))) bad(`${at}：详情页 tools-dev/${t.page} 不存在`);

    // 详情页里的下载链接是手写的（不经过 gen），升版后最容易留下一个 404 的旧包名
    if (t.page && existsSync(join(TOOLS_DIR, t.page))) {
      const html = readFileSync(join(TOOLS_DIR, t.page), 'utf8');
      for (const m of html.matchAll(/href="([^"]+\.zip)"/g)) {
        const abs = join(TOOLS_DIR, normalize(join(dirname(t.page), m[1])));
        if (!existsSync(abs)) bad(`${at}：详情页 tools-dev/${t.page} 的下载链接 ${m[1]} 指向不存在的文件（升版后忘了改？）`);
      }
      /* 详情页是从门户清单点进来的，必须能回去：右上角固定按钮 + 页脚链接。
         之前只有部分页有，读者会困在子页里。 */
      if (!/<a[^>]+class="back-btn"[^>]+href="\.\.\/index\.html#tools"/.test(html)) {
        bad(`${at}：详情页 tools-dev/${t.page} 缺右上角返回按钮（<a class="back-btn" href="../index.html#tools">）`);
      }
      if (!/data-back="top"/.test(html)) bad(`${at}：详情页 tools-dev/${t.page} 的返回按钮缺 data-back="top" 标记`);
    }

    if (t.dir) {
      const dir = join(TOOLS_DIR, t.dir);
      if (!existsSync(dir)) {
        bad(`${at}：目录 tools-dev/${t.dir} 不存在`);
      } else if (t.versionFrom) {
        const v = sourceVersion(t, dir);
        if (v.error) bad(`${at}：${v.error}`);
        else if (t.version && v.version !== t.version) {
          bad(`${at}：data.json 版本 ${t.version} 与 ${v.file} 里的 ${v.version} 不一致`);
        }
      } else {
        const pkgPath = join(dir, 'package.json');
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            if (t.version && pkg.version && pkg.version !== t.version) {
              bad(`${at}：data.json 版本 ${t.version} 与 package.json 版本 ${pkg.version} 不一致`);
            }
          } catch (e) {
            bad(`${at}：${t.dir}/package.json 不是合法 JSON：${e.message}`);
          }
        }
      }
    }

    if (t.download) {
      const abs = join(TOOLS_DIR, t.download);
      if (!existsSync(abs)) bad(`${at}：下载包 tools-dev/${t.download} 不存在（跑 node tools/tools.mjs pack ${t.id}）`);
      else if (!/\.zip$/.test(t.download)) bad(`${at}：下载包必须是 .zip`);
    }
  }

  // zip 与源码的一致性：改了源码忘记 pack 会在这里被抓到
  const manifest = readManifest();
  for (const t of tools) {
    if (!t.download || !t.dir) continue;
    const m = manifest?.tools?.[t.id];
    if (!m) {
      bad(`工具 ${t.id}：manifest 里没有记录（跑 node tools/tools.mjs pack ${t.id}）`);
      continue;
    }
    if (m.zip !== t.download) bad(`工具 ${t.id}：manifest 记录的包名 ${m.zip} 与 data.json 的 ${t.download} 不一致`);
    if (m.version !== t.version) bad(`工具 ${t.id}：manifest 版本 ${m.version} ≠ data.json 版本 ${t.version}（重新 pack）`);
    const dir = join(TOOLS_DIR, t.dir);
    if (existsSync(dir)) {
      const files = walk(dir);
      const before = new Set(m.files.map((f) => f.path));
      for (const f of files) {
        if (!before.has(f)) {
          bad(`工具 ${t.id}：${f} 还没进 zip（重新 pack）`);
          continue;
        }
        const rec = m.files.find((x) => x.path === f);
        const now = sha256(readFileSync(join(dir, f)));
        if (rec.sha256 !== now) bad(`工具 ${t.id}：${f} 与 zip 里的版本不一致（重新 pack）`);
      }
      for (const rec of m.files) {
        if (!files.includes(rec.path)) bad(`工具 ${t.id}：zip 里的 ${rec.path} 已从源码删除（重新 pack）`);
      }
    }
  }

  if (disk) {
    const b = regionBounds(disk);
    if (b) {
      const diskRegion = disk.slice(b.i, b.j + LIST_END.length);
      const want = toEol(renderRegion(data), pickEol(disk));
      if (norm(diskRegion) !== norm(want)) bad('index.html 的工具清单区与 data.json 不一致（跑 node tools/tools.mjs gen）');
    }
  }
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- 命令 */

function cmdCheck() {
  const data = readData() ?? {};
  const disk = readIndex();
  validate(data, disk);
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`\n${problems.length} 个问题`);
    process.exit(1);
  }
  console.log(`✓ 工具区检查通过（${(data.tools || []).length} 个工具）`);
}

function cmdGen() {
  const data = readData();
  const disk = readIndex();
  if (!data || !disk) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  const b = regionBounds(disk);
  if (!b) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  const next = disk.slice(0, b.i) + toEol(renderRegion(data), pickEol(disk)) + disk.slice(b.j + LIST_END.length);
  if (norm(next) === norm(disk)) {
    console.log('✓ 工具清单区已是最新');
    return;
  }
  writeFileSync(INDEX_PATH, next);
  console.log('✓ 已写入 index.html 工具清单区');
}

function cmdPack(ids) {
  const data = readData();
  if (!data) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  const tools = (data.tools || []).filter((t) => ids.length === 0 || ids.includes(t.id));
  if (!tools.length) {
    console.error('✗ 没有匹配的工具（--all 或给一个 id）');
    process.exit(1);
  }
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const manifest = readManifest() ?? { tools: {} };
  manifest.tools ??= {};

  for (const t of tools) {
    if (!t.dir) {
      console.error(`✗ ${t.id}：没有 dir，无法打包`);
      process.exit(1);
    }
    const dir = join(TOOLS_DIR, t.dir);
    // 版本从源码取的工具：先对齐，否则会打出一个版本号撒谎的包
    if (t.versionFrom) {
      const v = sourceVersion(t, dir);
      if (v.error) {
        console.error(`✗ ${t.id}：${v.error}`);
        process.exit(1);
      }
      if (v.version !== t.version) {
        console.error(`✗ ${t.id}：data.json 版本 ${t.version} 与 ${v.file} 里的 ${v.version} 不一致`);
        process.exit(1);
      }
    }
    const files = walk(dir);
    const entries = files.map((rel) => ({ path: `${t.id}/${rel}`, data: readFileSync(join(dir, rel)) }));
    const zipBuf = makeZip(entries);
    const zipRel = `downloads/${t.id}-${t.version}.zip`;
    writeFileSync(join(TOOLS_DIR, zipRel), zipBuf);

    // 旧版本的包删掉，避免 downloads/ 里堆历史
    for (const old of readdirSync(DOWNLOAD_DIR)) {
      if (old.startsWith(`${t.id}-`) && old.endsWith('.zip') && old !== `${t.id}-${t.version}.zip`) {
        unlinkSync(join(DOWNLOAD_DIR, old));
      }
    }
    t.download = zipRel;
    manifest.tools[t.id] = {
      version: t.version,
      dir: t.dir,
      zip: zipRel,
      bytes: zipBuf.length,
      sha256: sha256(zipBuf),
      files: entries.map((e) => ({ path: e.path.slice(t.id.length + 1), sha256: sha256(e.data) })),
    };
    console.log(`✓ ${t.id} v${t.version} → tools-dev/${zipRel}（${files.length} 个文件，${kb(zipBuf.length)}）`);
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('✓ 已写 downloads/manifest.json');

  // data.json 的 download 字段由 pack 维护：文件名里带版本，手改必然漂移
  for (const t of tools) {
    const rec = (data.tools || []).find((x) => x.id === t.id);
    if (rec) rec.download = t.download;
  }
  writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
  console.log('✓ 已同步 tools-dev/data.json 的 download 字段');

  // 包体积也写在清单里，pack 之后清单必然过期 —— 顺手 gen，省得每次手动补一刀
  cmdGen();
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'gen') cmdGen();
else if (cmd === 'check') cmdCheck();
else if (cmd === 'pack') cmdPack(args.includes('--all') ? [] : args);
else {
  console.error('用法：node tools/tools.mjs gen|check|pack <id>|pack --all');
  process.exit(1);
}
