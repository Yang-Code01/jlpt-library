#!/usr/bin/env node
/* ============================================================================
   听力注音讲义 PDF：齐套校验

     node tools/listening-handout.mjs            # 校验（默认）
     node tools/listening-handout.mjs list       # 列出每题应有的文件名与状态

   讲义 PDF 是**已生成并入库的产物**（listening/data/N2/pdf/），源头是本地
   `.scratch/listening-pdf/`（gen.mjs + ruby.mjs + 每题补充稿，未入库，见 ADR-0009）。
   生成需要 kuromoji（40MB 词典，仓库不引入依赖），所以这里只做「不依赖任何东西」的齐套校验：
   题号 → 文件名 → 文件存在 → 是 PDF → 体量合理。

   设计约定（与 tools/test.mjs 一致）：不联网、不依赖 .scratch/、克隆即可跑。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVEL = 'N2';
const EXAMS = ['2021-07'];          // 已出讲义的卷；新增卷时在这里加
const MIN_BYTES = 50 * 1024;        // 缺字体的空壳 PDF 通常远小于此
const TARGET_PAGES = [5, 8];        // 期望页数区间（无 PDF 解析库，只能靠体量间接判断）

const c = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', d: '', b: '', x: '' };

/** 读出题库数据文件里的题目数组（数据文件是给浏览器用的全局变量赋值）。 */
function loadExam(exam) {
  const file = path.join(ROOT, 'listening', 'data', LEVEL, `${exam}.js`);
  if (!fs.existsSync(file)) throw new Error(`缺数据文件：listening/data/${LEVEL}/${exam}.js`);
  const src = fs.readFileSync(file, 'utf8');
  const win = {};
  new Function('window', src)(win);
  const key = Object.keys(win).find((k) => /^LISTENING_/.test(k));
  if (!key) throw new Error(`${exam}.js 里没有 window.LISTENING_* 变量`);
  return win[key];
}

/** 讲义文件名：202107_<section>_Q<qNo>.pdf（与音频同名规则，便于对照）。 */
const pdfName = (exam, q) => `${exam.replace('-', '')}_${q.section}_Q${q.qNo}.pdf`;

function check(verbose) {
  const rows = [];
  let bad = 0, bytes = 0;
  for (const exam of EXAMS) {
    const data = loadExam(exam);
    const qs = data.questions || [];
    if (!qs.length) { rows.push([exam, '—', '题库无题目', false]); bad++; continue; }
    const dir = path.join(ROOT, 'listening', 'data', LEVEL, 'pdf');

    // 文件名唯一性（同一节内 qNo 必须唯一，否则两题会抢同一个 PDF）
    const seen = new Map();
    for (const q of qs) {
      const name = pdfName(exam, q);
      if (seen.has(name)) {
        rows.push([exam, name, `与 ${seen.get(name)} 重名（section/qNo 冲突）`, false]); bad++;
      } else seen.set(name, `${q.id}`);
    }
    // 题号连续性（section 1..5，qNo 从 1 开始不跳号）
    const bySection = new Map();
    for (const q of qs) {
      if (!bySection.has(q.section)) bySection.set(q.section, []);
      bySection.get(q.section).push(q.qNo);
    }
    for (const [sec, nos] of [...bySection].sort((a, b) => a[0] - b[0])) {
      const sorted = [...nos].sort((a, b) => a - b);
      const want = Array.from({ length: sorted.length }, (_, i) => i + 1);
      if (sorted.join(',') !== want.join(',')) {
        rows.push([exam, `第${sec}节`, `题号不连续：${sorted.join(',')}`, false]); bad++;
      }
    }
    // 文件本身
    for (const q of qs) {
      const name = pdfName(exam, q);
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) { rows.push([exam, name, '缺文件', false]); bad++; continue; }
      const st = fs.statSync(f);
      const head = fs.readFileSync(f).subarray(0, 5).toString('latin1');
      bytes += st.size;
      if (head !== '%PDF-') { rows.push([exam, name, '不是 PDF', false]); bad++; continue; }
      if (st.size < MIN_BYTES) { rows.push([exam, name, `体积过小 ${(st.size / 1024).toFixed(0)}KB`, false]); bad++; continue; }
      rows.push([exam, name, `${(st.size / 1024).toFixed(0)}KB`, true]);
    }
    // 目录里不该有多余 PDF（改名/换卷后残留）
    const want = new Set(qs.map((q) => pdfName(exam, q)));
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.pdf'))) {
        if (!want.has(f) && f.startsWith(exam.replace('-', ''))) {
          rows.push([exam, f, '多余文件（题库里没有对应题号）', false]); bad++;
        }
      }
    }
  }

  if (verbose || bad) {
    for (const [exam, name, note, ok] of rows) {
      const mark = ok ? `${c.g}✓${c.x}` : `${c.r}✗${c.x}`;
      console.log(`  ${mark} ${exam}  ${name.padEnd(22)} ${c.d}${note}${c.x}`);
    }
  }
  const okN = rows.filter((r) => r[3]).length;
  if (bad) {
    console.log(`\n${c.r}✗ 听力讲义：${bad} 处问题（${okN} 份正常，共 ${(bytes / 1048576).toFixed(1)}MB）${c.x}`);
    return 1;
  }
  console.log(`\n${c.g}✓ 听力讲义 PDF 齐套：${okN} 份，共 ${(bytes / 1048576).toFixed(1)}MB`
    + `（期望每题 ${TARGET_PAGES[0]}–${TARGET_PAGES[1]} 页）${c.x}`);
  return 0;
}

const cmd = process.argv[2] || 'check';
if (cmd === 'list') process.exit(check(true));
if (cmd === 'check') process.exit(check(false));
console.error(`未知子命令：${cmd}（可用：check | list）`);
process.exit(2);
