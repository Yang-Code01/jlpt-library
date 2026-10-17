# 仓库地图（导航指针）

> 目的：新会话不必逐目录勘察。**改门户、找数据真源、找生成器、跑检查**都从这里定位。
> 术语以 `CONTEXT.md` 为准，架构取舍以 `docs/adr/` 为准；本文件只讲「东西在哪、谁写它、怎么验」。

## 一、门户 `index.html`（唯一首页，零构建、`file://` 直开）

一层 `data-lang`（日语 / 英语）+ 一层 `data-area`（区：`study` / `survey` / `tools`）驱动显隐，状态分别记在
`localStorage` 的 `jlpt-lang` / `jlpt-area`（`#survey` / `#tools` 可深链直达对应区）。
三区共用一条 `:not()` 显隐规则（加第四区只改这一条）。四处内容由生成器写入，**位置之外的 markup 手写安全**：

| 标记区（`index.html`） | 内容 | 归属工具 | 手改后果 |
|---|---|---|---|
| `<!-- en:unit-lists:start/end -->` | 英语词表单元清单（77 个单元） | `tools/en-vocab.mjs` | 被覆盖；`check` 报「内容不一致」 |
| `<!-- en:reading-lists:start/end -->` | 英语阅读清单（30 篇） | `tools/en-reading.mjs` | 同上 |
| `<!-- wb:report-list:start/end -->` | 调查报告清单（标签筛选条 + 行） | `tools/research.mjs` | 同上 |
| `<!-- wb:tool-list:start/end -->` | 工具开发清单（标签筛选条 + 行 + 下载链接） | `tools/tools.mjs gen` | 同上 |

门户其余部分：inline `<style>`（设计令牌在 `assets/style.css`）、数据开关状态机（head 内联脚本）、
区切换与标签筛选（页尾内联脚本）。报告条目行是 `div.survey-item` + `.survey-title a::after` 覆盖层
（**不能嵌套 `<a>`**，浏览器会拆行）；工具条目复用同一套 `.survey-item` 骨架，右栏换成 `.tool-dl` 下载链接。
标签筛选是 `wireTagFilter(scope, empty)`，**按容器**取 chip / item —— 门户里有两处清单，全局选择器会串台。

**门户三条不变量（改它必看）**
1. `data-en-key` 必须恰好 107 项（`tools/en-accept.mjs` 里的 `TOTAL`）—— 新元素**不要**用这个属性。
2. 学习进度 key = 路径末三段（`assets/progress.js` 的 `keyOf`）；改目录结构要让「索引 href 集合 ≡ 单元页路径集合」，否则进度静默失效。
3. 行尾一律 LF（见 `docs/adr/0004`）；生成器写入时按目标文件现有 EOL 保持。
4. 工具下载包由 `pack` 生成并自动 `gen`（包体积写在清单里）；`downloads/manifest.json` 记逐文件 sha256，改了工具源码不重打包会被 `check` 抓到（见 `docs/adr/0006`）。

## 二、模块表（数据真源 → 生成物 → 校验）

| 目录 | 入口 | 数据真源 | 生成器 | 校验 |
|---|---|---|---|---|
| `material/`、`n1/`–`n5/` | 资料库（词表 / 语法 / 基础） | 手写 HTML | 无 | 无（静态） |
| `exam/` | 真题库 | 明文 `exam/data/N2/*.js`（**不入库**） | `tools/encrypt-exam.mjs` | `tools/check-exam-data.js` |
| `jp-vocab/` | 课堂单词 | `<unit>/data.json` | `jp-vocab/gen.js`（音频 `gen-audio.ps1`） | `node jp-vocab/gen.js check` |
| `verb/` | 动词专练 | `verb/units/<unit>/data.json`、`verb/conjugation/data.json` | `verb/gen.js` | `node verb/gen.js check` |
| `dictation/` | 听写练习 | `words-data.js` + 每单元 `*.js` | 无 | 无 |
| `typing/` | 打字练习 | 取自 `n1/`–`n5/vocab/*.html` | `node typing/gen-words.js` → `typing/data/{n5..n1}.js` | 无 |
| `listening/` | 听力专项 | `listening/data/<level>/<卷>.js` + `audio/` | 无（手写 index） | 无 |
| `en/` | 英语侧（词表单元 / 阅读 / 搭配） | `.scratch` 里的 ECDICT / Gutenberg 缓存（**不入库**） | `tools/en-vocab.mjs`、`en-reading.mjs`、`en-typing.mjs` | `node tools/en-accept.mjs` |
| `research/` | 调查报告 | `research/data.json` | `node tools/research.mjs gen` | `node tools/research.mjs check` |
| `pi-tui/` | pi 的 TUI 增强包 `pi-tui-plus`（pi-open-tui 自有分支：footer + 模型选择器 + 网关状态） | 自身源码（15+3 个 ts，无依赖） | 无（pi 直接加载目录） | `node tools/tools.mjs check`（版本 / 包 / 清单一致） |
| `tools-dev/` + `tools/tools.mjs` | 工具开发区的清单与下载 | `tools-dev/data.json` + `tools-dev/<page>.html` | `node tools/tools.mjs gen`、`pack <id>` | `node tools/tools.mjs check` |
| `research/pi-changelog.html` | pi 更新履历报告（报告区里的一篇） | 本机已装 pi 的 `CHANGELOG.md`（**不在仓库里**） | `node tools/pi-changelog-gen.mjs` | `node tools/pi-changelog-gen.mjs check` |

细节：
- **真题库是「明文源 → 密文发布」管线**：`exam/data/N2/<卷>.js` → `encrypt` → `exam/data/N2/enc/*.js`（**唯一入库形态**）；运行时 `exam/exam-lock.js` 用 WebCrypto 解密（PBKDF2→KEK→DEK→HKDF→AES-GCM→inflate）。`exam/data/N2/index-lite.js` 是明文常驻例外（只有卷/题型/题数）。**部署只能经 git，绝不能整目录上传**（明文仍躺在工作区）。
- **调查报告**：`research/data.json` 是清单真源；报告 HTML 必须自包含（无外链 css/js，可 `file://` 直开）并带三对 `wb:shell:*` 外壳标记（`tools/research.mjs add-shell`）。
- **pi 更新履历报告是生成物**：`research/pi-changelog.html` 由 `tools/pi-changelog-gen.mjs` 从本机装的 pi 那个 600 KB 的 `CHANGELOG.md` 生成（3131 条原文全部内联），再自动补 `add-shell`。**别手改这个 HTML** —— 改分期文案 / 本机卡片改生成器里的 `ERAS` / `LOCAL` 常量后重跑；`check` 子命令会重跑一遍并与仓库里的成品比对，不一致就报第一次分叉的行号。找不到 pi 包时 `check` 退出 2，`tools/test.mjs` 据此标 SKIP（克隆仓库没有 pi，属正常）。
- `listener/audio/` 是**空目录且无任何引用**（疑似残留）。
- 英语侧的源材料在 `.scratch/`（`.gitignore` 排除）→ 相关 `check` / 套件在克隆仓库里跑不了，属正常。

## 三、怎么验

```bash
node tools/test.mjs                 # 一次跑「逻辑套件 + 静态校验」，克隆仓库即可全绿（CI 就是这条）
node tools/test.mjs --all           # 连需要 .scratch 源材料/密钥的也一起跑（缺的会真报 ✗）
node tools/test.mjs --exam-pass <口令>   # 额外跑 test_lock.js（加解密往返）
node tools/test.mjs --list          # 只看清单
```

套件与校验都在 `tools/tests/` 与 `tools/*.mjs|js`；需要额外材料的三类依赖：
ECDICT 源（英语侧三项）、真题 DEK（`.scratch/jlpt-exam/enc-keys/dek.b64`）、当前真题口令（`test_lock.js`）。

## 四、共享资源与硬约束

- `assets/style.css`（设计令牌：墨 Sumi 体系 + 唯一朱色 accent）、`theme.js`（主题 + PDF 导出按钮）、`progress.js`（学习进度）、`quiz.js`（单元页自测）。
- **品牌标记（QY）四处同源**：`index.html` 的 `.portal-brand-mark`（30px）+ 同页 favicon data URI + `tools/research.mjs` 的 `SHELL_CSS`/`SHELL_BAR`/`SHELL_FLOAT`（20px）+ 英语侧生成页的 favicon（常量 `tools/brand.mjs`，`en-vocab.mjs` / `en-reading.mjs` import，覆盖 109 页；另有 `en/dictation/index.html`、`en/typing/index.html` 两份手写页自带 favicon）。改报告外壳模板后必须重跑 `node tools/research.mjs add-shell research/*.html`（外壳是写进文件的）；改标记后重跑 `node tools/en-vocab.mjs gen` + `node tools/en-reading.mjs gen`。`tools/tests/icon-set.js` 对全仓 111 个 favicon 逐字节比对兜底。
- **模块图标只定义一次**：`assets/style.css` 的「线描图标集」标记区（`--ic-*` + `.im` / `.im-*`），新增图标改 `.scratch/icons/gen-icon-css.mjs` 后插入（手写 data URI 必错）；`tools/tests/icon-set.js` 校验用法↔定义、编码、裸声明、品牌标记四处同源与全仓 JS 语法。
- **`file://` 优先**：浏览器在该协议下拦 `fetch()`，故数据一律内联（`<script type="application/json">` 或 `window.X = {...}`）或相对 `<script src>` 按需加载；**不要改成 fetch**。
- **无构建步骤、无外部依赖、无 `package.json`**：脚本一律 `node` 直跑，不引 npm 包。
- 改 UI 前先备份（见根 `AGENTS.md`）；改完 UI 至少跑一次 `node tools/test.mjs`。
