# 品牌标记改拉丁字标 QY、模块 emoji 换线描图标集（个人工作台方向）

Status: accepted

站点定位从「JLPT 学习站」转为「**个人**工作台」，头部品牌标记与模块图标随之改。用户原话（定案问卷前的原话）：「现在变成的是【个人】工作台，要有个人的设计，我的姓名是杨庆敏。Qingmin Yang 从这里找灵感，做设计」；随后三轮问卷定下四件事：品牌标记方向取**拉丁字标**、形态取**QY 双字母**、模块图标取**线描 SVG**、姓名**只要英文**且边界为「档 1：名字英文，其余照旧」，范围**全站统一**（含报告外壳）。

## Considered Options

品牌标记（样张 `.scratch/icons/prototype/`，对比页 `compare-brand.html` 把六案摆进同一批真实位置：门户头部浅/深、报告外壳顶条、favicon 16/32px、与済章同框）：

- **A 现状「語」字标不动**：否决——站点已是个人工作台，字标却不体现个人，改了别的也白改。
- **B 「語」不动 + 姓名印作落款**：否决——用户选了「只要英文」，汉字印（楊）与这条冲突；且 21px 印面在 16px favicon 尺度上糊成一团。
- **C 木（楊の木偏）笔画标记**：否决——笔画标记在 16px 上确实比汉字清楚（可按档位光学补偿），但语义弱到没人能读出它跟「杨」有关。
- **D 拉丁字标（采纳）**：`QY`（拉丁衬线）取代「語」，favicon / 报告外壳同形。
- **E 只对齐设计令牌 + 页脚署名**：否决——不够，等于没做个人品牌。

形态（`compare-latin.html`）：**QY 双字母（采纳）** / Q 单字母 + 印式边栏 / 纯拉丁衬线全名。已知代价：QY 在 16px 标签页里两个字母各剩约 7px、Q 的尾与 Y 的叉会黏；用户接受该代价（单字母 Q 的辨识度更低，全名放不进去）。曾试过「Q 的尾兼作 Y 的叉」的一笔双字母，20px 下两条笔互相吃掉、读不通，已弃。

模块图标（`compare-icons.html`，14 行真实位置 × 4 列）：

- **emoji（现状）**：否决——字形随系统变、不受 `currentColor` 控制（三套主题里颜色不跟）、与站点线稿风格冲突。
- **每处手写 inline SVG**：否决——14 处重复，改一处漏十三处。
- **CSS mask + data URI（采纳）**：仓库既定标准（`assets/style.css` 里单元页导航图标、返回首页、自测早就是这么做的），颜色 `currentColor`、尺寸可参数化、只定义一次。
- 已被 inline SVG / mask 实现、**不该动**的：听写喇叭、返回首页 / 自测、资料库四形（16 处）、柯林斯 ★（排版符号）。真正要换的是 **7 处，不是 14 处**——这是那份对比页的主结论。

## Consequences

- **品牌标记有四处真源，改一处必须同步另三处**：① `index.html` 的 `.portal-brand-mark`（markup 与 CSS 同页，样式在 `index.html:109` 一带）；② `index.html` `<head>` 的 favicon data URI（两字母要塞进 32 视框，故字号/字距单独调）；③ `tools/research.mjs` 的 `SHELL_CSS` + `SHELL_BAR` / `SHELL_FLOAT` 两处标记（③ 改完必须对每份报告重跑 `node tools/research.mjs add-shell` —— 报告里的外壳是**写进文件的内容**，不是运行时注入）；④ 英语侧 109 份生成页的 favicon，常量收在 `tools/brand.mjs`，由 `tools/en-vocab.mjs` / `tools/en-reading.mjs` import（另有 2 份手写页 `en/dictation/index.html`、`en/typing/index.html` 自己带 favicon）。
- ⚠ **favicon 曾抄成两份常量，改标记时漏改 → 110 个英语侧页面集体停在旧「語」**（2026-10-15 收尾普查才抓到；`tools/en-vocab.mjs:228` 与 `tools/en-reading.mjs:111` 各一份）。④ 的修法是**把常量收进 `tools/brand.mjs`**（生成器侧唯一一份），并让 `tools/tests/icon-set.js` 对全仓 111 个 favicon **逐字节比对**门户那份 —— 抄两份就必然漏一处，靠测试拦比靠记性可靠。
- 报告外壳顶条那枚标记按 **20px** 容器定（`.wb-shell-mark`），门户头部那枚按 **30px** 定（`.portal-brand-mark`）；两处要一起改，否则同形不同比例。
- 报告外壳面包屑里的「工作台」**保留不动**：那是位置词（你在哪），不是签名；签名的位置是标记本身。
- 图标只定义一次：`assets/style.css` 的「线描图标集」标记区（`:root` 的 `--ic-*` + `.im` / `.im-*` 共 10 图）。新增图标先改 `.scratch/icons/gen-icon-css.mjs`（生成器，不入库）再插入，**不许手写 data URI**（`< > # "` 必须百分号编码，手写必错）。
- ⚠ **`--ic-*` 必须写在选择器块里**：顶层裸声明是无效 CSS，浏览器整段静默丢弃 → 所有图标变空白且控制台一声不吭。这个坑踩过一次，`tools/tests/icon-set.js` 现在会拦。
- 用法 `<span class="im im-x" aria-hidden="true"></span>`，尺寸走 `--im-size`（默认 `.95em`，跟着所在元素字号）、颜色走 `currentColor`（三套主题自动跟随）。与既有 inline SVG 和单元页 mask 导航图标**并存不合并**（避免一次改动面铺满全站）。
- **曾实现的汉字小印模块图标（試 巻 単 変 設 完）不再采用**：那是被否的一支，六页样张里逐字一致只是为了让「维度二」可独立比较。别再回头实现它。
- 姓名「档 1」的边界：门户头部品牌行、三个页脚首 span、`index.html` 的 `<title>` 改英文名；模块页标题、报告正文、`research/data.json` 不动（`data.json` 无作者字段，加署名要改 schema + `check`，本轮不做）。
- **済 章不动**（`assets/style.css` 里 `ul.unit-list li a.is-done::after`）：它是内容盖章（这一课已完成），不是品牌标记，与标记不同族。
- 机械保障：`tools/tests/icon-set.js` 已登记进 `tools/test.mjs`，查九件事——禁用符号普查（换掉的 9 个 emoji / 符号不得复辟）、`.im-*` 用法 ↔ 定义、data URI 编码可解、`--ic-*` 不许裸声明、`.im` 基类形状、标记必须 `aria-hidden`、**品牌标记四处同源**、**全仓 111 个 favicon 逐字节一致且生成器侧不再自带 FAVICON 字面量**，外加**全仓 JS 语法普查**。
- ⚠ **扫描型测试不能扫到自己**：`tools/tests/icon-set.js` 用 `git ls-files` 扫全仓，未入库时绿、一旦入库就扫到它自己写的禁用符号字面量与 `<span class="im …>` 正则，当场自报失败（提交后才发现）。故 `isUI` 排除 `tools/tests/` —— 测试源码不是 UI。新写“扫全仓”类检查时先想清楚：入库后它会不会出现在自己的射程里。
- 语法普查是因为这次真出了事故：`jp-vocab/vocab.js` 与 `verb/vocab.js` 里把 `<span class='im im-play'>` 写进了单引号 JS 字符串 → 整个脚本 SyntaxError → 单元页白屏，而当时 20 个套件全绿（没有套件会在 VM 里 parse 这两个文件）。防同类事故，宁可扫地。
- 样张与对比页留档在 `.scratch/icons/prototype/`（不入库）；改造前的 8 个 UI 文件备份在 `.scratch/jlpt-exam/backup-ui/*.pre-icon`。
