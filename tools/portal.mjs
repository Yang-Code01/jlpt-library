#!/usr/bin/env node
/* ============================================================================
   门户进度分母（ADR-0010）
   ----------------------------------------------------------------------------
   门户卡片上「已看 42 / 168」的分母不能手写：单元页会增减。本工具扫目录生成
   assets/units.js（window.WB_UNITS），供 assets/portal.js 用 LibProgress 取分子。

   用法：
     node tools/portal.mjs gen     # 写 assets/units.js
     node tools/portal.mjs check   # 校验清单 ≡ 实际文件集合，且字节与生成一致

   分桶：
     ja           n1..n5 下 basics/grammar/vocab 的单元页（168）
     en-vocab     en/1k..4k 的单元页（77）
     en-reading   en/reading/<band>/*.html（30，不含 index.html）
     jp-reading   reading/<n3|n2|n1>/*.html（篇目正文，不含 index.html）

   ⚠ 只收「单元页」，不收目录页（index.html）与其它入口页。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'assets/units.js');

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function scan() {
  const ja = [];
  for (const lv of ['n1', 'n2', 'n3', 'n4', 'n5']) {
    for (const sub of ['basics', 'grammar', 'vocab']) {
      const dir = path.join(ROOT, lv, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of listDir(dir)) {
        if (f.isFile() && f.name.endsWith('.html') && f.name !== 'index.html') ja.push(`${lv}/${sub}/${f.name}`);
      }
    }
  }

  const enVocab = [];
  for (const band of ['1k', '2k', '3k', '4k']) {
    const dir = path.join(ROOT, 'en', band);
    if (!fs.existsSync(dir)) continue;
    for (const f of listDir(dir)) {
      if (f.isFile() && f.name.endsWith('.html')) enVocab.push(`en/${band}/${f.name}`);
    }
  }

  const enReading = [];
  const rdir = path.join(ROOT, 'en', 'reading');
  if (fs.existsSync(rdir)) {
    for (const band of listDir(rdir)) {
      if (!band.isDirectory() || !/^[1-4]k$/.test(band.name)) continue;
      for (const f of listDir(path.join(rdir, band.name))) {
        if (f.isFile() && f.name.endsWith('.html') && f.name !== 'index.html') {
          enReading.push(`en/reading/${band.name}/${f.name}`);
        }
      }
    }
  }

  const jpReading = [];
  for (const band of ['n3', 'n2', 'n1']) {
    const dir = path.join(ROOT, 'reading', band);
    if (!fs.existsSync(dir)) continue;
    for (const f of listDir(dir)) {
      if (f.isFile() && f.name.endsWith('.html') && f.name !== 'index.html') {
        jpReading.push(`reading/${band}/${f.name}`);
      }
    }
  }

  const sort = (a) => a.sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
  return { ja: sort(ja), 'en-vocab': sort(enVocab), 'en-reading': sort(enReading), 'jp-reading': sort(jpReading) };
}

function render(data) {
  const lines = Object.entries(data).map(
    ([k, v]) => `  ${JSON.stringify(k)}: [\n` + v.map((p) => `    ${JSON.stringify(p)}`).join(',\n') + '\n  ],'
  );
  return (
    '/* 门户进度分母：由 tools/portal.mjs gen 生成，勿手改。\n' +
    '   数据源 = 目录扫描；check 会校验「清单 ≡ 实际文件集合」。 */\n' +
    'window.WB_UNITS = {\n' +
    lines.join('\n') +
    '\n};\n'
  );
}

const data = scan();
const want = render(data);

if (process.argv[2] === 'gen') {
  fs.writeFileSync(OUT, want, 'utf8');
  const total = Object.values(data).reduce((n, v) => n + v.length, 0);
  console.log(`✓ assets/units.js · ${Object.keys(data).length} 桶 / ${total} 个单元`);
} else if (process.argv[2] === 'check') {
  if (!fs.existsSync(OUT)) {
    console.log('✗ assets/units.js 不存在（跑 node tools/portal.mjs gen）');
    process.exit(1);
  }
  const have = fs.readFileSync(OUT, 'utf8');
  const bad = [];
  if (have !== want) bad.push('assets/units.js 与目录扫描结果不一致（跑 gen）');

  // 清单里的每个路径都必须真的有文件
  for (const [k, list] of Object.entries(data)) {
    for (const p of list) if (!fs.existsSync(path.join(ROOT, p))) bad.push(`${k}: 清单里的 ${p} 不存在`);
  }
  // 反向：目录里有的单元页必须在清单里（扫描本身保证，这里防手改）
  const declared = new Set(Object.values(data).flat());
  for (const lv of ['n1', 'n2', 'n3', 'n4', 'n5']) {
    for (const sub of ['basics', 'grammar', 'vocab']) {
      const dir = path.join(ROOT, lv, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of listDir(dir)) {
        const p = `${lv}/${sub}/${f.name}`;
        if (f.isFile() && f.name.endsWith('.html') && f.name !== 'index.html' && !declared.has(p)) {
          bad.push(`目录里有 ${p} 但清单没有`);
        }
      }
    }
  }

  if (bad.length) {
    for (const b of bad.slice(0, 10)) console.log('✗ ' + b);
    console.log(`FAIL · ${bad.length} 处`);
    process.exit(1);
  }
  const total = Object.values(data).reduce((n, v) => n + v.length, 0);
  console.log(`OK · ${Object.keys(data).length} 桶 / ${total} 个单元，清单与文件集合一致`);
} else {
  console.log('用法：node tools/portal.mjs <gen|check>');
  process.exit(2);
}
