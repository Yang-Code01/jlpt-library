# 假名翻牌成为第九个日语模块（语言学习 12 → 13），走 `typing/` 的「不引共享资源」路线

Status: accepted

`kana-memory/` 是语言学习区的第 13 个模块（日语侧第 9 个）。本 ADR 只记录这次扩张定下的四条决策与「新模块要同批改的地方」，模块内部设计见 `docs/portal-map.md` 的模块表与 `.scratch/kana-memory/SPEC.md`。

## Context

- 站里现有的练习都是单向的：`typing/` 从假名敲罗马字（只练输出）、`quiz.js` 只在单元页里做选择题、`jp-vocab/` 是单卡翻转（没有对局与成败）。缺一个「几分钟一局、能停下来接着玩」的回忆型练习。
- 这个模块的视觉是纸感卡片墙（纸底细线 + 墨色正文 + 朱色强调），与站内无衬线令牌体系是两套语言；数据则处处可从 `typing/` 复用（罗马字判定口径、N5/N4 词表）。
- 它既不属于「配对牌局」（`typing/` 的职责），也不属于「词卡」（`jp-vocab/` 的职责），挂进任何一个子目录都会让那个模块的入口页背上第二种玩法。

## Decision

1. **再开一个顶级模块**：新目录 `kana-memory/`，与 `typing/` 同级，手写返回门户的面包屑（`../index.html`）。`ADR-0011` 第 1 条写死的「11 → 12」由本 ADR 再推到 13（该 ADR 其余条款继续有效，不改写原文）。门户 `index.html` 的「N 个模块」文案与卡片数（`<article class="card">`）同批改 12 → 13。
2. **不接 `progress.js`、不动 `RE_UNIT`**：本模块不是「单元页」，没有「已看 / 未看」的概念，进度语义是「按档位记最高分」。成绩与偏好各用独立键：
   - `jlpt-kana-tier`：上次选的档位（体验记忆，不算成绩）
   - `jlpt-kana-sound`：音效开关（`on` / `off`，没存过按「开」算）
   - `jlpt-kana-best:<tier>`：每档一条最高分（`{moves, ms}`，步数少者胜、同步数比用时），三档各一个键
   扩 `assets/progress.js` 的 `RE_UNIT` 白名单会让 `test_progress.js`、`test_reading.js`、`test_integration_en.js` 一起变红（`ADR-0011` 已踩过这条），且会把「牌局成绩」混进导入导出的单元进度里。
3. **不引 `assets/style.css` 与 `assets/theme.js`**，走 `typing/` 的同一路：自带 `kana.css`、不接主题切换、不接左栏注入。理由：纸感视觉硬套共享令牌会把 `assets/style.css` 拖成第二套调色板；`typing/` 已有「自包含模块页」的先例，`tools/rail.mjs` 也按「有没有引共享样式」决定要不要注左栏 —— 不引，就自动不被注入。
4. **测试接缝放在 DOM 层，门户数量断言同批改**：新套件不测纯函数，而是用 `tools/tests/dom.js` 的沙箱（真 `classList` + 可手动推进的假定时器）驱动真页面接线；风险不在洗牌（十行代码），而在同 key 判定、`data-state` 互斥、配错后定时回翻、计步时机、换档重建牌墙。四个套件 `test_memory.js` / `test_memory_tiers.js` / `test_memory_score.js` / `test_memory_feel.js` 都登记进 `tools/test.mjs` 的 `SUITES`。新增门户卡片后，三处写死卡片数 12 的断言（`tools/tests/test_area.js`、`test_reading.js`、`test_typing_en.js`）必须同批改成 13，否则 `node tools/test.mjs` 立刻红。

## Considered Options

- **挂在 `typing/` 下（`typing/kana.html`）**：能白拿罗马字表，但会把「打字」模块的入口页变成两种玩法的混合体，且 `typing/index.html` 的档位/模式配置语义对牌局完全不适用。否决。
- **复用 `jp-vocab/` 的翻转卡**：那是单卡记忆（翻一张看答案），没有对局、没有步数与成败，做不成「一局」与「最高分」。否决。
- **接 `progress.js` 记最高分**：需要在 `RE_UNIT` 里给 `kana-memory/index.html` 加一支「单元」，等于把一整个模块伪装成一个单元页，导入导出会把成绩当单元进度算进「已看 N/168」。否决。
- **引 `assets/style.css` 只借设计令牌**：令牌是给无衬线浅色界面调的，纸感卡片墙要的是衬线 + 细线网格 + 独立纸底，借完还是要覆盖大半，等于两套样式叠在一页。否决。

## Consequences

新模块上线**必须同批改的地方**（少一处就有测试红或文档失真）：

| 位置 | 改什么 |
|---|---|
| `index.html`（门户卡片区，日语组） | 加一张 `<article class="card">`；`pane-head` 的「N 个模块」文案 12 → 13 |
| `tools/tests/test_area.js` | 卡片数 12 → 13（同文件 `rail-item` 11、`data-units` 4、`prog-pill` 4 **不动**） |
| `tools/tests/test_reading.js` | 卡片数 12 → 13 |
| `tools/tests/test_typing_en.js` | 卡片数 12 → 13 |
| `docs/portal-map.md` | 模块表加一行（目录 / 入口 / 数据真源 / 生成器 / 校验） |
| `README.md` | 模块表加一行；「语言学习区模块数」同步 |
| `docs/adr/` | 本 ADR |

**刻意不动的地方**（动了就是扩范围）：

- `tools/shell.mjs` 的 `ITEMS` 与门户手写左栏 `.rail-item`：本模块不进左栏（门户手写左栏本来就只有 11 项，与 `shell.mjs` 的 12 个模块项不一致是历史现状，本次不去拉平）。
- `tools/portal.mjs` 与 `assets/units.js`：那个工具只收「单元页」（`n1/`–`n5/` 与各阅读/词表目录），`kana-memory/index.html` 不是单元页，既不进分桶也不需要 `gen`。
- `assets/progress.js` 的 `RE_UNIT`、`data-en-key`（仍恰 107 项）、`tools/rail.mjs`（本页不引共享样式，`check` 自动跳过）。
- `typing/` 的任何文件：本模块只读 `typing/romaji.js` 与 `typing/data/{n5,n4}.js`；将来 `typing/` 改数据结构，本模块跟着改。

新增卡片**不使用** `data-en-key`（会破 107 不变量）与 `data-units`（会破 4 张进度卡的断言），`data-tags` 只能取门户词表里的值（`资料` / `词汇` / `听力` / `真题` / `练习` / `工具`）。
