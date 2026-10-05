# en/reading —— 英语阅读（生成物 + 台账）

`index.html`（篇目页）与 `<档位>/<NN>.html`（30 篇正文页）**全部是生成物，勿手改**。
它们的来源、筛选门槛、分档规则与许可都记在这里。

## 生成

```bash
node tools/en-reading.mjs fetch   # 联网：抓 Gutenberg 下载榜 → 过内容门槛 → 缓存候选书正文
node tools/en-reading.mjs gen     # 读缓存：剥头尾 → 切篇 → 分档 → 写本目录 30 篇 + 门户清单区
node tools/en-reading.mjs check   # 只校验，不改文件；有问题退出码 1
```

`fetch` 只跑一次即可，之后 `gen` / `check` 全走本地缓存（不联网）。缓存位置：

| 路径 | 内容 |
|---|---|
| `.scratch/en-module/research/pg_catalog.csv` | Gutenberg 官方目录（79,533 行），用于内容门槛 |
| `.scratch/en-module/research/pg/top.html` | 下载榜页面 |
| `.scratch/en-module/research/pg/pg<书号>.txt` | 候选书正文（纯文本版） |
| `.scratch/en-module/research/pg/candidates.json` | 过筛后的候选书清单 |

`.scratch/` 不进仓库（见 `.gitignore`），克隆下来的人要自己跑 `fetch`。

## 数据来源与许可

| 项目 | 值 |
|---|---|
| 来源 | [Project Gutenberg](https://www.gutenberg.org/)（公有领域英文小说与短篇） |
| 许可 | 正文进入公有领域；Gutenberg 的 header / footer 已剥离，不在页面里 |
| 选书依据 | 官方目录 `pg_catalog.csv`（21,245,518 字节），`sha256 25882f0e4d06d759369f8ff0676376b5f79fcc41ba5b8373037975026cf62580` |
| 词表（判超纲用） | 同站的 `en/data/vocab.js`，衍生自 ECDICT（**MIT**） |
| 释义（超纲词词典） | 同上 —— 页面内联的 ECDICT 词条片段，MIT |
| 站点整体 | CC BY-NC 4.0；与上面两套数据各自单独声明，不互相覆盖 |

## 选书门槛（`fetch` 阶段一次过滤）

候选来自 Gutenberg 的「昨日」与「7 日」下载榜（`--n` 条，默认 200）。逐条过筛：

1. **在官方目录里**：拿不到 Subjects / Bookshelves 的书直接丢。
2. **语言**：只留英语。
3. **题材**：白名单（Novels / Short Stories / Adventure / Romance / Crime / SF & Fantasy / Historical / Humour / Children & Young Adult / Classics of Literature …）；黑名单（Erotic Fiction / Poetry / Plays / Biographies / Essays / Reference / History / Sociology / Religion / Philosophy / Travel / Cookery …）。
   —— 诗歌与剧本的段落太短、聚不成篇，另外算一道数值门槛（中位段长 < 18 词）。
4. **不露骨**：书名命中 `sex|sexual|erotic|kama|sutra|orgy|porn|nude|naked|brothel` 的丢（榜单里混得进来）。
5. **卒年**：**第一作者**的卒年早于 1800 的丢 —— 只看第一作者，否则「古书 + 现代编者」会被编者的年份放行。
6. **去重**：同一书名 + 第一作者姓氏只留一本（榜单里 Dracula、Jekyll、Pride and Prejudice 都有重号）。

实测（`--n 200`）：119 本候选 → 留 75 本（非英语 4 · 题材不合 29 · 标题露骨 1 · 卒年 <1800 的 5 · 重复 5）。

## 切篇与分档（`gen` 阶段）

- 剥掉 `*** START/END OF THE PROJECT GUTENBERG EBOOK ***` 之间的正文才算正文；`_斜体_` 标记折掉。
- 只按自然段聚合，**不在段中切**：目标 1,200 词，下一段会越过 1,620 词就收篇；成篇要求 **800–2,000 词**，残篇丢弃。实测篇池 6,023 篇。
- 难度指标：`cov1k` = 该篇中词频位次 ≤ 1000 的 token 占比（词形先还原再判位次，`running` 按 `run` 算），`cov2k` 作二级。
- **分档是相对的**：全部候选篇按 `cov1k` 降序（`cov2k` 二级、书号与段号定序）全局排序后**均分四段**，最易的一段归 1k，最难归 4k；每档取 6–10 篇，实际 8 / 8 / 7 / 7 = **30 篇**，一篇只归一档，一本书只取一篇。

> 原写法「取累计覆盖率最高的档」是**退化规则**（累计覆盖率随档位单调递增，实测 18/18 篇全判给最高档），已改成上面的相对分档。

实测四档：`cov1k` 69.5 / 66.2 / 63.9 / 60.0 %（逐档差 3.3 / 2.3 / 3.9 个百分点），平均 1,582 / 1,527 / 1,551 / 1,494 词。

## 页面上的三件事

1. **超纲词自动高亮**：不在四档 3,766 词表内的词标红。词形还原与词形变化反查的口径
   **必须与 `tools/en-reading.mjs` 逐字一致**（正则与函数在两边各写一份），否则「标红的词数」与生成器统计的对不上。
2. **点词查义**：四级兜底 —— 小写词形命中 → 词形还原后重试 → 反查词形变化字段 → **静默无反应**。
   专有名词（只以大写出现，如人名地名）不入词典也不高亮，点了什么都不弹。
   超纲词的释义在生成时内联进页面（`gloss`），页面**不联网也不查 ECDICT**。
3. **页底「标记为已读完」**：阅读没有天然终点，必须显式盖章，可取消；写进 `assets/progress.js`
   的同一个 `jlpt-progress`（按语言分组），门户上的数字跟着变。

**不做全文中文翻译** —— 页面正文只有英文，`check` 会扫正文里有没有 CJK 字符。

## 复查时要留意

- `check` 的「幂等」是**给定本地缓存**的字节一致：`fetch` 依赖 Gutenberg 的实时下载榜，
  榜单会变，重跑 `fetch` 会得到不同的候选书与篇目。已生成的 30 篇页面在仓库里，
  线上（GitHub Pages）用的是这些页面，不受榜单变化影响。
- 有些超纲词在 ECDICT 里根本没有条目（人名变体、外来词），查不到就**不标红**，
  页头计量里的「超纲词 N 个」写的是**实际标红的个数**，并在说明里交代漏掉了几个。
- 变形词的英释有时取到同形异义词（`are` 的英释是「公亩」），但**中释是对的**（`be` 的现在时复数），
  学习站以中释为准，不额外加工。
