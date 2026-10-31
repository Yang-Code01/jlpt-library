#!/usr/bin/env node
/* 令牌门禁（ADR-0010）
   1) 三主题 × 关键前景/背景对比度必须 ≥ AA 4.5
   2) 全站 CSS 的「组件区」不得出现裸色值 —— 色值只准出现在令牌定义里

   允许出现裸色值的地方（白名单）：
   - `:root { … }` 与 `html[data-theme="…"] { … }` 令牌块
   - `@media print { … }`（打印/PDF 主题是独立的一套纸色）
   其它任何位置出现 #hex 都算违规 —— 包括各子应用的局部调色板：
   调色板本身要写在 :root 里（typing 的 --ty-* 就是这么做的）。

   范围：9 份 CSS + 门户内联 <style> 全部。
*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');

/* ---------------- 1. 对比度 ---------------- */
const css = fs.readFileSync(path.join(ROOT, 'assets/style.css'), 'utf8');

const lum = (hex) => {
  const h = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

function tokensOf(selector) {
  const i = css.indexOf(selector);
  if (i === -1) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  const out = {};
  for (const m of css.slice(open, close).matchAll(/-{2}([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

const themes = {
  light: tokensOf(':root {'),
  eye: tokensOf('html[data-theme="eye"]'),
  dark: tokensOf('html[data-theme="dark"]'),
};

const bad = [];
for (const [name, t] of Object.entries(themes)) {
  if (!t) {
    bad.push(`${name}: 找不到令牌块`);
    continue;
  }
  const surface = t.surface || t.paper;
  for (const [key, bg, min] of [
    ['accent', t.paper, 4.5],
    ['accent', surface, 4.5],
    ['muted', t.paper, 4.5],
    ['ink', t.paper, 4.5],
    ['seal', t.paper, 4.5],
  ]) {
    const fg = t[key];
    if (!fg || !bg) {
      bad.push(`${name}: 缺 --${key} 或底色`);
      continue;
    }
    const r = ratio(fg, bg);
    if (r < min) bad.push(`${name}: --${key} ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
  }
}

/* ---------------- 2. 裸色值普查 ---------------- */
const CSS_FILES = [
  'assets/style.css',
  'en/reader.css',
  'reading/reading.css',
  'en/unit.css',
  'jp-vocab/vocab.css',
  'typing/typing.css',
  'dictation/dictation.css',
  'listening/listening.css',
  'exam/exam.css',
  'verb/vocab.css',
];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** 返回 [行号, 色值]：跳过令牌块与打印块 */
function rawHex(body, label) {
  const out = [];
  let depth = 0;
  let themeDepth = 0;
  let printDepth = 0;
  const stack = [];
  body.split('\n').forEach((ln, i) => {
    const openIdx = ln.indexOf('{');
    if (openIdx !== -1) {
      const sel = ln.slice(0, openIdx).trim();
      stack.push(sel);
      depth++;
      if (/^(:root|html\[data-theme=)/.test(sel)) themeDepth = depth;
      if (/^@media\s+print/.test(sel)) printDepth = depth;
    }
    if (!themeDepth && !printDepth) {
      /* 令牌定义本身（--x: #hex）是合法的，与它写在哪个选择器里无关 */
      const withoutTokens = ln.replace(/--[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}/g, '');
      for (const m of withoutTokens.matchAll(HEX)) out.push([i + 1, m[0], label]);
    }
    if (ln.includes('}')) {
      if (depth === themeDepth) themeDepth = 0;
      if (depth === printDepth) printDepth = 0;
      depth--;
      stack.pop();
    }
  });
  return out;
}

let checked = 0;
for (const f of CSS_FILES) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs)) continue;
  checked++;
  for (const hit of rawHex(fs.readFileSync(abs, 'utf8'), f)) bad.push(`${hit[2]}:${hit[0]} 裸色值 ${hit[1]}`);
}

/* 门户内联样式：每块单独算，块内若自带 :root 也照样放行 */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let styleCount = 0;
for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
  styleCount++;
  for (const hit of rawHex(m[1], `index.html <style#${styleCount}>`)) {
    bad.push(`${hit[2]}:${hit[0]} 裸色值 ${hit[1]}`);
  }
}

/* ---------------- 3. 站点页面的内联 <style> ----------------
   两条规矩：
   a) 内联样式里不许出现裸色值（令牌定义除外）—— 颜色只能来自 assets/style.css。
   b) 内联样式里不许重定义「核心令牌」——那是全站皮肤的唯一真源；重定义等于在该页
      悄悄换回旧配色（jp-vocab 的目录页就踩过：把 --paper/--ink/--accent 全写回旧值）。
   报告（research/）与工具详情页（tools-dev/）是自包含文档，有自己的命名空间，不在射程内。 */
const CORE_TOKENS = [
  'paper', 'surface', 'surface-2', 'ink', 'muted', 'border', 'border-soft',
  'accent', 'accent-ink', 'accent-soft', 'accent-line', 'on-accent', 'on-strong',
  'seal', 'seal-soft', 'green', 'green-l', 'red', 'red-l', 'amber',
];
const coreRe = new RegExp(
  '--(' + CORE_TOKENS.slice().sort((a, b) => b.length - a.length).map((t) => t.replace(/[-]/g, '\-')).join('|') + ')\s*:'
);
// tools/lib/dev-terms/ 是 tools-dev 那 5 个自包含页面的骨架（生成器把它们写进 tools-dev/），
// 产物已在白名单里，源与产物同属一套命名空间，一起放行。
const INLINE_SKIP = /^(research\/|tools-dev\/|tools\/lib\/dev-terms\/|tools\/tests\/|wb2api\/|pi-tui\/)/;

let pagesScanned = 0;
const tracked = execFileSync('git', ['ls-files', '*.html'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

for (const f of tracked) {
  if (INLINE_SKIP.test(f)) continue;
  pagesScanned++;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const body = m[1];
    if (coreRe.test(body)) bad.push(`${f}: 内联样式重定义了核心令牌（皮肤只能来自 assets/style.css）`);
    const clean = body.replace(/--[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}/g, '');
    for (const hit of clean.matchAll(HEX)) bad.push(`${f}: 内联样式里的裸色值 ${hit[0]}`);
  }
}

if (bad.length) {
  for (const b of bad.slice(0, 25)) console.log('✗ ' + b);
  if (bad.length > 25) console.log(`… 另有 ${bad.length - 25} 条`);
  console.log(`FAIL · ${bad.length} 处`);
  process.exit(1);
}
console.log(`OK · 三主题对比度达标；${checked} 份 CSS + ${styleCount} 段门户内联样式 + ${pagesScanned} 个站内页面，无裸色值、无令牌重定义`);
