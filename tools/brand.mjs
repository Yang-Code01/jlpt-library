/* ============================================================================
   品牌标记：生成器侧的唯一定义处
   ----------------------------------------------------------------------------
   标记是「QY」（Qingmin Yang 的首字母），全站只此一种。它落在四处：

     1. 门户头部 + 报告外壳的方块与字标
        —— CSS 值（`.portal-brand-mark` 在 assets/style.css、
        `.wb-shell-mark` 在 tools/research.mjs 的 SHELL_CSS 里）
     2. 门户本身的 favicon（index.html 里手写的 data URI，无法 import）
     3. 英语侧生成页的 favicon（110 个页面）—— 本文件供 en-vocab / en-reading 用
     4. 报告外壳顶条文字（tools/research.mjs 的 SHELL_BAR / SHELL_FLOAT）

   本文件只收拢「生成器能 import 的那一处」。改标记时：换这里的 MARK / FAVICON，
   重跑两个英语侧生成器（`node tools/en-vocab.mjs gen` 与
   `node tools/en-reading.mjs gen`），再改 research.mjs 的 SHELL_* 与
   index.html 里手写的那两处。`tools/tests/icon-set.js` 会核对以上四处是否一致
   —— 历史上 110 个英语侧页面就因为常量抄了两份而集体停在旧字标上。
   ========================================================================== */

/* 标记文字。尺寸、字距、字体在 CSS 侧（见上面第 1 条），这里只管字。 */
export const MARK = 'QY';

/* favicon 的 data URI。参数与 index.html 里手写的那一份逐字节相同：
   32×32 视框 / rx9 / 主色底（浅色 #b93e28）/ 白字 / Georgia / 字号 14 /
   字距 −0.3 / y=20.5（视线居中）。
   深色模式不做第二份 —— 16px 下这点色差看不出来，而多一份就多一处要同步。 */
export const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23b93e28'/%3E%3Ctext x='16' y='20.5' font-size='14' letter-spacing='-0.3' font-family='Georgia,serif' fill='%23ffffff' text-anchor='middle'%3EQY%3C/text%3E%3C/svg%3E";
