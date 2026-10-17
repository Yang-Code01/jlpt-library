# 门户加第三区「工具开发」：清单走 `tools-dev/data.json` + `tools/tools.mjs`，下载包由 `pack` 生成

Status: accepted

门户原来只有两个区（语言学习 / 调查报告），都是「读」的地方。自建工具需要一个能**拿走**的地方：看得懂是什么、装得起来、还能右键存下来改。于是加第三区「工具开发」，与另两区平级，`data-area="tools"`。

三条决定：

1. **清单是目录式，不是模板式。** `tools-dev/data.json` 只强制展示字段（`id / title / tags / status / version / updated / summary / page / dir / download`），每个工具的详情页是**手写的自包含 HTML**，版式随工具自己。理由：后期还会出现结构完全不同的工具（脚本、配置集、单页工具），用统一模板会逼着所有工具套一个壳；目录式只约束「怎么被列出来」。
2. **下载不依赖任何服务。** `node tools/tools.mjs pack <id>` 把工具目录打成 store-only zip 放进 `tools-dev/downloads/`，随仓库一起发布；详情页直接 `<a download href="…zip">`。`file://` 下双击可用，不需要 web server、不需要另一台机器。（store-only：自写 60 行 zip 写入器，不引依赖；固定时间戳让包可复现。）
3. **`check` 要能抓住「改了源码却忘了重打包」。** `downloads/manifest.json` 记每个文件的 sha256 与包的 sha256；`check` 逐文件比对，不一致就报「重新 pack」。同时校验：id 唯一、`status` 词表（可用/试验/暂停）、日期格式、标签受控、详情页存在、`package.json` 版本 ≡ `data.json` 版本、清单标记区与重渲染结果逐字一致。

## Considered Options

- **工具散落在各目录、门户里手写清单**：否决 —— 改标题要手改首页，且没有任何东西会提醒你漏了打包。
- **详情页套统一模板**：否决 —— 用户明确「后期还会有结构不同的工具」，模板会逼着它们套壳。
- **发布到 npm / 让用户 `git clone`**：否决 —— 用户就是要「下载一个 zip，解压即用」，且个人使用不发 npm。
- **打包时引入 `archiver` / `jszip`**：否决 —— 仓库零依赖约定（`file://` 站 + 无构建），60 行 store-only 写入器足够，解压工具全兼容。
- **把 `download` 文件名手写进 `data.json`**：否决 —— 文件名带版本，手写必然漂移；由 `pack` 回写。

## Consequences

- 新增工具 = 放目录 + 写一页详情 + 在 `data.json` 加一条 + `pack` + `gen`；`check` 与 CI 会验证这四步是否齐。
- `index.html` 的 `<!-- wb:tool-list:start/end -->` 是生成物，不许手改；手改会被 `check` 抓到。
- 三区共用一条显隐规则 `html[data-area="X"] .wb-pane:not([data-area-pane="X"])` —— 加第四区只改这一条，不再写两两成对的规则。
- 标签筛选函数 `wireTagFilter(scope, empty)` 按**容器**取 chip / item：门户里现在有两处清单，用全局选择器会让两边按钮互相串台（`tools/tests/test_area.js` 有断言钉住这一点）。
- 下载包体积写在清单里，所以 `pack` 结束时自动 `gen` 一次，避免「打了包但清单还写着旧体积」。
- 详情页不得引外部 css/js（与 `research/` 同一硬约束）；`file://` 直开要能看。
