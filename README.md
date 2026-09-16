# JLPT Library

JLPT（日本語能力試験）N1～N5 的日语学习站——学习资料、真题练习、课堂单词。

🌐 **在线浏览**：https://Yang-Code01.github.io/jlpt-library/

## 三大模块

门户 `index.html` 是三者统一的入口。

| 模块 | 入口 | 内容 |
|---|---|---|
| **学习资料** | `material/index.html` | N5 → N1 的基础知识・语法・词汇，共 168 个单元页；日语内容配振假名注音，每单元附自测 |
| **真题练习** | `exam/index.html` | 题型专练（按子题型 / 按真题顺序取题）＋ 整卷仿真（155 分钟、听力放最后、只播一次）；已入库 N2 2023.7 / 2023.12 两卷 |
| **课堂单词** | `jp-vocab/index.html` | 按课堂主题打包的副词词卡，共 6 单元 / 112 张卡；浏览、翻转卡、测验、间隔重复复习四态，词与例文均配音频 |

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

## 本地预览

任何浏览器直接打开 `index.html` 即可，无构建步骤、无外部依赖（无 CDN、无外链字体），`file://` 下功能完整。

## 许可证

本仓库内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 许可——
注明出处即可使用，但**不可商用**。

课堂单词模块的部分例文引自《新完全掌握 N2 词汇》，仅作个人学习用途。

## 贡献

欢迎 fork 自用与提交 Pull Request。Pull Request 会由 maintainer review 后决定是否合入。

## 仓库配置

本仓库使用本地 markdown 风格的 issue tracker 配置（详见 [`AGENTS.md`](./AGENTS.md)）。
`.scratch/`（issue 与决策记录）已被 `.gitignore` 排除，不会上传到 GitHub。
