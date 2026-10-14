# 行尾统一为 LF（`.gitattributes` 钉死）

Status: accepted

仓库所有文本文件的行尾一律 **LF**：`.gitattributes` 里 `* text=auto eol=lf` 是唯一真源，二进制类型单独标 `binary`。选它而不是依赖 `core.autocrlf=true`（此前状态：仓库里 LF、工作区 CRLF），是因为「生成器按 LF 产出、工作区是 CRLF」这组不一致制造了大批**假失败**——`tools/en-vocab.mjs check` / `tools/en-reading.mjs check` 报「内容不一致 index.html」、`jp-vocab/gen.js check` 全红，英语侧票据 10 的验收因此长期卡在 29/31。这类失败与真实内容无关，每次都要靠人工里数 `\r` 定位，属于该被机械规则消灭的类别。

## Considered Options

- **`eol=crlf`（工作区保持 CRLF）**：否决——生成器、Node 脚本、CI（Linux）都天然产出 LF，让两侧都对齐 CRLF 等于给每处写文件的地方都加一层转换。
- **什么都不做，继续靠 `core.autocrlf=true`**：否决——它只管检出/入库的转换，不管生成器直接写盘的字节，也不管脚本读盘比较；这正是历次假失败的成因。
- **只在比较侧归一（`s.replace(/\r\n/g,'\n')`）**：保留为**第二道防线**（生成器写文件时仍按目标文件现有行尾保持、`check` 比较时对行尾不敏感），但不作为主手段——单独用它不能阻止行尾在工作区里继续漂移。
- **一次性的工作区归一，不加 `.gitattributes`**：否决——下次检出又变回 CRLF。

## Consequences

- 本决议附带一次**行尾归一提交**：工作区里 85 个 CRLF 文本文件被改成 LF。`git add -A` 只把这 3 个真的不同的文件入库（`assets/style.css`、`n5/grammar/01-desu-masu.html` 是混合行尾的 blob，`assets/theme.js` 另有内容修复），其余文件的 blob 本来就是 LF，工作区归一后**内容逐字节相等**（`git hash-object` 与 `HEAD:<path>` 一致），不会污染 diff。
- 生成器写文件时必须沿用目标文件现有行尾（`const eol = /\r\n/.test(disk) ? '\r\n' : '\n'`），比较时用行尾不敏感的归一；两条防线都在（`.gitattributes` + 生成器自身）。
- Windows 上克隆不再自动得到 CRLF 工作区；想用 CRLF 编辑器的人需自行设置，仓库不受影响。
- 二进制扩展名（`*.wav` / `*.mp3` / 图片 / 字体 / `*.pdf` / `*.zip`）显式标 `binary`，避免 `text=auto` 误判；`research/*.html`、`en/*/*.html`、`jp-vocab/*/index.html` 标 `linguist-generated` 只影响 GitHub 的 diff 折叠，不改变构建行为。
- 改动后必须跑 `node tools/test.mjs` 复核（它内含行尾与生成物一致性的检查）。
