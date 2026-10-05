# Language Library

日语（JLPT N1～N5）与英语（词频 1k～4k）两条学习路径的离线学习站——学习资料、真题练习、课堂单词、词表背记。

🌐 **在线浏览**：https://Yang-Code01.github.io/jlpt-library/

## 三大模块

门户 `index.html` 是三者统一的入口。

| 模块 | 入口 | 内容 |
|---|---|---|
| **学习资料** | `material/index.html` | N5 → N1 的基础知识・语法・词汇，共 168 个单元页；日语内容配振假名注音，每单元附自测 |
| **真题练习** | `exam/index.html` | 题型专练（按子题型 / 按真题顺序取题）＋ 整卷仿真（155 分钟、听力放最后、只播一次）；已入库 N2 2023.7 / 2023.12 两卷 |
| **课堂单词** | `jp-vocab/index.html` | 按课堂主题打包的副词词卡，共 7 单元 / 157 张卡；浏览、翻转卡、测验、间隔重复复习四态，词与例文均配音频；「様子の副詞」另有 15 词重点模式 |
| **英语词表** | `en/1k/01.html` 起 | 按词频分 1k / 2k / 3k / 4k 四档、每 50 词一单元；列表与翻转卡可背，测验与间隔重复复习在同一单元页陆续补齐；数据由 `tools/en-vocab.mjs` 从 ECDICT 生成 |

## 目录结构

```
├── index.html              ← 门户首页（三模块入口）
├── material/
│   └── index.html          ← 学习资料落地页（168 单元索引）
├── assets/
│   ├── style.css           ← 全站样式与设计令牌
│   ├── theme.js            ← 浅色 / 护眼 / 深色主题切换
│   ├── progress.js         ← 学习进度（localStorage，含导入导出）
│   └── quiz.js             ← 把单元页的自测题变成可点选项
├── exam/                   ← 真题库：exam.html（整卷仿真）/ practice.html（题型专练）
│   ├── exam-core.js        ← 判分与进度存储
│   └── data/N2/            ← 每卷一个数据模块，另有 audio/ 与 manifest.json
├── jp-vocab/               ← 课堂单词：vocab.css + vocab.js + gen.js（生成/校验单元页）+ gen-audio.ps1（合成音频）+ 每单元一个子目录（含 data.json 与 audio/）
├── en/                     ← 英语侧：data/vocab.js（生成物）+ unit.css/unit.js（词表单元页的视图层）+ 1k…4k/ 单元页
├── tools/
│   ├── en-vocab.mjs        ← 英语词表生成器 / 校验器（gen | check）
│   └── encrypt-exam.mjs    ← 真题库加解密
├── n1/ … n5/               ← 各等级的学习页面（每级下 basics/ grammar/ vocab/）
├── docs/
│   ├── adr/                ← 架构决策记录
│   └── agents/             ← issue tracker / triage / 领域文档的约定
├── AGENTS.md               ← agent 配置入口
├── CONTEXT.md              ← 领域术语表
├── LICENSE                 ← CC BY-NC 4.0 许可证
└── README.md
```

168 个单元页的分布：N1 39、N2 41、N3 37、N4 27、N5 24。

## 数据来源

英语侧的词表不是手写的，由 `tools/en-vocab.mjs` 从下面的公开词表生成；`en/data/vocab.js`
与 `en/<档位>/<NN>.html` 都是生成物，**勿手改**。

| 数据 | 来源 | 许可 | 下载 |
|---|---|---|---|
| 词表（词条 / 音标 / 中释 / 英释 / 词频 / 考纲标签） | [ECDICT](https://github.com/skywind3000/ECDICT) | MIT | `ecdict.csv`（65.9 MB） |

源文件校验和：

```
sha256  ecdict.csv
1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf
```

重新生成（源文件不进仓库，因为 65.9 MB 且可随时下载）：

```bash
# 1. 把 ecdict.csv 放到 .scratch/en-module/research/ 下（或任意位置，用 --src 指定）
node tools/en-vocab.mjs gen      # 生成数据、单元页与门户的清单区
node tools/en-vocab.mjs check    # 校验：切点、单元数自洽、清单与文件双向一致、幂等、源文件校验和
```

词的选定规则：只取纯字母（含 `'` 与 `-`）词形、中文释义非空、词频字段 > 0 的条目，
按词频升序取前 3,766 个，再切成四档 —— `1k`（1–1000）、`2k`（1001–2000）、
`3k`（2001–2809）、`4k`（2810–3766）。

## 本地预览

任何浏览器直接打开 `index.html` 即可，无构建步骤、无外部依赖（无 CDN、无外链字体），`file://` 下功能完整。

## 许可证

本仓库内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 许可——
注明出处即可使用，但**不可商用**。

课堂单词模块的部分例文引自《新完全掌握 N2 词汇》，仅作个人学习用途。

> 英语词表数据（`en/data/vocab.js`）衍生自 ECDICT，按 **MIT** 许可使用，与上方的
> CC BY-NC 4.0 不同：署名 ECDICT / skywind3000 即可，不受非商用限制。两套数据
> 各自单独声明，不互相覆盖。

## 贡献

欢迎 fork 自用与提交 Pull Request。Pull Request 会由 maintainer review 后决定是否合入。

## 仓库配置

本仓库使用本地 markdown 风格的 issue tracker 配置（详见 [`AGENTS.md`](./AGENTS.md)）。
`.scratch/`（issue 与决策记录）已被 `.gitignore` 排除，不会上传到 GitHub。
