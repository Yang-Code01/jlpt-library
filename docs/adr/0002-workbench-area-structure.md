# 门户首页就地改造为「区」结构（新增 data-area 区开关），不新建工作台页面

Status: accepted

门户首页仍是同一个 `index.html`：在既有的 `data-lang`（日语 / 英语语言开关）之上加一层 `data-area`（区开关），语言开关降级为「语言学习区」区内的二级筛选；「调查报告区」接在同一页页尾。选就地改造而非新建首页 / 多页分区，是因为：用户原话是「重新修改 index 页面」；全站零构建、`file://` 优先，多页会引入共享导航与跨页状态同步；且现有不变量（生成器的两个标记区、`en-accept` 的 107 项 `data-en-key`、`progress.js` 的路径末三段 key）在单页里零冲击。

## Considered Options

- **A 就地改造（采纳）**：`index.html` 变工作台首页；`.wb-tabs` 切 `html[data-area]`，两个 `.wb-pane[data-area-pane=study|survey]`，报告区在页尾，语言开关移入语言学习区右上角。
- **B 新建 `workbench.html` 作新首页、原页改名**：否决——线上 GitHub Pages 链接与全部相对路径都要改，且新旧两份页面各自维护导航。
- **C 各区独立页面**（如 `areas/*.html`）：否决——需要抽出共享导航组件并同步状态，静态无构建下代价最高。
- **样张 D 侧栏工作台 / 样张 E 仪表盘**：否决——会把七个模块降成二级入口，与「语言学习仍是主场」不符。

## Consequences

- 新增 `localStorage` 键 `jlpt-area`；`#survey` 深链是「报告页 → 报告清单」的合同，`tools/research.mjs` 的返回链接固定指向 `../index.html#survey`。
- 生成器标记区（`en:unit-lists`、`en:reading-lists`）与新增标记区（`wb:report-list`）互不重叠；标记区内容一律不许手改。
- 门户 CSS 仍内联在 `index.html`，`.wb-*` / `.zone-*` / `.survey-*` / `.filter-*` 追加在 `</style>` 之前；新增卡片不得使用 `data-en-key`（`en-accept` 要求全页恰 107 项）。
- 页面维持 CRLF 行尾（与改造前一致）；生成器写入标记区时必须沿用文件自身行尾，否则工作区会变成混合行尾。
- 英语侧票 10 的 CRLF 行尾缺陷与本 ADR 无关，单独立项，不在本次改动范围内。
