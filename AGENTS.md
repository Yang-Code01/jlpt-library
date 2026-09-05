# AGENTS.md

> Engineering-skill 配置入口。具体约定在 `docs/agents/` 下。

## Agent skills

### Issue tracker
- **Local markdown** — issue 落在 `.scratch/<feature>/issues/`，纯本地，不依赖 git/remote。详见 `docs/agents/issue-tracker.md`。

### Triage labels
- **中文词表**：待评估 / 需补充 / 可交给agent / 需人工 / 不做。详见 `docs/agents/triage-labels.md`。

### Domain docs
- **Single-context** — 一个 `CONTEXT.md` 在仓库根 + `docs/adr/`。详见 `docs/agents/domain.md`。
