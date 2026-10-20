#!/usr/bin/env node
/* ============================================================================
   左栏注入器（ADR-0010）
   ----------------------------------------------------------------------------
   把 tools/shell.mjs 的 railHtml() 写进手写页与生成页，并给 <body> 打 has-rail。
   左栏是最小公倍数的一层导航：一屏点到 11 个模块，不用回首页。

   用法：
     node tools/rail.mjs gen       # 写入/刷新全部页面的左栏
     node tools/rail.mjs check     # 校验：每页恰一块、内容一致、body 带 has-rail

   规则：
     - 跳过 index.html（门户自己就是工作台壳）与 research/*.html（报告自带外壳）
     - 标记区 <!-- wb:rail:start/end --> 之间归本工具所有，别手改
     - 按目标文件现有行尾写回（ADR-0004：新内容用 LF，但既有 CRLF 文件保持原样）
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { railHtml, prefixOf, activeOf, RAIL_START, RAIL_END } from './shell.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
/* 跳过：门户自己就是工作台壳；报告自带外壳；fixtures 与 vendored 源码不是站点页面 */
const SKIP = /^index\.html$|^research\/|^tools\/tests\/|^wb2api\/|^pi-tui\//;

/* 只注入「接了共享样式」的页面：没引 assets/style.css 的页面（自包含详情页）
   拿不到左栏样式，注进去只会是一坨裸 DOM。 */
const needsSharedCss = (html) => /<link[^>]+href="[^"]*assets\/style\.css"/.test(html);

function trackedHtml() {
  const out = execFileSync('git', ['ls-files', '*.html'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** 把 rail 块塞进页面：优先替换既有标记区，否则插到 <body> 之后 */
function withRail(html, file) {
  const prefix = prefixOf(file);
  const rail = railHtml({ prefix, active: activeOf(file) }).replace(/\n/g, eolOf(html));

  let next;
  const start = html.indexOf(RAIL_START);
  if (start !== -1) {
    const end = html.indexOf(RAIL_END, start);
    if (end === -1) throw new Error(`${file}: 有 wb:rail:start 但没有 end`);
    next = html.slice(0, start) + rail + html.slice(end + RAIL_END.length);
  } else {
    const bodyIdx = html.search(/<body[^>]*>/);
    if (bodyIdx === -1) throw new Error(`${file}: 找不到 <body>`);
    const bodyTagEnd = html.indexOf('>', bodyIdx) + 1;
    next = html.slice(0, bodyTagEnd) + '\n    ' + rail + html.slice(bodyTagEnd);
  }

  // <body> 打 has-rail（样式靠它给内容让出 56px）
  next = next.replace(/<body(?![^>]*\bhas-rail\b)([^>]*)>/, '<body class="has-rail"$1>');
  return next;
}

function gen() {
  const files = trackedHtml().filter((f) => !SKIP.test(f));
  let written = 0;
  let skipped = 0;
  for (const file of files) {
    const abs = path.join(ROOT, file);
    const before = fs.readFileSync(abs, 'utf8');
    if (!/<body/.test(before) || !needsSharedCss(before)) {
      skipped++;
      continue;
    }
    const after = withRail(before, file);
    if (after !== before) {
      fs.writeFileSync(abs, after, 'utf8');
      written++;
    }
  }
  console.log(`✓ 左栏写入 ${written} 页（扫到 ${files.length} 页，跳过 ${skipped} 无 body 的文件）`);
}

function check() {
  const files = trackedHtml().filter((f) => !SKIP.test(f));
  const problems = [];
  let withBlocks = 0;

  for (const file of files) {
    const abs = path.join(ROOT, file);
    const html = fs.readFileSync(abs, 'utf8');
    if (!/<body/.test(html) || !needsSharedCss(html)) continue;

    const starts = html.split(RAIL_START).length - 1;
    const ends = html.split(RAIL_END).length - 1;
    if (starts === 0) {
      problems.push(`${file}: 缺 wb:rail 标记区`);
      continue;
    }
    if (starts !== 1 || ends !== 1) {
      problems.push(`${file}: 标记区数量异常（start ${starts} / end ${ends}）`);
      continue;
    }
    withBlocks++;

    const want = railHtml({ prefix: prefixOf(file), active: activeOf(file) }).replace(/\n/g, eolOf(html));
    const body = html.slice(html.indexOf(RAIL_START), html.indexOf(RAIL_END) + RAIL_END.length);
    if (body !== want) problems.push(`${file}: 左栏块与 shell.mjs 的输出不一致（跑了 gen 又被手改？）`);

    if (!/<body[^>]*class="[^"]*has-rail/.test(html)) problems.push(`${file}: <body> 缺 has-rail 类`);
    if (/fetch\s*\(|XMLHttpRequest/.test(body)) problems.push(`${file}: 左栏块里出现 fetch/XHR（file:// 硬约束）`);

    // 相对前缀必须真实可达
    const m = body.match(/class="wb-rail-brand" href="([^"]+)"/);
    if (m) {
      const target = path.resolve(path.dirname(abs), m[1]);
      if (!fs.existsSync(target)) problems.push(`${file}: 左栏回工作台的链接指向不存在的 ${m[1]}`);
    }
  }

  if (problems.length) {
    for (const p of problems.slice(0, 20)) console.log('✗ ' + p);
    if (problems.length > 20) console.log(`… 另有 ${problems.length - 20} 条`);
    console.log(`FAIL · ${problems.length} 处问题`);
    process.exit(1);
  }
  console.log(`OK · ${withBlocks} 个页面的左栏一致`);
}

const cmd = process.argv[2];
if (cmd === 'gen') gen();
else if (cmd === 'check') check();
else {
  console.log('用法：node tools/rail.mjs <gen|check>');
  process.exit(2);
}
