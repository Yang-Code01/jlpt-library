# Domain Docs

工程 skill 在探索这个 repo 时如何读领域文档。

## 开工前先读这两个

- **`CONTEXT.md`** 在仓库根
- **`docs/adr/`** — 读与你即将动手区域相关的 ADR

如果上面文件不存在，**默默跳过**。不要提示用户创建、不要主动建。`/domain-modeling` skill（在 `/grill-with-docs` 和 `/improve-codebase-architecture` 链路里）会在真正需要时懒加载生成。

## 目录布局（single-context）

```
C:\ai\library\library\
├── CONTEXT.md
├── docs/
│   ├── adr/
│   └── agents/                ← 本次 setup 的产物
│       ├── issue-tracker.md
│       ├── triage-labels.md
│       └── domain.md
├── index.html
├── assets/
└── n1/ … n5/
```

## 用 glossary 里的术语

写 issue 标题、写重构方案、写假设、写测试名时，**用 `CONTEXT.md` 里定义过的术语**，不要漂移到 glossary 明确排除的同义词。

需要但 glossary 里没有的术语，是个信号——你要么发明了项目不用的语言（重审），要么真有缺口（记到 `/domain-modeling`）。

## 与 ADR 冲突时显式标出

如果你的输出与已有 ADR 矛盾，**显式提出来**而不是悄悄覆盖：

> _与 ADR-0007（event-sourced orders）矛盾，但值得重开因为…_
