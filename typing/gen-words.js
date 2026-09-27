#!/usr/bin/env node
/**
 * 打字素材生成器（假名 → 罗马字，见 .scratch/typing-module/PRD.md §2.3）
 *
 * 用法：node typing/gen-words.js   （在仓库根目录运行）
 *
 * 输入：n1–n5/vocab/*.html 共 76 页的词条行，形如
 *   <tr data-word="兄" data-reading="あに"><td class="w"><ruby>兄<rt>あに</rt></ruby></td>
 *       <td class="pos">名</td><td>哥哥（自己的）</td><td class="ex">…</td></tr>
 * 产出：typing/data/{simple,normal,hard}.js —— 运行时由 <script src> 按需引入。
 *
 * 抽取规则：
 *   w = data-word（词形，多形原样保留）
 *   k = data-reading；缺失（约 220 行）时回退取 class="w" 单元格内第一个 <rt> 文本
 *   m = 第 3 个 <td>（无 class）的文本
 *   p = class="pos" 单元格文本
 *
 * 过滤：k 必须为纯平假名 + 长音 ー（^[ぁ-んー]+$），据此自动剔除片假名、
 *   数字、拉丁字母、～、括号、标点、分隔符（; ・ ／ 等）；w / m 必须非空。
 * 去重：按 `w + "|" + k` 全局去重（首次出现保留）。
 *
 * 难度分档（依 PRD §2.2，长音 ー 计入假名数）：
 *   - 假名数 ≥ 5               → 困难
 *   - 含促音 っ 或 拗音小写假名（ゃゅょ） → 困难（任意长度）
 *   - 假名数 3–4 且含浊音/半浊音（が-ぽ） → 困难
 *   - 其余 1–2 假名            → 简单
 *   - 其余 3–4 假名            → 普通
 *   （即：1–2 假名的词优先留「简单」，即便含浊音；仅当含促音/拗音才升入「困难」。）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEVELS = ['n1', 'n2', 'n3', 'n4', 'n5'];
const OUT_DIR = path.join(__dirname, 'data');

/** 纯平假名 + 长音 ー */
const RE_PURE_HIRA = /^[ぁ-んー]+$/;
/** 拗音小写假名 */
const RE_YOON = /[ゃゅょ]/;
/** 浊音 / 半浊音（排除清音） */
const RE_VOICED = /[がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ]/;

/** 常见 HTML 实体 + 数字实体解码（够用即可，不引第三方库） */
function decodeEntities(s) {
  return s
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

/** 收集全部词条文件（按路径排序，保证产物幂等） */
function collectFiles() {
  const files = [];
  for (const level of LEVELS) {
    const dir = path.join(ROOT, level, 'vocab');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.html')) files.push(path.join(dir, name));
    }
  }
  return files.sort();
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

/** 难度分档，返回 simple / normal / hard */
function classify(k) {
  const len = [...k].length; // 长音 ー 计入长度
  if (len >= 5) return 'hard';
  if (k.includes('っ') || RE_YOON.test(k)) return 'hard';
  if (len >= 3 && RE_VOICED.test(k)) return 'hard';
  if (len <= 2) return 'simple';
  return 'normal';
}

function main() {
  const files = collectFiles();
  const seen = new Set();
  const buckets = { simple: [], normal: [], hard: [] };
  const stats = { rows: 0, parsed: 0, usedReading: 0, usedFallback: 0, dup: 0, filtered: 0 };

  for (const file of files) {
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
      if (seen.has(key)) {
        stats.dup++;
        continue;
      }
      seen.add(key);

      const hasReading = /data-reading="[^"]+"/.test(line);
      if (hasReading) stats.usedReading++;
      else stats.usedFallback++;

      buckets[classify(entry.k)].push(entry);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const names = { simple: 'TYPING_WORDS_SIMPLE', normal: 'TYPING_WORDS_NORMAL', hard: 'TYPING_WORDS_HARD' };

  for (const tier of ['simple', 'normal', 'hard']) {
    const body = buckets[tier]
      .map((e) => JSON.stringify(e))
      .join(',\n');
    const out =
      '// 由 typing/gen-words.js 生成，请勿手改。\n' +
      `window.${names[tier]} = [\n${body}\n];\n`;
    fs.writeFileSync(path.join(OUT_DIR, tier + '.js'), out, 'utf8');
  }

  console.log(`扫描文件：${files.length}`);
  console.log(`词条行：${stats.rows}　解析成功：${stats.parsed}　过滤丢弃：${stats.filtered}　去重丢弃：${stats.dup}`);
  console.log(`  其中 data-reading：${stats.usedReading}　rt 回退：${stats.usedFallback}`);
  console.log(`分档：简单 ${buckets.simple.length}　普通 ${buckets.normal.length}　困难 ${buckets.hard.length}`);
  console.log(`合计 ${buckets.simple.length + buckets.normal.length + buckets.hard.length} 条，已写入 typing/data/`);
}

main();
