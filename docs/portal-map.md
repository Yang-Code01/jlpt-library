# 仓库地图（导航指针）

> 目的：新会话不必逐目录勘察。**改门户、找数据真源、找生成器、跑检查**都从这里定位。
> 术语以 `CONTEXT.md` 为准，架构取舍以 `docs/adr/` 为准；本文件只讲「东西在哪、谁写它、怎么验」。

## 一、门户 `index.html`（唯一首页，零构建、`file://` 直开）

一层 `data-lang`（日语 / 英语）+ 一层 `data-area`（区：`study` / `survey` / `tools` / `snooker`）驱动显隐，状态分别记在
`localStorage` 的 `jlpt-lang` / `jlpt-area`（`#survey` / `#tools` / `#snooker` 可深链直达对应区）。
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
| `listening/` | 听力专项 | `listening/data/<level>/<卷>.js` + `audio/` + `pdf/`（每题注音讲义） | 讲义：本地 `.scratch/listening-pdf/`（需 kuromoji，不入库，见 ADR-0009） | `node tools/listening-handout.mjs` |
| `en/` | 英语侧（词表单元 / 阅读 / 搭配） | `.scratch` 里的 ECDICT / Gutenberg 缓存（**不入库**） | `tools/en-vocab.mjs`、`en-reading.mjs`、`en-typing.mjs` | `node tools/en-accept.mjs` |
| `research/` | 调查报告 | `research/data.json` | `node tools/research.mjs gen` | `node tools/research.mjs check` |
| `pi-tui/` | pi 的 TUI 增强包 `pi-tui-plus`（pi-open-tui 自有分支：footer + 模型选择器 + 网关状态） | 自身源码（15+3 个 ts，无依赖） | 无（pi 直接加载目录） | `node tools/tools.mjs check`（版本 / 包 / 清单一致） |
| `wb2api/` | WorkBuddy2API 部署包（额度转 OpenAI / Anthropic 网关：源码 + 兼容层补丁，`compose up -d --build` 现场编译），详情页 `tools-dev/wb2api.html` | 上游 `linguo2625469/workbuddy2api-panel` rev `6b31db6` + 兼容层（`src/internal/server/{responses,messages}.go`） | 无生成器（`src/` 与 `patches/` 手工更新，步骤见包内 `UPSTREAM.md`） | `node tools/tools.mjs check`（版本从 `src/cmd/server/main.go` 的 `appVersion` 取，见 `versionFrom`） |
| `tools-dev/` + `tools/tools.mjs` | 工具开发区的清单与下载 | `tools-dev/data.json` + `tools-dev/<page>.html` | `node tools/tools.mjs gen`、`pack <id>` | `node tools/tools.mjs check` |
| `research/pi-changelog.html` | pi 更新履历报告（报告区里的一篇） | 本机已装 pi 的 `CHANGELOG.md`（**不在仓库里**） | `node tools/pi-changelog-gen.mjs` | `node tools/pi-changelog-gen.mjs check` |
| `assets/snooker*.js` | 斯诺克信息区（赛季轨道 + 世界排名 + 单站天梯图与赛程） | snooker.org 的 `template=31 / 2 / 7` 三张表 + **逐站 `index.asp?event=<id>` 对阵页** | `node tools/snooker.mjs`（线上由 `.github/workflows/snooker.yml` 每 10 分钟跑） | `node tools/snooker.mjs --check`（需联网）、`tools/tests/test_snooker.js`（含已入库快照的契约校验，离线） |

细节：
- **真题库是「明文源 → 密文发布」管线**：`exam/data/N2/<卷>.js` → `encrypt` → `exam/data/N2/enc/*.js`（**唯一入库形态**）；运行时 `exam/exam-lock.js` 用 WebCrypto 解密（PBKDF2→KEK→DEK→HKDF→AES-GCM→inflate）。`exam/data/N2/index-lite.js` 是明文常驻例外（只有卷/题型/题数）。**部署只能经 git，绝不能整目录上传**（明文仍躺在工作区）。
- **工具区**：`tools-dev/data.json` 是清单真源；版本默认取 `<dir>/package.json`，源码仓库（Go 之类）用 `"versionFrom": {file, pattern}` 从源码常量取（`wb2api` 取 `src/cmd/server/main.go` 的 `appVersion`）。`check` 还会抓两件易漏的事：改了源码没重新 `pack`、详情页里手写的下载链接指向不存在的 zip（升版后最容易原地 404）。
- **调查报告**：`research/data.json` 是清单真源；报告 HTML 必须自包含（无外链 css/js，可 `file://` 直开）并带三对 `wb:shell:*` 外壳标记（`tools/research.mjs add-shell`）。
- **pi 更新履历报告是生成物**：`research/pi-changelog.html` 由 `tools/pi-changelog-gen.mjs` 从本机装的 pi 那个 600 KB 的 `CHANGELOG.md` 生成（3131 条原文全部内联），再自动补 `add-shell`。**别手改这个 HTML** —— 改分期文案 / 本机卡片改生成器里的 `ERAS` / `LOCAL` 常量后重跑；`check` 子命令会重跑一遍并与仓库里的成品比对，不一致就报第一次分叉的行号。找不到 pi 包时 `check` 退出 2，`tools/test.mjs` 据此标 SKIP（克隆仓库没有 pi，属正常）。
- **斯诺克信息区是「抓取侧生成、页面侧只读」**：`assets/snooker-data.js` 是快照（用 `window.SNOOKER = {...}` 注入而不是 `.json` —— `file://` 下 `fetch` 会被 CORS 拦死），`assets/snooker.js` 只负责渲染到 `#snk`，**天梯图渲染在 `assets/snooker-tree.js`**（`window.SnookerTree`，纯函数 + DOM 字符串，无依赖），页面里不允许出现 `fetch`（`tools/test.mjs` 的 `guardNoFetch` 守护）。轨道（`.snk-trk`）里**只有点击 / ↑↓ 会切换站点**；`pointermove` 仅做圆点磁吸与浮出 `.snk-peek` 摘要气泡，不得调用 `paint()`——历史上在这里写过「指针扫过即切换」，导致内容跟着鼠标乱跳（`docs/adr/0008` 修订段）。
  - 冻结裁剪（只留 16 强起 15 场）按「离决赛的层数」收敛：从决赛往外连「本轮胜者出现在下一轮」，凑满 15 场为止。**别按轮次 id 或页面顺序切**——各站行顺序不同（上海决赛在前、北爱在中间），冠军联赛的组赛轮 id(19) 还比决赛(15) 大；也别只按「场数 ≤8」筛——中国公开赛/武汉/深圳都有 2 场的外卡轮，会挤掉真正的 16 强。
  - 单站对阵页给的是**场级事实**（`scheduled` 单元格的 UTC 时刻、两行球员、比分、`roundinfo` 的奖金口径），存在 `calendar[i].matches[]`；**父子关系只能靠「子场已完赛 ⇒ 胜者出现在父场」推**，推不出来就画虚线（`inferred`），绝不猜 bracket 槽位。
  - 赛程抓取按状态机分层：赛周内 10 分钟、开赛前 7 天 6 小时、赛程还远（>7 天）**不抓**、已结束但仍没数据的站每天补一次。**每站有自己的 `fetchedAt`**（按抓取频率向下取整成时间桶，避免为时间戳反复提交）—— 不能拿全局 `updated` 当「上次抓取时间」：赛季进行中数据文件每 10 分钟就写一次，历史站会永远轮不到（踩过）。**冻结**判据是「日期已过 且 决赛双方齐备有比分」，冻结时裁到 Last 16 起的 15 场（上游赛后会把 `scheduled` 撤成 wst.tv 链接，开赛时刻就永久丢了，所以要趁赛周留下）。
  - 上游**不给总奖金**（`roundinfo` 只有 `Winner: £X; Runner-up: £Y` / `Losers receive £Z`），总奖金走手工表 `tools/snooker-prize-fund.json`（键优先 event id，值可写 `{value, from, src}`：`from` 表示「本站本赛季还没开打、数值沿用上届」，页面加 ≈ 并注明；来源是英文维基各站 infobox），缺则显示「—」。城市中文名与时区走 `tools/snooker.mjs` 的 `CITY_CN` / `TZ` 两张表（未覆盖回退英文原文 + `Europe/London`）。生成器只取 `tour=Main` 且非资格赛的行，并把 12 月那 8 个 `Championship League` Group 合并成一站；排名抓不到算失败（不写脏数据），赛历 / 冠军抓不到只报警告、沿用上次赛历。源站直连会被 Cloudflare 挡（403）：线上 runner 正常，本机要走 `127.0.0.1:18790` 代理，或先 `curl` 存页面再用 `--local*` 离线跑。
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
