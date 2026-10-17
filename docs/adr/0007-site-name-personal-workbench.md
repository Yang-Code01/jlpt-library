# 全站改名「个人工作站 · Personal Workbench」（标签页标题不再叫日语学习资料库）

Status: accepted

浏览器标签页还写着「日语学习资料库 · Language Library」，门户里却已经装了三个区（语言学习 / 调查报告 / 工具开发），报告页外壳与页头品牌行（QY / Qingmin Yang）也早就是另一套说法。名称与实际内容脱节，且旧名有三个变体在同时流通：`日语学习资料库`、`Language Library`、`JLPT 系统学习资料库`。定案：**站名统一为「个人工作站 · Personal Workbench」**。

四条决定：

1. **中文在前、英文在后**，分隔符固定 ` · `。用户原话：「现在应该改为个人工作站。或者推荐一个高大上的名字」——最终选定朴素直白的「个人工作站」，英文沿用现成的 `Personal Workbench`（门户导航右上角的 tag 一直是它）。
2. **标签页标题按「落点」而不是按「站名全名」写**：默认落点（语言学习区・日本語）用站名全名，其余页面用 `页面名 · 个人工作站`。理由：标签页约 20 个字后就开始淡出，原先把「内容名 · 英文站名」两段都塞进去，截图里 `Language Library` 已经在淡出；分区再套全名会更快撞上限。
3. **「工作台」作为内部术语保留**：`CONTEXT.md` 的「工作台结构」「工作台首页」指站点定位，不是品牌签名；面包屑里的位置词也不再改回旧名。品牌签名只由 QY 标记 + 站名承担（与 ADR-0005 的分工一致）。
4. **生成器是唯一真源，不许只改生成物**：`tools/en-vocab.mjs`、`tools/en-reading.mjs` 的标题模板、`tools/research.mjs` 的报告外壳常量和 `index.html` 的 `PORTAL_*_META` 都一起改，再由 `gen` / `add-shell` 重新落盘。`tools/tests/test_area.js` 与 `tools/tests/test_typing_en.js` 钉住四个标签页标题，改错名即红。

## Considered Options

- **保留旧名、只加副标题**：否决 —— 旧名描述的是三个区里的一个（日语学习），加了副标题还是在说「这是个日语资料库」。
- **`書斎 · The Study`（日式书房）**：否决 —— 意境好但外人一眼看不懂是什么站，且与 QY 拉丁标记的调性不连贯。
- **`Qingmin Yang · 个人工作站`（人名打头）**：否决 —— 前缀太长，标签页里中文部分会被挤掉；人名已经在页头品牌行与三个页脚里出现，不需要每处都重复。
- **只改 `index.html` 的 `<head><title>`**：否决 —— 页面标题由 `document.title =` 按「区 × 语言」重算，改 `<head>` 等于白改；且会与模块页、报告外壳继续新旧并存。

## Consequences

- 站名的可改点在：`index.html` 的 `<head><title>` + `PORTAL_LANG/SURVEY_META/TOOLS_META`、各模块页 `<title>`、`tools/en-vocab.mjs` 与 `tools/en-reading.mjs` 的标题模板、`tools/research.mjs` 的 `SHELL_BAR` / `SHELL_FOOT`、`README.md`、`CONTEXT.md`。
- 英语侧子页标题同样用中文站名（`英语词表 · 个人工作站`）：站名是品牌，不随页面语言翻译；页内语言开关只管内容语言。
- 报告页外壳面包屑从 `工作台 › 调查报告` 变为 `个人工作站 › 调查报告`，改完必须重跑 `add-shell`（否则 `node tools/research.mjs check` 报外壳不一致）；`research/pi-changelog.html` 由 `tools/pi-changelog-gen.mjs` 重新生成（它会自己补壳）。
- 旧的三个名字（`日语学习资料库` / `Language Library` / `JLPT 系统学习资料库`）一律视为废弃写法，再出现就是 bug —— 已记进 `CONTEXT.md` 该词条的 `_Avoid_` 行。
