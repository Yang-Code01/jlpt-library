/* ============================================================================
   青空文庫 文本处理（纯函数，无网络、无文件写）

   抽成独立 lib 的原因：`gen` 要剥正文、`check` 要拿固定样本断言「旧仮名会被拒」，
   两边必须用同一份实现 —— 判据只要分叉一次，就会出现「生成器认为合格、校验认为不合格」。
   ========================================================================== */

/** Shift_JIS → 字符串（Node 自带 full-icu，TextDecoder 支持 shift_jis） */
export function decodeSjis(buf) {
  try {
    return new TextDecoder('shift_jis', { fatal: false }).decode(buf);
  } catch (e) {
    throw new Error('这个 node 没带 shift_jis 解码器（需要 full-icu 构建）');
  }
}

/* 旧仮名遣い的粗筛标记：命中即拒收（宁可漏收，不收读不动的）。
   只收「不可能在现行仮名遣里撞到」的标记：ゐゑ 类字符 + 「漢字+ふ」型。
   「さう／やう／だう」这类子串检索会误伤（实测「こないだ・うなぎ」就被当成 だう），一律不要。 */
export const OLD_KANA = ['ゐ', 'ゑ', 'ゝ', 'ゞ', 'ヰ', 'ヱ', 'ヽ', 'ヾ'];
export const OLD_KANA_WORDS = ['けふ', 'せう', 'でせう', 'ませう', '思ふ', '云ふ', '言ふ', '給ふ', '食ふ'];

/** 返回命中的旧仮名标记（空数组＝通过闸门） */
export function oldKanaHits(body) {
  const hits = [];
  for (const ch of OLD_KANA) {
    const n = body.split(ch).length - 1;
    if (n) hits.push(ch + '×' + n);
  }
  for (const w of OLD_KANA_WORDS) {
    const n = body.split(w).length - 1;
    if (n) hits.push(w + '×' + n);
  }
  return hits;
}

const SEP = /^-{10,}$/gm;

/** 剥抬头／尾注，切出正文；底本三件单独抽 */
export function parseAozora(raw) {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const tailAt = text.lastIndexOf('\n底本：');
  const head = tailAt >= 0 ? text.slice(0, tailAt) : text;
  const tail = tailAt >= 0 ? text.slice(tailAt + 1) : '';

  const seps = [...head.matchAll(SEP)].map((m) => m[0].length + m.index);
  let bodyStart = 0;
  if (seps.length) {
    const at = seps[seps.length - 1];
    bodyStart = at + (head[at] === '\n' ? 1 : 0);
  }
  const body = head.slice(bodyStart).replace(/^[\s　]+/, '').replace(/\s+$/, '') + '\n';

  const grab = (key) => {
    const re = new RegExp('^' + key + '：(.+(?:\\n　{2,}.+)*)', 'm');
    const m = tail.match(re);
    return m ? m[1].split('\n').map((s) => s.trim()).join(' ') : '';
  };

  return {
    body,
    head: head.slice(0, bodyStart).replace(/\s+$/, ''),
    bib: grab('底本'),
    parentBib: grab('底本の親本'),
    input: grab('入力'),
    proof: grab('校正'),
    released: (tail.match(/^(\d{4}年\d{1,2}月\d{1,2}日)公開$/m) || [])[1] || '',
    revised: (tail.match(/^(\d{4}年\d{1,2}月\d{1,2}日)修正$/m) || [])[1] || '',
    tail,
  };
}

export function rubyCount(s) {
  return (s.match(/《/g) || []).length;
}

export function kanjiRate(s) {
  const chars = [...s].filter((c) => !/\s/.test(c));
  const kanji = chars.filter((c) => /[\u4e00-\u9fff]/.test(c)).length;
  return chars.length ? +((kanji / chars.length) * 100).toFixed(1) : 0;
}
