#!/usr/bin/env node
/**
 * 《vibecoding 术语图解》生成 / 校验。
 *
 *   node tools/dev-terms-gen.mjs gen     # 由源生成 5 个页面（1 个目录页 + 4 册）
 *   node tools/dev-terms-gen.mjs check   # 重跑一遍与已入库的页面逐字节比
 *
 * 源在 tools/lib/dev-terms/：
 *   terms.json    books（4 册）+ groups（每组 8–20 条）+ terms（真源：术语、大白话、坑、图 spec）
 *   figs.js       18 个图型模板（340×150 viewBox，配色全在页面 CSS 里）
 *   page.html     一册的整页骨架，两个注入点：/*__FIGS__*\/ 与 /*__TERMS__*\/
 *   landing.html  目录页骨架（跨四册搜索），两个注入点：/*__BOOKS__*\/ 与 /*__INDEX__*\/
 *
 * 页面必须自包含（无外链 css/js、无 fetch，file:// 直开），所以这里只做
 * 「源 → 单文件 HTML」的文本拼装。行尾统一 LF（docs/adr/0004）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'tools/lib/dev-terms');
const OUTDIR = join(ROOT, 'tools-dev');
const LANDING = 'dev-terms.html';
const TEMPLATES = ['flow', 'fanout', 'merge', 'layers', 'nest', 'gate', 'store', 'cacheflow',
  'queue', 'segments', 'compare', 'compare3', 'timeline', 'cycle', 'tree', 'rings', 'twice', 'variants'];
const MIN_GROUP = 8, MAX_GROUP = 20;
const out_ = (s) => process.stdout.write(s + String.fromCharCode(10));
const err_ = (s) => process.stderr.write(s + String.fromCharCode(10));

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** 页面里术语锚点的算法（page.html 与目录页必须一致） */
const slug = (en, no) => 't-' + en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + no;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function load() {
  let data;
  try {
    data = JSON.parse(read(join(SRC, 'terms.json')));
  } catch (e) {
    throw new Error(`terms.json 不是合法 JSON：${e.message}`);
  }
  const figsSrc = read(join(SRC, 'figs.js'));
  const page = read(join(SRC, 'page.html'));
  const landing = read(join(SRC, 'landing.html'));
  for (const k of ['books', 'groups', 'terms']) {
    if (!Array.isArray(data[k]) || !data[k].length) throw new Error(`terms.json：${k} 不能为空`);
  }
  return { data, figsSrc, page, landing };
}

function validate(data) {
  const bookKeys = new Set();
  for (const b of data.books) {
    for (const k of ['k', 'name', 'sub', 'file', 'desc']) {
      if (!b[k] || typeof b[k] !== 'string') throw new Error(`册缺字段 ${k}：${JSON.stringify(b)}`);
    }
    if (!Array.isArray(b.groups) || !b.groups.length) throw new Error(`册 ${b.k}：groups 不能为空`);
    if (bookKeys.has(b.k)) throw new Error(`册重名：${b.k}`);
    bookKeys.add(b.k);
  }
  if (data.books.some((b) => b.file === LANDING)) throw new Error(`目录页文件名不能与册文件重名：${LANDING}`);

  const groupKeys = new Set(), groupOfBook = new Map();
  for (const b of data.books) {
    for (const k of b.groups) {
      if (groupOfBook.has(k)) throw new Error(`组 ${k} 同时被两册引用`);
      groupOfBook.set(k, b.k);
    }
  }
  for (const g of data.groups) {
    for (const k of ['k', 'name', 'tag']) {
      if (!g[k] || typeof g[k] !== 'string') throw new Error(`组缺字段 ${k}：${JSON.stringify(g)}`);
    }
    if (groupKeys.has(g.k)) throw new Error(`组重名：${g.k}`);
    groupKeys.add(g.k);
    if (g.book !== groupOfBook.get(g.k)) {
      throw new Error(`组 ${g.k} 的 book=${g.book}，但它被册 ${groupOfBook.get(g.k)} 引用`);
    }
  }
  for (const [k, b] of groupOfBook) if (!groupKeys.has(k)) throw new Error(`册 ${b} 引用了不存在的组 ${k}`);

  const seen = new Set(), perGroup = {};
  for (const t of data.terms) {
    const at = t.en || '(空术语)';
    for (const k of ['g', 'en', 'cn', 'p', 'q']) {
      if (!t[k] || typeof t[k] !== 'string') throw new Error(`${at}：缺字段 ${k}`);
    }
    if (!groupKeys.has(t.g)) throw new Error(`${at}：组 ${t.g} 不存在`);
    if (!t.f || !TEMPLATES.includes(t.f.t)) throw new Error(`${at}：图型不认识 ${t.f && t.f.t}`);
    if (seen.has(t.en)) throw new Error(`${at}：术语重名`);
    seen.add(t.en);
    perGroup[t.g] = (perGroup[t.g] || 0) + 1;
  }
  // 组可以是「草稿」（0 条，还没写），但一旦开始写就必须凑够 MIN_GROUP 条，避免半成品混进页面
  let drafts = 0;
  for (const g of data.groups) {
    const n = perGroup[g.k] || 0;
    if (n === 0) { drafts += 1; continue; }
    if (n < MIN_GROUP || n > MAX_GROUP) throw new Error(`组 ${g.k} 有 ${n} 条（应为 ${MIN_GROUP}–${MAX_GROUP}）`);
  }
  data.__drafts = drafts;
}

function render(data, figsSrc) {
  const ctx = { window: {} };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(figsSrc, ctx);
  const FIGS = ctx.window.FIGS;
  if (!FIGS || typeof FIGS.render !== 'function') throw new Error('figs.js 没有导出 window.FIGS.render');

  for (const t of data.terms) {
    const svg = FIGS.render(t.f);
    if (typeof svg !== 'string' || !svg.startsWith('<svg') || !svg.endsWith('</svg>')) {
      throw new Error(`${t.en}：图渲染失败`);
    }
  }

  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const groupBy = (k) => data.groups.find((g) => g.k === k);
  const books = data.books.map((b) => {
    const gs = b.groups.map(groupBy);
    let cnt = 0;
    for (const g of gs) for (const t of data.terms) if (t.g === g.k) cnt += 1;
    return {
      k: b.k, name: b.name, sub: b.sub, file: b.file, desc: b.desc, count: cnt,
      groups: gs.map((g) => ({ k: g.k, name: g.name })),
    };
  });
  const index = [];
  const files = [];

  for (const b of data.books) {
    const groups = b.groups.map(groupBy);
    const terms = [];
    for (const g of groups) for (const t of data.terms) if (t.g === g.k) terms.push(t);
    let no = 0;
    const rows = terms.map((t) => {
      no += 1;
      return Object.assign({ _no: no, _id: slug(t.en, no) }, t);
    });
    for (const r of rows) {
      index.push({ id: r._id, en: r.en, cn: r.cn, p: r.p, f: b.file, bn: b.name, gn: groupBy(r.g).name });
    }

    const payload = {
      groups: groups.map((g) => ({ k: g.k, name: g.name, tag: g.tag })),
      terms: rows.map((r) => ({ g: r.g, en: r.en, cn: r.cn, p: r.p, q: r.q, f: r.f, _no: r._no, _id: r._id })),
    };
    let html = data.__page
      .replace('/*__FIGS__*/', () => figsSrc.trim())
      .replace('/*__TERMS__*/', () => 'window.GROUPS = ' + json(payload.groups) + ';\nwindow.TERMS = ' + json(payload.terms) + ';\nwindow.BOOKS = ' + json(books) + ';\nwindow.CUR_BOOK = ' + json(b.k) + ';')
      .split('{{BOOK_TITLE}}').join(esc(b.name))
      .split('{{BOOK_NAME}}').join(esc(b.name))
      .split('{{BOOK_SUB}}').join(esc(b.sub))
      .split('{{BOOK_K}}').join(b.k)
      .split('{{BOOK_LEDE}}').join(b.desc)
      .split('{{N}}').join(String(rows.length))
      .split('{{G}}').join(String(groups.length));
    files.push({ file: b.file, html: html, n: rows.length, g: groups.length });
  }

  let landing = data.__landing
    .replace('/*__BOOKS__*/', () => json(books))
    .replace('/*__INDEX__*/', () => json(index))
    .split('{{N}}').join(String(data.terms.length))
    .split('{{G}}').join(String(data.groups.length));
  files.push({ file: LANDING, html: landing, n: data.terms.length, g: data.groups.length, landing: true });

  for (const f of files) {
    f.html = f.html.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    for (const bad of ['/*__FIGS__*/', '/*__TERMS__*/', '/*__BOOKS__*/', '/*__INDEX__*/']) {
      if (f.html.includes(bad)) throw new Error(`${f.file}：注入点没被替换干净（${bad}）`);
    }
    if (/\{\{[A-Z_]+\}\}/.test(f.html)) throw new Error(`${f.file}：还有没替换的占位 ${f.html.match(/\{\{[A-Z_]+\}\}/)[0]}`);
  }
  return { files, books, index };
}

function main() {
  const cmd = process.argv[2] || 'check';
  if (!['gen', 'check'].includes(cmd)) {
    err_('用法：node tools/dev-terms-gen.mjs gen|check');
    process.exit(2);
  }
  let out;
  try {
    const { data, figsSrc, page, landing } = load();
    data.__page = page;
    data.__landing = landing;
    validate(data);
    out = render(data, figsSrc);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  if (cmd === 'gen') {
    if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
    for (const f of out.files) writeFileSync(join(OUTDIR, f.file), f.html, 'utf8');
    const kb = out.files.reduce((a, f) => a + f.html.length, 0) / 1024;
    out_(`✓ 已写入 tools-dev/：目录页 + ${out.books.length} 册（${out.index.length} 条 · ${out.files.length} 个文件 · ${kb.toFixed(1)} KB）`);
    for (const b of out.books) out_('  · ' + b.file + '  ' + b.name + '  ' + b.count + ' 条 / ' + b.groups.length + ' 组');
    return;
  }

  let bad = 0;
  for (const f of out.files) {
    const p = join(OUTDIR, f.file);
    if (!existsSync(p)) {
      err_(`✗ tools-dev/${f.file} 不存在（跑 node tools/dev-terms-gen.mjs gen）`);
      bad = 1;
      continue;
    }
    const cur = read(p);
    if (cur === f.html) continue;
    bad = 1;
    const a = cur.split('\n'), b = f.html.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        err_(`✗ ${f.file} 与源不一致，首个分叉在第 ${i + 1} 行（跑 node tools/dev-terms-gen.mjs gen 重生成）`);
        err_(`  当前：${String(a[i] ?? '').slice(0, 120)}`);
        err_(`  应为：${String(b[i] ?? '').slice(0, 120)}`);
        break;
      }
    }
  }
  if (bad) process.exit(1);
  out_('✓ 术语图解与源一致（' + out.index.length + ' 条 · ' + out.files.length + ' 个页面）');
}

main();
