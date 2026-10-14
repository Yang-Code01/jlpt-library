# 调查报告清单走 `research/data.json` + `tools/research.mjs` 管线，报告页外壳由 add-shell 注入

Status: accepted

调查报告区的内容真源是 `research/data.json`（篇目元数据 + 受控标签词表）：`node tools/research.mjs gen` 生成 `index.html` 里 `<!-- wb:report-list:start/end -->` 标记区，`check` 双向校验（元数据 ↔ 目录里的报告文件、标签是否登记在词表内、自包含性、日期格式与倒序、外壳标记成对且唯一）。报告的站点级外壳（返回清单的入口）由 `add-shell` 注入标记区并写进报告 HTML，报告本体仍可单独阅读。选这套而不是手写清单 HTML，是因为新增一篇报告只需「放文件 + 加一条 + gen」，且 `check` 能挡住漏登记、标签漂移、误引外链、外壳写坏。

## Considered Options

- **手写清单 HTML**：否决——改标题要手改门户，且没有任何校验。
- **运行时 `fetch('research/data.json')`**：否决——`file://` 下浏览器拦 `fetch()`（全站硬约束），故走构建期内联。
- **报告统一套站点模板**（模板 + 内容文件）：否决——用户明确要求「不提供模板，每篇报告自带样式，只要求自包含」。
- **外壳三选一**（只顶部条 / 只浮动胶囊 / 只页脚）：否决——用户选定 F5 组合：细条 + 浮动胶囊 + 页脚返回三处并存，对浅色与深色报告都稳妥。
- **清单展示已读 / 新状态**：否决——用户明确不要。

## Consequences

- `research/` 随 git 发布；`data.json` 是唯一真源，`index.html` 的清单区是生成物，不许手改。
- 报告文件名不带日期（日期只在 `data.json` 里，`YYYY-MM-DD`）；报告文件必须是 kebab-case、放在 `research/` 下；新报告不得引外部 css/js。
- `add-shell` 必须保持幂等：先 strip 掉三个外壳标记区（含 CSS 块）再重新注入；已用「连续运行三次 sha1 不变 + 与未加壳原文逐行 diff 无删除」验证。
- 受控标签初始六项（技能生态 / 工具横评 / 工程实践 / 模型 / 环境配置 / 学习资料）；扩词表 = 改 `data.json` 的 `tags` 后再 `gen` + `check`。
- 深色模式由报告文件自己用 `prefers-color-scheme` 处理，不依赖站点 `theme.js`；外壳样式用中性色 + `rgba(127,127,127,…)` 描边以兼容两种底色。
