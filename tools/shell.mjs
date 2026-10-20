/* ============================================================================
   壳的唯一真源（ADR-0010）
   ----------------------------------------------------------------------------
   这里只放「所有页面长得一样」的东西：左栏 markup、面包屑、favicon。
   样式不在这里 —— 左栏/顶栏的 CSS 在 assets/style.css 的「工作台左栏」标记区，
   页面通过既有的 <link rel="stylesheet"> 自动拿到，不用每页内联。

   谁在用：
     - tools/rail.mjs     把 railHtml() 写进手写页（168 个单元页 + 各入口页）
     - tools/research.mjs 报告外壳（顶条 + 返回链接）
     - 未来的 tools/portal.mjs 与门户新壳
   ========================================================================== */

/* 品牌标记的 favicon（与 index.html head、assets/style.css 的 .brand 同源） */
export const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23176b75'/%3E%3Ctext x='16' y='20.5' font-size='14' letter-spacing='-0.3' font-family='Georgia,serif' fill='%23ffffff' text-anchor='middle'%3EQY%3C/text%3E%3C/svg%3E";

/* 左栏条目：id 用于高亮，icon 走 assets/style.css 的 .im-* 线描图标集 */
export const ITEMS = [
  { id: 'material', icon: 'card', label: '学习资料', href: 'material/index.html', group: 'ja' },
  { id: 'exam', icon: 'sheet', label: '真题练习', href: 'exam/index.html', group: 'ja' },
  { id: 'listening', icon: 'ear', label: '听力专项', href: 'listening/index.html', group: 'ja' },
  { id: 'dictation', icon: 'mic', label: '听写练习', href: 'dictation/index.html', group: 'ja' },
  { id: 'jp-vocab', icon: 'cards', label: '课堂单词', href: 'jp-vocab/index.html', group: 'ja' },
  { id: 'verb', icon: 'swap', label: '动词专练', href: 'verb/index.html', group: 'ja' },
  { id: 'typing', icon: 'keys', label: '打字练习', href: 'typing/index.html', group: 'ja' },
  { id: 'en-vocab', icon: 'book', label: '词表资料', href: 'en/1k/01.html', group: 'en' },
  { id: 'en-dictation', icon: 'mic', label: '英语听写', href: 'en/dictation/index.html', group: 'en' },
  { id: 'en-reading', icon: 'doc', label: '阅读精读', href: 'en/reading/index.html', group: 'en' },
  { id: 'en-typing', icon: 'keys', label: '英语打字', href: 'en/typing/index.html', group: 'en' },
  { id: 'survey', icon: 'doc', label: '调查报告', href: 'index.html#survey', group: 'area', sep: true },
  { id: 'tools', icon: 'sliders', label: '工具开发', href: 'index.html#tools', group: 'area' },
  { id: 'snooker', icon: 'target', label: '斯诺克信息', href: 'index.html#snooker', group: 'area' },
];

/** 路径 → 左栏相对前缀：`n3/vocab/x.html` → `../../` */
export function prefixOf(file) {
  const depth = file.split('/').length - 1;
  return '../'.repeat(depth);
}

/** 路径 → 当前模块 id（用于 is-on 高亮） */
export function activeOf(file) {
  const f = file.replace(/\\/g, '/');
  if (/^material\/|^n[1-5]\//.test(f)) return 'material';
  const head = f.split('/')[0];
  if (head === 'en') {
    if (/^en\/reading\//.test(f)) return 'en-reading';
    if (/^en\/dictation\//.test(f)) return 'en-dictation';
    if (/^en\/typing\//.test(f)) return 'en-typing';
    return 'en-vocab';
  }
  return head;
}

export const RAIL_START = '<!-- wb:rail:start -->';
export const RAIL_END = '<!-- wb:rail:end -->';

/** 左栏 markup。prefix 由 prefixOf() 给出，active 由 activeOf() 给出。 */
export function railHtml({ prefix = '', active = '' } = {}) {
  const item = (it) => {
    const cls = 'wb-rail-item' + (it.id === active ? ' is-on' : '');
    const sep = it.sep ? '\n      <span class="wb-rail-sep" aria-hidden="true"></span>' : '';
    return `${sep}
      <a class="${cls}" href="${prefix}${it.href}" title="${it.label}"><span class="im im-${it.icon}" aria-hidden="true"></span><span class="wb-rail-t">${it.label}</span></a>`;
  };
  const ja = ITEMS.filter((i) => i.group === 'ja').map(item).join('');
  const en = ITEMS.filter((i) => i.group === 'en').map(item).join('');
  const area = ITEMS.filter((i) => i.group === 'area').map(item).join('');

  return `${RAIL_START}
    <nav class="wb-rail" aria-label="全站导航">
      <a class="wb-rail-brand" href="${prefix}index.html" title="回工作台" aria-label="回工作台"><span aria-hidden="true">QY</span></a>
      <div class="wb-rail-scroll">
        <div class="wb-rail-group">${ja}
        </div>
        <span class="wb-rail-sep" aria-hidden="true"></span>
        <div class="wb-rail-group">${en}
        </div>${area}
      </div>
      <div class="theme-slot" data-theme-slot></div>
    </nav>
    ${RAIL_END}`;
}

/** 面包屑：items = [{label, href?}]，最后一项是当前页（不带链接） */
export function breadcrumb(items, prefix = '') {
  const parts = items.map((it, i) => {
    const last = i === items.length - 1;
    const inner = it.href && !last ? `<a href="${prefix}${it.href}">${it.label}</a>` : `<span>${it.label}</span>`;
    return last ? inner : `${inner}<span class="wb-crumb-sep" aria-hidden="true">/</span>`;
  });
  return `<nav class="wb-crumb" aria-label="面包屑">${parts.join('')}</nav>`;
}
