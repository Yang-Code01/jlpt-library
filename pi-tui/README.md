# pi-tui-plus

**中文** | [上游英文 README](./README.upstream.md) · [上游中文 README](./README.zh-CN.md)

给 [pi](https://pi.dev)（终端里的 coding agent）加三样东西：一个说清状态的 footer、一个能用鼠标点的模型选择器、一行不占版的网关状态。整套东西是 [pi-open-tui](https://github.com/OldSuns/pi-open-tui) 的**自有分支** —— 改动长在自己家里，不会随上游升级被冲掉。

> 与上游唯一的差别是 `extensions/open-tui/footer.ts` 里多了一行 `alt+m 模型` 提示；其余上游功能原样保留（`/open-tui` 设置面板、theme、图标集、telemetry 全在）。

## 装了什么

| 扩展 | 做什么 | 依赖网关 |
|---|---|---|
| `open-tui` | Starship 风格底部信息：目录、分支、模型、思考档位、上下文占用、git 状态、telemetry | 否 |
| `wb-model-picker` | `alt+m`（或 `/pick`）弹出选择器：左栏模型列表（倍率、标签、当前项 ✓），右栏详情（说明、消耗速度、繁忙度、思考强度 ›、上下文窗口 ›）。键鼠双支持，三项都能改 | 否（有网关时多出倍率/繁忙度） |
| `wb-stats` | 一行状态：`↑in ↓out · 积分 本轮(一次用户请求的整跑，含工具循环)/会话 · N tok/s · R/W 缓存命中%`（上下文占用不在这条上重复，footer 右上角已有；上游繁忙度已按用户 2026-10 要求移除），用 `ctx.ui.setStatus` 发布，不跟 footer 抢位置 | 否（积分需网关） |

`wb-gateway.ts` 是两个 `wb-*` 扩展共用的探测层：读 `~/.pi/agent/models.json` 推网关地址、拉 `/v1/models` 与 `/status`、按本地请求日志算积分。**找不到网关就自动降级**，不报错、不阻塞。

## 装

pi 可以直接把目录当包加载，不用构建（Bun 直接跑 `.ts`）。

```bash
# 放进任意目录，然后把绝对路径加进 packages
pi install /path/to/pi-tui

# 临时挂一次，不改配置
pi -e /path/to/pi-tui
```

只想装其中一部分：删 `package.json` 里 `pi.extensions` 的对应项。`wb-*` 两个扩展共用同目录的 `extensions/wb-gateway.ts`，别单独拷走其中一个文件。

要求：pi ≥ 1.0.0（peerDependency，已装 pi 就不用 `npm install`）。鼠标点击需要 fullscreen 模式（pi 默认即是）；`regular` 模式下键盘仍然可用。

## ⚠ 不要和上游 `pi-open-tui` 同时装

本包 fork 了上游全部源码，其中 `open-tui` 那一份就是同一个扩展。两个都装 = 同一份东西装两遍，而 pi 既不去重也不同名检查，**一条警告都不会报**，只会静默错位：

| 哪里撞 | 同时装会怎样 |
|---|---|
| footer | footer 全局只能有一个：`ctx.ui.setFooter()` 后调用的接管前一个并 `dispose` 它（`extensions/open-tui/footer.ts:418`）。界面显示**后加载**那版，先加载那版的定时器还在跑却渲染不出来。两版代码不同时（本分支多一行 `alt+m 模型`），提示会时有时无 |
| 命令 `/open-tui` | 解析是 `resolveRegisteredCommands().find(...)`，**先加载的先得到**（pi 的 `runner.js:595`）。面板可能来自另一个版本，无提示；两版还读同一份 `~/.pi/agent/open-tui.json` |
| 快捷键 | pi 唯一会打诊断的地方（`Extension shortcut conflict: … Using …`）。但上游不注册任何快捷键，本包只新增 `alt+m`，没有重名键 → **连这条警告也不会有** |

pi 的去重是按「同一身份」（同名 npm 或同一路径），`npm:pi-open-tui` 与本地路径是两个身份，会各装一份。

```bash
# 换成这个包
pi remove npm:pi-open-tui
pi install /path/to/pi-tui
```

**只想加选择器、保留上游 footer**：删掉 `package.json` 里 `pi.extensions` 的第一项，只留后两个 —— 上游 `open-tui` 继续出 footer，本包只提供选择器与状态行：

```jsonc
"pi": {
  "extensions": [
    "./extensions/wb-model-picker.ts",
    "./extensions/wb-stats.ts"
  ]
}
```

这个组合下 footer 里不会有 `alt+m 模型` 提示（那行在本分支的 `open-tui` 里），但 `alt+m` 快捷键仍然可用。确认装了什么：看 `~/.pi/agent/settings.json` 的 `packages`，只应该有一条指向 pi-tui。

## 用

| 操作 | 效果 |
|---|---|
| `alt+m` / `/pick` | 打开模型选择器 |
| `↑` `↓` / `j` `k` | 在列表或子菜单里移动 |
| `→` / `Tab` / `l` | 进右栏详情 |
| `←` / `h` | 退回左栏；子菜单里退回详情 |
| `Enter` | 应用选中项，或展开子菜单 |
| `空格` | 展开思考强度 / 上下文窗口子菜单 |
| `Esc` | 关掉选择器（任何层级） |
| 鼠标 | 滚轮翻列表；单击选中、再点应用；点 `✕ 关闭` 退出 |
| `/wb2stats` | 开关状态行 |
| `/open-tui` | 上游设置面板（主题、图标、布局） |

为什么不用 `ctrl+shift+m`：不少终端把它退化成 Enter。为什么不能接管 `/model`：那是 pi 内置命令，扩展覆盖不了。

### 上下文窗口怎么切

真源是模型元数据里的 `contextWindow`。选择器给 25% / 50% / 75% / 100% 四档（1M 窗口按 50K 量化）。选中后用一份改了 `contextWindow` 的**模型副本**喂 `pi.setModel()`，选择记在 `~/.pi/agent/pi-tui-plus-state.json`，下次开会话自动贴回 —— 只改本会话的视图，不动 `models.json`。

## 配置（全部可选）

```jsonc
// ~/.pi/agent/pi-tui-plus.json
{
  "gateway": {
    "provider": "wb2api",                        // 也可用 WB2API_PROVIDER
    "baseUrl": "http://127.0.0.1:7863/v1",       // 覆盖从 models.json 推导出的地址
    "logDir": "F:\\docker\\workbuddy2api\\data\\request-logs"
  }
}
```

| 环境变量 | 作用 |
|---|---|
| `WB2API_PROVIDER` | 以哪个 provider 为准（默认：当前模型所在 provider） |
| `WB2API_BASE_URL` | 覆盖网关地址 |
| `WB2API_LOG_DIR` | 请求日志目录（积分统计用；没有就只显示网关健康度） |

积分优先按本地请求日志算，**只统计 `user_agent` 以 `pi` 开头的行** —— 同一台网关下还跑着别的客户端时不会算进来。

## 改

| 想改什么 | 动手的位置 |
|---|---|
| footer 的排列、颜色、图标 | `extensions/open-tui/footer.ts` |
| 选择器的版式、图标、标签 | `extensions/wb-model-picker.ts` 的 `iconFor()` / `tagsFor()` / `render()` |
| 状态行显示哪些段 | `extensions/wb-stats.ts` 的 `compose()` |
| 网关探测、积分、路径缩写 | `extensions/wb-gateway.ts` |

改完重启 pi 即生效。跑在 Bun 上：能用 TS 语法，但别把 `??` 与 `||` / `&&` 混在一行（会撞解析错误，实测踩过）。

## 局限

- **网关字段是私有约定**：倍率、繁忙度来自 `/v1/models` 与 `/status`，积分与余额来自 `/panel/api`，都是自定义字段；换别的网关这些列会空着，不报错。
- **余额是快照**：控制台数字每 15 秒刷一次，刚结束的那笔可能还没落账；状态行已把晚到的行增量补进当轮，仍可能有几分误差，以控制台为准。
- **上游更新要手动跟**：本包 fork 了 pi-open-tui 的 15 个源文件（约 3700 行），要上游新功能得自己 merge；换来的是升级不再冲掉你的改动。
- **上下文档位不是省钱开关**：它只改本会话认为的窗口大小，真要压缩历史用 `/compact`。

## 许可

MIT。上游代码版权归 pi-open-tui contributors（见 `LICENSE`）。
