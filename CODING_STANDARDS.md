# 编码规范（评审依据）

> 实施阶段不必逐条背；这是给**评审**（reviewer agent 或人）的判定依据。
> 凡是**机械可判**的规则都已经变成检查 —— 每条末尾标了「机械检查」的那一行就是证据，
> 评审不必靠肉眼重复它；只盯那些没有机械检查、只能靠判断的条目。

## 1. 逻辑改动必须带能失败的断言

- 行为改动（任何 `.js` / `.mjs` / 内联脚本）必须附**能失败的断言**，放在 `tools/tests/`，
  并登记进 `tools/test.mjs` 的清单。
- 「能失败」的判据：不满足时进程退出码 1。**只打印布尔值的冒烟脚本不算断言**
  （`tools/tests/domharness.js` 的 `H.check(name, cond)` 提供断言层：失败计数 → 退出码 1）。
- 已知缺口（改到时顺手补）：真题侧 `test_lazy.js` / `test_back2.js` / `test_back3.js` / `test_newexams.js`
  仍是打印式冒烟，只保证「不抛异常」。
- 机械检查：CI（`.github/workflows/check.yml`）跑 `node tools/test.mjs`；**没进清单的套件等于没接线**。

## 2. 生成物不要手改

- `jp-vocab/*/index.html`、`verb/units/*/index.html`、`verb/conjugation/index.html`、
  `typing/data/*.js`、`en/**`、`exam/data/N2/enc/*.js`，以及 `index.html` 里的三处标记区
  （`en:unit-lists` / `en:reading-lists` / `wb:report-list`）。
- 判断依据：改数据 → 重跑生成器 → 重跑校验。
- 机械检查：`node tools/test.mjs`（各 `gen/check` 会报「内容不一致 / 与真源不一致」）。

## 3. `file://` 优先是硬约束

- 数据一律内联（`<script type="application/json">` / `window.X = {...}`）或相对 `<script src>` 按需加载；
  **不要**用 `fetch` / `XMLHttpRequest`（唯一例外：`dictation/dictation.js` 调本机 VOICEVOX HTTP API）。
- 机械检查：`tools/test.mjs` 内置守卫「file:// 硬约束（无 fetch/XHR）」。

## 4. 行尾一律 LF

- 生成器写文件时按目标文件现有 EOL 保持（`const eol = /\r\n/.test(disk) ? '\r\n' : '\n'` 这类写法），
  比较时对行尾不敏感（`norm = s => s.replace(/\r\n/g, '\n')`）。
- 机械检查：`.gitattributes`（`* text=auto eol=lf`）+ `docs/adr/0004`。

## 5. 文件放哪：由「克隆仓库的人能不能用它」决定

- 能用 → 入库：测试 `tools/tests/`、工具 `tools/`、文档 `docs/`、数据真源随模块。
- 不能（源材料、密钥、明文真题、笔记、一次性脚本）→ `.scratch/`（`.gitignore` 排除）。
- **测试永远属前者**：放进 `.scratch/` 的测试在别人机器上不存在，等于没测。

## 6. 门户不变量（改 `index.html` 必查）

- `data-en-key` 必须恰 107 项 → **新元素不要用这个属性**。
- 学习进度 key = 路径末三段（`assets/progress.js` 的 `keyOf`）；改目录结构要重新校验「索引 href 集合 ≡ 单元页路径集合」。
- 报告条目行是 `div` + `.survey-title a::after` 覆盖层，**不能嵌 `<a>`**（浏览器会拆行）。
- 改完至少跑一次 `node tools/test.mjs`；改 UI 前先备份（见根 `AGENTS.md`）。
- 改了版面/样式再**看一眼真渲染**：`node .scratch/ui-harness/smoke.mjs`（需要本地装过 Playwright）。
  没有这步就无法自证「看起来对」——自动化断言只能证明 DOM 对。它同时会抓 JS 异常。

## 7. 提交

- 一次提交一件事（生成物与其数据真源同一提交，否则 `check` 必红）。
- 提交信息说清「为什么」，不只说「改了什么」。
