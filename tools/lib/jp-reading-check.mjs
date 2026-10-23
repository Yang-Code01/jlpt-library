/* ============================================================================
   日语阅读 · 校验（check）

   这是本模块唯一的测试缝：机械校验 + 行为断言都放在这里，登进 tools/test.mjs 的
   静态校验清单（`node tools/test.mjs` 会跑它，失败退出码 1）。

   分两层：
     Tier 1  不需要网络也不需要 .scratch 缓存 —— 生成物 ≡ 注释真源、段落完备、
             注記零残留、高亮判据单一真源、点词/盖章的沙箱行为、生成器幂等、
             活用还原模板用例、file:// 守卫、门槛与署名。
     Tier 2  需要 .scratch/jp-reading/（青空正文 + JMdict）—— 正文 ≡ 缓存原文、
             词表与非高频词集合现场重算、分档字数一致。默认跳过，
             设 JP_READING_TIER2=1（或跑 node tools/test.mjs --all）才执行。
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildLexicon, paragraphsOf, resolveAll, plainOf, parseInline } from './katsuyo.mjs';
import { oldKanaHits } from './aozora.mjs';
import { buildPayload, generate, pagePathOf } from './jp-reading-gen.mjs';

const require = createRequire(import.meta.url);
const H = require('../tests/dom.js');

const ESC_CLOSE = '<' + String.fromCharCode(92) + '/';
const BANDS = new Set(['n3', 'n2', 'n1']);

const decode = (s) =>
  String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const stripTags = (s) => decode(String(s).replace(/<rt>[^<]*<\/rt>/g, '').replace(/<[^>]+>/g, ''));

export function readPayload(file) {
  const html = fs.readFileSync(file, 'utf8');
  const at = html.indexOf('window.JP_READING = ');
  if (at < 0) throw new Error('页面里没有 window.JP_READING：' + file);
  const start = at + 'window.JP_READING = '.length;
  const end = html.indexOf('</script>', start);
  let raw = html.slice(start, end).trim();
  if (raw.endsWith(';')) raw = raw.slice(0, -1);
  return JSON.parse(raw.split(ESC_CLOSE).join('</'));
}

function sandbox(rel) {
  const abs = path.join(process.cwd(), ...rel.split('/'));
  const page = fs.readFileSync(abs, 'utf8');
  const sb = H.makeSandbox({ pathname: '/' + rel, html: page });
  const dir = path.posix.dirname('/' + rel);
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(page))) {
    const src = /\ssrc="([^"]+)"/.exec(m[1]);
    if (src) {
      const p = path.posix.normalize(dir + '/' + src[1]).replace(/^\//, '');
      H.runFile(sb, path.join(process.cwd(), ...p.split('/')));
    } else if (m[2].trim()) {
      H.run(sb, m[2], rel);
    }
  }
  return sb;
}

/** 活用／分词的固定用例：退化就失败（这是「能失败的断言」，不是打印布尔值） */
const SEGMENT_CASES = [
  ['走った', '走る'], ['走れば', '走る'], ['書いて', '書く'], ['読んだ', '読む'],
  ['話して', '話す'], ['食べない', '食べる'], ['高かった', '高い'], ['住んで', '住む'],
  ['つかみ', '掴む'], ['出して', '出す'], ['のせて', '乗せる'], ['ふりかえって', '振り返る'],
  ['ひびいて', '響く'], ['しげった', '茂る'], ['なげこみました', '投げ込む'],
  ['はなれません', '放れる'], ['かかって', '掛かる'], ['どなり', '怒鳴る'],
  ['こみました', '込む'], ['くだき', '砕く'], ['にげよう', '逃げる'], ['つかめ', '掴む'],
];

export function check({ root, works, log, tier2 }) {
  const pass = [];
  const fails = [];
  const ok = (cond, name, extra) => {
    if (cond) pass.push(name);
    else fails.push(name + (extra ? '  ::  ' + extra : ''));
  };

  const scratch = path.join(root, '.scratch', 'jp-reading');
  const notesDir = path.join(root, 'reading', 'notes');
  const pageDir = path.join(root, 'reading');

  /* ---- 1. 集合：注释真源 ≡ 生成物 ---- */
  const notesIds = fs.existsSync(notesDir)
    ? fs.readdirSync(notesDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
    : [];
  const pages = [];
  for (const band of BANDS) {
    const dir = path.join(pageDir, band);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.html')) pages.push(`${band}/${f}`);
    }
  }
  pages.sort();
  ok(notesIds.length > 0, '注释真源存在（reading/notes/*.json）');
  ok(
    pages.length === notesIds.length,
    `生成物数量 ≡ 注释真源数量（${pages.length} / ${notesIds.length}）`,
    '多出来的页面：' + pages.filter((p) => !notesIds.includes(path.basename(p, '.html'))).join('、')
  );
  /* 页面与真源必须成对出现：只写了一半（有真源没生成 / 有页面没真源）都算不一致。
     三篇是否都齐，由 --all 验收时用 JP_READING_REQUIRE_ALL=1 另外要求。 */
  for (const work of works) {
    const id = work.id;
    const hasPage = fs.existsSync(pagePathOf(root, work));
    const hasNotes = fs.existsSync(path.join(notesDir, id + '.json'));
    ok(hasPage === hasNotes, `${id} 生成页与注释真源成对`, `页面:${hasPage} 真源:${hasNotes}`);
    if (process.env.JP_READING_REQUIRE_ALL === '1') {
      ok(hasPage && hasNotes, `${id} 已完成（验收要求三篇齐）`);
    }
  }

  /* ---- 1b. 台账：来源与许可必须写清楚（不是"以后再补"） ---- */
  const readmeFile = path.join(root, 'reading', 'README.md');
  const readme = fs.existsSync(readmeFile) ? fs.readFileSync(readmeFile, 'utf8') : '';
  ok(!!readme, 'reading/README.md 存在');
  for (const [label, needle] of [
    ['青空文庫 来源', '青空文庫'],
    ['JMdict 许可', 'CC BY-SA'],
    ['站点许可', 'CC BY-NC'],
    ['生成用法', 'jp-reading.mjs'],
  ]) {
    ok(readme.includes(needle), `台账标了${label}`);
  }

  /* ---- 1c. 旧仮名闸门：三个固定样本（不靠缓存） ---- */
  ok(oldKanaHits('けふの空は美し。').length > 0, '旧仮名样本被闸门拦住（けふ）');
  ok(oldKanaHits('むかしは、私たちの村のちかくの。').length === 0, '新仮名样本放行');
  ok(oldKanaHits('こないだうなぎをぬすんだ').length === 0, '子串陷阱不被误判（だ＋うなぎ）');

  /* ---- 2. file:// 守卫：新目录里不许出现 fetch/XHR ---- */
  const jsFiles = [`reading/${'reading'}.js`].concat(
    fs.existsSync(pageDir) ? fs.readdirSync(pageDir).filter((f) => f.endsWith('.js')).map((f) => 'reading/' + f) : []
  );
  for (const rel of jsFiles) {
    const abs = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    ok(!/\bfetch\s*\(/.test(src) && !/XMLHttpRequest/.test(src), `${rel} 不含 fetch/XHR`);
  }

  /* ---- 3. 逐篇：载荷自洽 ---- */
  const sandboxes = [];
  for (const work of works) {
    const page = pagePathOf(root, work);
    if (!fs.existsSync(page)) continue;
    const rel = `reading/${work.band}/${String(work.no).padStart(2, '0')}.html`;
    const html = fs.readFileSync(page, 'utf8');
    let payload;
    try {
      payload = readPayload(page);
    } catch (e) {
      ok(false, `${work.id} 载荷可解析`, e.message);
      continue;
    }
    const notes = JSON.parse(fs.readFileSync(path.join(notesDir, work.id + '.json'), 'utf8'));
    const bodyHtml = payload.body.join('');

    ok(payload.body.length === payload.notes.paras.length, `${work.id} 段数 ≡ 注释段数（${payload.body.length}）`);
    const emptyTr = payload.notes.paras.map((p, i) => (p && p.tr && p.tr.trim() ? null : i + 1)).filter(Boolean);
    ok(emptyTr.length === 0, `${work.id} 每段都有译文`, emptyTr.length ? '缺第 ' + emptyTr.join('、') + ' 段' : '');

    ok(!/[《》]|｜|［＃/.test(stripTags(bodyHtml)), `${work.id} 正文无注記残留`);

    /* 注記转换的另一半：注音没被丢掉、也没被复制。
       有缓存时逐段数注記原子；没缓存就跳过（Tier 1 不该依赖缓存）。 */
    const cacheBody = path.join(scratch, 'aozora', work.id + '.txt');
    if (fs.existsSync(cacheBody)) {
      const full = paragraphsOf(fs.readFileSync(cacheBody, 'utf8'));
      const want = full
        .slice(payload.excerpt.from, payload.excerpt.to)
        .reduce((n, line) => n + parseInline(line).filter((a) => a.t === 'ruby').length, 0);
      const got = (bodyHtml.match(/<ruby>/g) || []).length;
      ok(got === want, `${work.id} ruby 数量 ≡ 原文注記数（${got} / ${want}）`);
    }

    /* 同一个生词在正文里可能出现多次：比的是**不同词**的集合，不是出现次数。 */
    const markedLemmas = [...new Set([...bodyHtml.matchAll(/class="w u"[^>]*data-l="([^"]+)"/g)].map((m) => m[1]))].sort();
    const wantOov = payload.oov.slice().sort();
    ok(
      markedLemmas.length === wantOov.length && markedLemmas.every((w, i) => w === wantOov[i]),
      `${work.id} 高亮词集合 ≡ 载荷 oov（${markedLemmas.length} / ${wantOov.length}）`,
      '只在页面：' + markedLemmas.filter((w) => !wantOov.includes(w)).join('、') +
      ' 只在载荷：' + wantOov.filter((w) => !markedLemmas.includes(w)).join('、')
    );

    ok(BANDS.has(payload.work.band), `${work.id} 档位合法（${payload.work.band}）`);
    ok(payload.excerpt.chars >= 1200 && payload.excerpt.chars <= 2500, `${work.id} 节选字数在 1200–2500（${payload.excerpt.chars}）`);

    ok(String(payload.work.kanaType) === '新字新仮名', `${work.id} 只收新字新仮名（${payload.work.kanaType}）`);
    ok(html.includes(payload.work.cardUrl), `${work.id} 页面载荷带図書カード URL`);

    // 活用形确实出现在正文里（「文中の形」这条路要有得测）
    const spans = [...bodyHtml.matchAll(/<span class="w[^"]*" data-l="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g)];
    const inflected = spans.filter(([, lemma, inner]) => stripTags(inner) !== lemma);
    ok(inflected.length > 0, `${work.id} 正文里存在活用形 token（${inflected.length} 个）`);

    sandboxes.push({ rel, work, payload, inflected });
  }

  /* ---- 4. 行为断言（沙箱里跑真的生成物） ---- */
  for (const { rel, work, payload, inflected } of sandboxes) {
    const sb = sandbox(rel);
    const main = sb.document.getElementById('jpRead');
    ok(!!main, `${work.id} 渲染出正文容器`);
    if (!main) continue;

    const allSpans = main.querySelectorAll('.w');
    ok(allSpans.length > 100, `${work.id} 正文切成 ${allSpans.length} 个词`);

    const rendered = main.textContent || '';
    const footerNeedles = [
      ['底本', '底本'], ['入力', '入力'], ['校正', '校正'],
      ['JMdict(CC BY-SA)', 'JMdict'], ['节选说明', '节选'], ['図書カード', '図書カード'],
    ];
    if (payload.work.parentBib) footerNeedles.push(['底本の親本', '底本の親本']);
    for (const [label, needle] of footerNeedles) {
      ok(rendered.includes(needle), `${work.id} 页脚有${label}`);
    }

    // 4a 高亮词：点开有读音与词性
    const oovSpan = allSpans.filter((s) => s.classList.contains('u'))[0];
    ok(!!oovSpan, `${work.id} 页面上有高亮词`);
    if (oovSpan) {
      oovSpan.click();
      const pop = sb.document.getElementById('jpPop');
      ok(!!pop && !pop.hidden, `${work.id} 点高亮词弹出释义词卡`);
      const text = pop ? pop.textContent : '';
      const lemma = oovSpan.getAttribute('data-l');
      ok(text.includes(lemma), `${work.id} 弹层标题是所点的词（${lemma}）`);
      ok(/未収録/.test(text), `${work.id} 未覆盖中文时明确提示未収録`);
    }
    sb.document.body.fire('click');

    // 4b 有中文释义的词：显示中文
    const zhWord = Object.keys(payload.terms).find((k) => payload.terms[k].zh);
    const zhSpan = allSpans.filter((s) => s.getAttribute('data-l') === zhWord)[0];
    ok(!!zhSpan, `${work.id} 正文里出现带中文释义的词（${zhWord}）`);
    if (zhSpan) {
      zhSpan.click();
      const pop = sb.document.getElementById('jpPop');
      ok(pop.textContent.includes(payload.terms[zhWord].zh), `${work.id} 点词显示中文释义`);
    }
    sb.document.body.fire('click');

    // 4c 活用形：弹层标出「文中の形」
    if (inflected.length) {
      const [, lemma, inner] = inflected[0];
      const surface = stripTags(inner);
      const span = allSpans.filter((s) => s.getAttribute('data-l') === lemma && stripTags(s.innerHTML) === surface)[0];
      ok(!!span, `${work.id} 找到活用形 span（${surface} → ${lemma}）`);
      if (span) {
        span.click();
        const pop = sb.document.getElementById('jpPop');
        ok(/文中の形/.test(pop.textContent), `${work.id} 活用形弹层标注文中の形`);
      }
    }

    // 4d 注释：点「注」展开该段译文
    const noteBtn = main.querySelectorAll('.jp-note-btn')[0];
    ok(!!noteBtn, `${work.id} 每段有「注」按钮`);
    if (noteBtn) {
      noteBtn.click();
      const body = sb.document.getElementById('jpNote0');
      ok(!!body && body.hidden === false, `${work.id} 点「注」展开本段注释`);
      ok(stripTags(body.innerHTML).includes(payload.notes.paras[0].tr.slice(0, 12)), `${work.id} 注释里有该段译文`);
    }

    // 4e 盖章：写进度、可取消
    const doneBtn = sb.document.getElementById('jpMarkDone');
    ok(!!doneBtn, `${work.id} 页脚有盖章按钮`);
    if (doneBtn) {
      doneBtn.click();
      const store = JSON.parse(sb.__store.get('jlpt-progress') || '{}').done || {};
      ok(Object.keys(store).length === 1, `${work.id} 盖章写入进度（${Object.keys(store)[0]}）`);
      doneBtn.click();
      const after = JSON.parse(sb.__store.get('jlpt-progress') || '{}').done || {};
      ok(Object.keys(after).length === 0, `${work.id} 再点一次取消盖章`);
    }
  }

  /* ---- 5. 生成器幂等 + 生成物与真源一致 ---- */
  const dictFile = path.join(scratch, 'jmdict-eng-common.json');
  if (!fs.existsSync(dictFile)) {
    log('· 跳过「生成器幂等」与「活用用例」：缺 JMdict 缓存（node tools/jp-reading.mjs fetch --insecure）');
  } else {
    /* dryRun：只算「会不会变」，绝不落盘 —— check 的承诺是只校验、不改文件。 */
    const r = generate({ root, works, only: null, log: () => {}, dryRun: true });
    ok(r.written.length === 0, '生成物 ≡ 真源（gen 重跑不会有任何改动）', '会改动 ' + r.written.join('、'));
  }

  /* ---- 6. 活用／分词固定用例 ---- */
  if (fs.existsSync(dictFile)) {
    const lex = buildLexicon(JSON.parse(fs.readFileSync(dictFile, 'utf8')).words);
    let bad = 0;
    for (const [input, want] of SEGMENT_CASES) {
      if (!resolveAll(input, lex).some(([, l]) => l === want)) bad++;
    }
    ok(SEGMENT_CASES.length >= 20, `活用语例条数 ≥ 20（${SEGMENT_CASES.length}）`);
    ok(bad === 0, `活用还原 ${SEGMENT_CASES.length} 条用例全过`, bad + ' 条未命中');
  }

  /* ---- 7. Tier 2：缓存依赖 ---- */
  const tier2On = tier2 || process.env.JP_READING_TIER2 === '1';
  if (tier2On) {
    if (!fs.existsSync(dictFile)) {
      ok(false, 'Tier 2 需要 .scratch/jp-reading/jmdict-eng-common.json');
    } else {
      const lex = buildLexicon(JSON.parse(fs.readFileSync(dictFile, 'utf8')).words);
      for (const work of works) {
        const bodyFile = path.join(scratch, 'aozora', work.id + '.txt');
        const metaFile = path.join(scratch, 'aozora', work.id + '.json');
        const page = pagePathOf(root, work);
        if (!fs.existsSync(bodyFile) || !fs.existsSync(page)) continue;
        const payload = readPayload(page);
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        const notes = JSON.parse(fs.readFileSync(path.join(notesDir, work.id + '.json'), 'utf8'));
        const full = paragraphsOf(fs.readFileSync(bodyFile, 'utf8'));
        const want = full.slice(payload.excerpt.from, payload.excerpt.to).map(plainOf);

        const got = payload.body.map(stripTags);
        const sameBody = got.length === want.length && got.every((g, i) => g === want[i]);
        if (!sameBody) {
          const at = got.findIndex((g, i) => g !== want[i]);
          ok(false, `${work.id} 正文 ≡ 缓存原文`, at < 0 ? '段数不同' : `第 ${at + 1} 段起不一致`);
        } else {
          ok(true, `${work.id} 正文 ≡ 缓存原文（${want.length} 段）`);
        }

        const fresh = buildPayload(work, meta, notes, lex, fs.readFileSync(bodyFile, 'utf8'));
        ok(
          JSON.stringify(fresh.terms) === JSON.stringify(payload.terms),
          `${work.id} 词表 ≡ 现场重算（词典更新请重跑 gen）`
        );
        ok(
          JSON.stringify(fresh.oov.slice().sort()) === JSON.stringify(payload.oov.slice().sort()),
          `${work.id} 非高频词集合 ≡ 现场重算`
        );
        ok(fresh.excerpt.chars === payload.excerpt.chars, `${work.id} 节选字数 ≡ 现场重算（${fresh.excerpt.chars}）`);
        ok(
          JSON.stringify(fresh.stats) === JSON.stringify(payload.stats),
          `${work.id} 词数/覆盖率 ≡ 现场重算（${fresh.stats.coverage}%）`
        );
      }
      const gradingFile = path.join(root, 'reading', 'data', 'grading.json');
      if (fs.existsSync(gradingFile)) {
        const grading = JSON.parse(fs.readFileSync(gradingFile, 'utf8'));
        const bad = grading.items.filter((g) => {
          const page = works.find((w) => w.id === g.id);
          if (!page) return true;
          const p = readPayload(pagePathOf(root, page));
          return p.excerpt.chars !== g.chars || p.stats.coverage !== g.coverage || p.stats.oovTypes !== g.oovTypes;
        });
        ok(!bad.length, '分档台账（reading/data/grading.json）≡ 各篇实测', bad.map((b) => b.id).join('、'));
      }
    }
  } else {
    log('· Tier 2 跳过（需要 .scratch/jp-reading/ 缓存；设 JP_READING_TIER2=1 或 --all 跑）');
  }

  return { pass, fails };
}

/** CLI 包装：打印逐条断言并返回退出码（放这里，避免 CLI 文件里拼模板字符串） */
export function runCheckCli({ root, works, log, tier2 }) {
  const on = tier2 || process.env.JP_READING_TIER2 === '1';
  log('■ check　日语阅读（Tier 1' + (on ? ' + Tier 2' : '') + '）');
  const r = check({ root, works, log, tier2: on });
  for (const name of r.pass) log('  ✓ ' + name);
  for (const name of r.fails) log('  ✗ ' + name);
  log('');
  if (r.fails.length) {
    log('✗ ' + r.fails.length + ' 项失败（通过 ' + r.pass.length + ' 项）');
    return 1;
  }
  log('✓ 全部通过（' + r.pass.length + ' 项断言）');
  return 0;
}
