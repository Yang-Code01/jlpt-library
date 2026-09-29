#!/usr/bin/env node
/**
 * 打字素材生成器（假名 → 罗马字）
 *
 * 用法：node typing/gen-words.js   （在仓库根目录运行）
 *
 * 输入：n1–n5/vocab/*.html 共 76 页的词条行，形如
 *   <tr data-word="兄" data-reading="あに"><td class="w"><ruby>兄<rt>あに</rt></ruby></td>
 *       <td class="pos">名</td><td>哥哥（自己的）</td><td class="ex">…</td></tr>
 * 产出：typing/data/{n5,n4,n3,n2,n1}.js —— 运行时由 <script src> 按需引入。
 *   难度档 = JLPT 等级（N5 最易 → N1 最难），每档独立词表；
 *   传送带速度不再与难度挂钩，由用户自选倍率。
 *
 * 抽取规则：
 *   w = data-word（词形，多形原样保留）
 *   k = data-reading；缺失（约 220 行）时回退取 class="w" 单元格内第一个 <rt> 文本
 *   m = 第 3 个 <td>（无 class）的文本
 *   p = class="pos" 单元格文本
 *
 * 过滤：k 必须为纯平假名 + 长音 ー（^[ぁ-んー]+$），据此自动剔除片假名、
 *   数字、拉丁字母、～、括号、标点、分隔符（; ・ ／ 等）；w / m 必须非空。
 * 分档：按词条所在目录（n5–n1）分档，不再做假名数分档。
 * 去重：按 `w + "|" + k` 档内去重（同一词可同时出现在两个等级）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEVELS = ['n5', 'n4', 'n3', 'n2', 'n1'];
const OUT_DIR = path.join(__dirname, 'data');

/** 纯平假名 + 长音 ー */
const RE_PURE_HIRA = /^[ぁ-んー]+$/;

/** 常见 HTML 实体 + 数字实体解码（够用即可，不引第三方库） */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/** 去标签 + 解码实体 + 折叠空白 */
function toText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ''))
    .replace(/[\u3000\s]+/g, ' ')
    .trim();
}

/** 收集全部词条文件（按路径排序，保证产物幂等），附来源等级 */
function collectFiles() {
  const files = [];
  for (const level of LEVELS) {
    const dir = path.join(ROOT, level, 'vocab');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.html')) files.push({ level, file: path.join(dir, name) });
    }
  }
  return files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** 解析单行词条；返回 {w,k,m,p} 或 null */
function parseRow(line) {
  const wRaw = (line.match(/data-word="([^"]*)"/) || [])[1];
  if (wRaw == null) return null;

  const tds = [...line.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  if (tds.length < 4) return null;

  const w = toText(wRaw);
  const p = toText(tds[1]); // class="pos"
  const m = toText(tds[2]); // 第 3 个 <td>（无 class）
  if (!w || !m) return null;

  // data-reading 优先；缺失或为空则回退 class="w" 单元格内第一个 <rt>
  let k = null;
  const reading = (line.match(/data-reading="([^"]*)"/) || [])[1];
  if (reading != null && reading.trim() !== '') {
    k = toText(reading);
  } else {
    const rt = (tds[0].match(/<rt>([\s\S]*?)<\/rt>/) || [])[1];
    if (rt != null) k = toText(rt);
  }

  // 过滤：k 必须为纯平假名 + 长音 ー
  if (!k || !RE_PURE_HIRA.test(k)) return null;

  return { w, k, m, p };
}

function main() {
  const files = collectFiles();
  const buckets = { n5: [], n4: [], n3: [], n2: [], n1: [] };
  const stats = { rows: 0, parsed: 0, usedReading: 0, usedFallback: 0, dup: 0, filtered: 0 };

  const seen = { n5: new Set(), n4: new Set(), n3: new Set(), n2: new Set(), n1: new Set() }; // 去重只在档内进行

  for (const { level, file } of files) {
    const html = fs.readFileSync(file, 'utf8');
    for (const line of html.split(/\r?\n/)) {
      if (!line.includes('data-word=')) continue;
      stats.rows++;

      const entry = parseRow(line);
      if (!entry) {
        stats.filtered++;
        continue;
      }
      stats.parsed++;

      const key = entry.w + '|' + entry.k;
      if (seen[level].has(key)) {
        stats.dup++;
        continue;
      }
      seen[level].add(key);

      const hasReading = /data-reading="[^"]+"/.test(line);
      if (hasReading) stats.usedReading++;
      else stats.usedFallback++;

      buckets[level].push(entry);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const tier of LEVELS) {
    const body = buckets[tier]
      .map((e) => JSON.stringify(e))
      .join(',\n');
    const out =
      '// 由 typing/gen-words.js 生成，请勿手改。\n' +
      `window.TYPING_WORDS_${tier.toUpperCase()} = [\n${body}\n];\n`;
    fs.writeFileSync(path.join(OUT_DIR, tier + '.js'), out, 'utf8');
  }

  console.log(`扫描文件：${files.length}`);
  console.log(`词条行：${stats.rows}　解析成功：${stats.parsed}　过滤丢弃：${stats.filtered}　去重丢弃：${stats.dup}`);
  console.log(`  其中 data-reading：${stats.usedReading}　rt 回退：${stats.usedFallback}`);
  console.log('分档：' + LEVELS.map((t) => `${t.toUpperCase()} ${buckets[t].length}`).join('　'));
  console.log(`合计 ${LEVELS.reduce((s, t) => s + buckets[t].length, 0)} 条，已写入 typing/data/`);
}

main();