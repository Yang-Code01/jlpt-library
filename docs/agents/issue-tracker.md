# Issue tracker: Local Markdown

Issue 与 PRD 落在 `.scratch/`，纯本地。

## 约定

- 一个 feature 一个目录：`.scratch/<feature-slug>/`
- PRD 在 `.scratch/<feature-slug>/PRD.md`
- 实现类 issue 在 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号
- Triage 状态写在每个 issue 文件顶部的一行 `Status:`（字符串见 `triage-labels.md`）
- 评论 / 讨论追加到文件末尾 `## Comments` 标题下

## skill 说"发布到 issue tracker"时

在 `.scratch/<feature-slug>/` 下新建文件（必要时建目录）。

## skill 说"取相关 ticket"时

读被引用的路径。用户通常直接传路径或 issue 编号。

## Wayfinding operations（`/wayfinder` 用）

- **Map**：`.scratch/<effort>/map.md` — Notes / Decisions-so-far / Fog 三段
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`,编号从 `01`
- **Type 行**:记录 `research` / `prototype` / `grilling` / `task`
- **Status 行**:记录 `claimed` / `resolved`
- **Blocking**:`Blocked by: NN, NN` 行;该 ticket 等列表里所有文件 `resolved` 才解锁
- **Frontier**:扫 `.scratch/<effort>/issues/`,找开放 + 未阻塞 + 未认领的,按编号顺序选
- **Claim**:开工前先写 `Status: claimed`
- **Resolve**:在 `## Answer` 下写答案,写 `Status: resolved`,把上下文指针（gist + 链接）追加到 map 的 Decisions-so-far

## 这个 repo 的特殊情况

- 没有 git / 没有 remote → 没有任何 PR,所以"PRs as a request surface"问题不适用
- 主体内容是静态 HTML（JLPT N1–N5 学习资料）。issue 通常落在以下几类:
  - 新增 / 修改 / 校对 `n1/` ~ `n5/` 下的 HTML 页面
  - 调整 `assets/style.css` 改全局样式
  - 更新 `index.html`(首页 / 入口页)
