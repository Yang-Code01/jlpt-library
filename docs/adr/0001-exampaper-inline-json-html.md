# 真题库试卷数据内联于单页 HTML（Option 1），而非独立 .js 数据模块

Status: accepted

真题库每套试卷落地为一个 `.html` 文件，题目数据内联为 `<script type="application/json" id="paper-data">`、由共享 `assets/exam.js` 消费；不采用「每卷一个 `.js` 数据模块（`window.PAPER_…={…}`）」的 Option 3。选 Option 1 是因为静态站 `file://` 直开（无构建、浏览器拦 `fetch()`），内联 JSON 让每卷自足、与资料库全站「一单元一 .html」一致，降低心智与维护成本。

## Considered Options

- **Option 1（采纳）**：每卷一个 `.html` + 内联 JSON + 共享 `exam.js`。file://-safe，镜像资料库一致性。
- **Option 3（否决，备未来迁移）**：每卷一个 `.js` 数据模块，专项页可多 `<script src>` 加载多卷 globals 做**真·跨卷 pooled quiz**。代价：放弃「一单元一 .html」一致性，所有卷 .js 化、browse/exam 页需从 .js 取数渲染。

## Consequences

- **专项练习首版不做「多卷题目 pool 成一套题」**：Option 1 下跨卷内联 JSON 取不到、`file://` 拦 fetch，专项 = 「按题型跨卷索引 → 跳进单卷 `?mode=browse&type=<itemType>` 过滤 browse」，非内存级 flatten。真·pooled quiz 若日后要，需整体迁 Option 3（全卷 .js 化），届时本 ADR superseded。
- 试卷数据格式与资料库页同构，维护路径单一。
