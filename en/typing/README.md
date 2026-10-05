# 英语打字（en/typing/）

按词频四档（1k / 2k / 3k / 4k）随机出词，看着单词敲出它本身；三种模式（练习 / 竞技 60 秒 /
无尽）、五档速度倍率、最高分按「模式·档位·速度」分别记录。

**内核与日语打字共用一份** `typing/typing.js`（暗色街机风与 `typing/typing.css` 也是同一套）。
本目录只放语言层与词池，不含游戏逻辑。

## 文件

| 文件 | 作用 |
|---|---|
| `cfg.js` | 语言层覆盖对象 `window.TYPING_CFG`：四个档位、`en-US` 发音、词形判定（`readings` / `match`）、传送带时长按字母数 |
| `words.js` | 词池：读 `en/data/vocab.js` 现算四档，并把固定搭配塞进 4k 档 |
| `phrases.js` | **生成物**（`tools/en-typing.mjs gen` 产出）：37 条固定搭配，**勿手改** |
| `index.html` | 页面骨架：与日语打字页同 id 结构，不引 `assets/style.css` 与 `theme.js` |

脚本加载顺序固定：`en/data/vocab.js` → `phrases.js` → `words.js` → `cfg.js` → `typing/typing.js`。
英语页**不引** `typing/romaji.js`（内核守卫已按 `CFG.readings` 放行）。

## 词池计数

| 档位 | 词数 | 来历 |
|---|---|---|
| 1k | 999 | 词表 1k 档 1000 词 − `n't` |
| 2k | 1000 | 词表 2k 档 |
| 3k | 809 | 词表 3k 档 |
| 4k | 993 | 词表 4k 档 957 词 − `o'clock` + 37 条搭配 |

合计 3,801 条 = 词表 3,766 词 − 2（撇号词，内核只接受 `a–z` 与 `-`）+ 37 条搭配。
剔除的两个词记在 `window.EN_TYPING_META.dropped`，页面上写死的档位词数若与它对不上，测试会失败。

## 固定搭配：从站内阅读正文挖出来的

词表本身给不了搭配：ECDICT 里有 307,913 条含空格的词组（其中 307,469 条有中文释义），
但它们的 `frq` / `bnc` **全为 0** —— 没法按频率排序，按字母序排只会浮出 `a bad hat` 这类
冷僻词组；连字符复合词在可排名池（`frq > 0`）里是 0 条。

所以搭配来自**站内 30 篇阅读正文**（`en/reading/**/*.html` 的 `window.EN_ARTICLE.paras`，
共 46,191 词）—— 刻意只用仓库里已有的语料，任何人 clone 下来都能复现同一份结果：

```bash
node tools/en-typing.mjs gen     # 读站内阅读页 → 挖搭配 → 写 phrases.js
node tools/en-typing.mjs check   # 校验：门槛、形状、重复、字节一致
```

口径（详见 `tools/en-typing.mjs` 顶部注释）：

- 只统计**两侧都在词表前 2,000 名内**的二元组 / 三元组（避免冷僻词凑出来的伪搭配）；
- 两侧都是功能词、任一侧是限定词 / 物主词 / 代词的一律丢弃；
- 次数 ≥ 4 且互信息 PMI ≥ 3.3 才算候选，另有一张**人手剔除表**（22 条，逐条带理由，
  例如 `will come`、`sleep two`、`corner of` 这类句法残段）；
- 三元组只在它的两侧二元组都够格时才提升（否则会放出 `and you shall` 之类片段），
  最终产物是 `as soon as`、`be able to` 两条；
- 取前 120 条（下限 30 条，不够就报错）。

文字取自 Project Gutenberg 公有领域正文，因此搭配数据本身不受额外许可约束。

## 敲法：词组不要按空格

内核的 Space 是「开始 / 暂停 / 恢复」，且输入只接受 `a–z` 与 `-`，所以 4k 档的搭配
（`at once`、`as soon as`）要**连续输入字母**（`atonce`、`assoonas`），卡片会显示去掉空格的
提示串。页面上有一句提示说明这件事。

## 最高分

沿用日语侧的同一个 localStorage 键 `jlpt-typing-best`，按 `模式:档位:速度` 分条存储
（如 `competition:2k:1`）。英语档名是 `1k`–`4k`，与日语的 `n1`–`n5` 天然不冲突，
所以**不需要**新建存储键。

## 日语侧不变

`typing/typing.js` 为了支持英语只多了两处机械改动（其余全是默认值不变的覆盖点）：

1. 新增 `matchTyped(word, cand)`：有 `CFG.match` 就用它，否则仍走 `window.Romaji.match`；
2. `init()` 的守卫改为 `if (!window.Romaji && !CFG.readings)`；顺带把语音挑选改成
   **精确语言优先**（`ja-JP` 或 `en-US`），没有再退回前缀匹配。

日语回归缝：`node .scratch/typing-module/smoke.js`（55 项断言，含时长边界、最高分键格式、
无 `AudioContext` 时不崩）。

## 复查注意

- 任何**阅读篇目的增删**都会改变搭配挖掘语料 → 重新跑 `tools/en-typing.mjs gen`，
  `check` 会因字节不一致而报错。
- `phrases.js` 里的条数变了，`en/typing/index.html` 里写死的 `4k` 档词数（993）与
  `en/typing/words.js` 的 `EN_TYPING_META` 都要跟着核对（测试会抓）。
- 传送带时长公式（基础 3,400ms + 每字母 1,150ms、上限 16,000ms）与日语侧共用同一组常量，
  改一个会同时影响两侧。
