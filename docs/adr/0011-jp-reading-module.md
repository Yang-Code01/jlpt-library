# 日语阅读成为第八个日语模块（语言学习 11 → 12），并扩张进度判定的档位表

Status: accepted

`reading/` 是语言学习区的第 12 个模块（日语侧第 8 个）。本 ADR 只记录**这次扩张**动到的两处既有约定，模块内部设计见 `reading/README.md`。

## Context

- `ADR-0010` 第 1 条写死「语言学习区内 11 个模块（日 7 / 英 4）」。新增日语阅读后这个数字不再成立。
- `ADR-0010` 让英语阅读搬到 `en/reading/`，但 `assets/progress.js` 的 `RE_UNIT` 里仍留着一支
  `reading/(1k|2k|3k|4k)`。实现日语阅读时我一度把它当成「搬家遗留、可以直接替换成 `n3|n2|n1`」，
  结果 `tools/tests/test_progress.js`、`test_reading.js`、`test_integration_en.js` 立刻红了。
  **原因是我判断错了**：`keyOf` 取路径末三段，`en/reading/1k/01.html` 的 key 正是
  `reading/1k/01.html` —— 那一支不是遗留，而是英语阅读页**现在**赖以被认成「单元页」的那一支。
- 日语阅读的页面在 `reading/n3/01.html`，末三段就是它自己，需要另一支档位表。

## Decision

1. **模块数 11 → 12**：`ADR-0010` 第 1 条的数字由本 ADR 更新（该 ADR 其余条款继续有效，不改写原文）。
2. **`RE_UNIT` 取「扩张」而不是「替换」**：
   `reading\/(?:1k|2k|3k|4k|n3|n2|n1)`。
   两个语言的阅读页共用 `reading/` 这一层前缀，靠档位名区分，互不覆盖。
3. **左栏与门户同批更新**：`tools/shell.mjs` 的 `ITEMS` 加 `reading`（日语组，`doc` 图标），
   `tools/portal.mjs` 加分桶 `jp-reading`（扫 `reading/<n3|n2|n1>/*.html`），
   门户日语分组加一张卡（`data-units="jp-reading"`）。
4. **门户卡片数量不变量 11 → 12、`data-units` 卡片 3 → 4、进度胶囊 3 → 4**：
   `tools/tests/test_area.js`、`test_reading.js`、`test_typing_en.js` 里写死的这三个数字同步更新。
   `data-en-key` 恰 107 项的不变量**不动**（新卡片不使用该属性）。

## Considered Options

- **把日语阅读的目录叫 `jp-reading/`，避开 `reading/` 前缀**：能省掉一次档位表扩张，但与 `en/reading/` 失去对称，
  且 `reading/` 这一层本来就是「阅读页」的语义。否决。
- **在 `reading/` 下改用统一档位名（如 `r1/r2/r3`）并同时迁移英语侧**：一次改 30 个英语页面的 key，
  等于清空用户的英语阅读进度。否决。
- **不动 `RE_UNIT`，让日语阅读页靠 `data-units` 自报**：`LibProgress.isDone/markDone` 仍会因 `RE_UNIT` 不认而失效
  （导入导出时被当成「无法识别」丢掉，`test_progress.js` 里已有这条断言）。否决。

## Consequences

- 新增模块后**必须**同时改：`ITEMS`、`portal.mjs` 桶、门户卡片、以及三个测试里写死的卡片/胶囊数量 —— 少一处就有测试红。
- `reading/1k/01.html`（英语）与 `reading/n3/01.html`（日语）在进度里是两个不同的 key，互不冲突；
  但**同一档位名不能再给两个语言用**，以后加别的语言阅读时必须换档位名。
- 导入旧进度备份时，`reading/n3/*` 这类 key 现在会被认成单元页（此前会被忽略并计入「忽略条数」）。
- 本次扩张没有改 `data-en-key` 与 `en-accept.mjs` 的门禁。
