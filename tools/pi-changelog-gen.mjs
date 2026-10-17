#!/usr/bin/env node
/*
 * 生成 research/pi-changelog.html：把 pi（@earendil-works/pi-coding-agent）的
 * CHANGELOG.md 整理成一页可检索的中文报告。
 *
 *   node tools/pi-changelog-gen.mjs               # 重写报告（末尾自动补跑 add-shell）
 *   node tools/pi-changelog-gen.mjs check         # 只校验：重跑一遍，与仓库里的成品逐字节比
 *   node tools/pi-changelog-gen.mjs probe         # 只探测源文件（找到退出 0，找不到退出 2）
 *   node tools/pi-changelog-gen.mjs <CHANGELOG.md 路径>   # 指定源，重写报告
 *
 * 源默认取本机全局安装的 npm 包（node 所在 nvm 版本的 node_modules，Linux/macOS 走
 * ../lib/node_modules）。找不到就退出 2，tools/test.mjs 据此把这条校验标成 SKIP。
 *
 * 报告是「源 → 生成物」而不是手写稿：3131 条原文、289 个折叠块都由 parse() 产出，
 * 只有 ERAS（六段分期）与 LOCAL（与本机相关的卡片）是手写中文解读。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { norm } from './lib/eol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT = join(REPO, 'research', 'pi-changelog.html');
const REL = 'node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md';
const ARGS = process.argv.slice(2);
const MODE = ['check', 'probe'].includes(ARGS[0]) ? ARGS[0] : 'write';
const GIVEN = MODE === 'write' ? ARGS[0] : ARGS[1];

/** 找本机全局安装的 pi 包里的 CHANGELOG.md（nvm / nvm4w / Linux 全局 / 显式路径） */
function findSource() {
  if (GIVEN) return existsSync(GIVEN) ? GIVEN : null;
  if (process.env.PI_CHANGELOG && existsSync(process.env.PI_CHANGELOG)) return process.env.PI_CHANGELOG;
  const nodeDir = dirname(process.execPath);
  const cands = [join(nodeDir, REL), join(nodeDir, '..', 'lib', REL)];
  const nvmRoot = join(process.env.LOCALAPPDATA || '', 'nvm');
  const nvm4w = join(process.env.APPDATA || '', 'nvm');
  for (const root of [nvmRoot, nvm4w]) {
    if (!root || !existsSync(root)) continue;
    for (const d of readdirSync(root)) cands.push(join(root, d, REL));
  }
  return cands.find((p) => existsSync(p)) || null;
}

const MISSING =
  '找不到 pi 的 CHANGELOG.md（找过 node 同级的 node_modules、nvm/nvm4w 各版本）。\n' +
  '装好 pi 后重试，或用 PI_CHANGELOG=<路径> / 直接把路径作为参数传进来。';

/** 已装包自身的版本（报告头部的「快照版本」用它，别写死） */
function readPkgVersion(srcPath) {
  try {
    return JSON.parse(readFileSync(join(dirname(srcPath), 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

const SRC = findSource();
if (MODE === 'probe') {
  if (!SRC) {
    console.error(MISSING);
    process.exit(2);
  }
  console.log(SRC);
  process.exit(0);
}
if (!SRC) {
  console.error(MISSING);
  process.exit(2);
}
const pkgVersion = readPkgVersion(SRC);

/* ------------------------------------------------------------------ 解析 */

const CATS = {
  'New Features': { key: 'new', label: '新功能' },
  Added: { key: 'added', label: '新增' },
  Changed: { key: 'changed', label: '变更' },
  Fixed: { key: 'fixed', label: '修复' },
  'Breaking Changes': { key: 'breaking', label: '破坏性变更' },
  Breaking: { key: 'breaking', label: '破坏性变更' },
  Removed: { key: 'removed', label: '移除' },
};

function parse(md) {
  const versions = [];
  let cur = null;
  let sec = null;
  let item = null;
  const push = () => {
    if (item && sec) sec.items.push(item);
    item = null;
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const vm = line.match(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/);
    if (vm) {
      push();
      if (sec) cur.sections.push(sec);
      cur = { version: vm[1], date: vm[2], sections: [] };
      versions.push(cur);
      sec = null;
      continue;
    }
    if (/^## /.test(line)) {
      push();
      if (sec) cur.sections.push(sec);
      sec = null;
      continue;
    }
    if (!cur) continue;
    const sm = line.match(/^### (.+?)\s*$/);
    if (sm) {
      push();
      if (sec) cur.sections.push(sec);
      const meta = CATS[sm[1]] || { key: 'other', label: sm[1] };
      sec = { ...meta, title: sm[1], items: [] };
      continue;
    }
    if (!sec) {
      // 少数早期版本直接写入裸条目（没有 ### 分组），兜一个「未分组」
      sec = { key: 'other', label: '未分组', title: '未分组', items: [] };
      cur.sections.push(sec);
    }
    const bm = line.match(/^- (.*)$/);
    if (bm) {
      push();
      item = { text: bm[1], extra: [] };
      continue;
    }
    if (item && /^\s+\S/.test(line)) {
      // 续行：嵌套说明 / 代码块
      item.extra.push(line.replace(/^\s{2}/, ''));
      continue;
    }
    if (!line.trim()) continue;
    if (item && item.extra.length) item.extra.push(line);
  }
  push();
  if (sec && cur) cur.sections.push(sec);
  for (const v of versions) v.sections = v.sections.filter((s) => s.items.length);
  return versions;
}

/* ------------------------------------------------------- markdown → HTML */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function linkHtml(label, url) {
  const issue = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+/.test(url);
  if (issue) return `<a class="ref" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  if (/^https?:\/\/github\.com\/[^/]+\/?$/.test(url) && /^@/.test(label))
    return `<a class="ref who" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  // 本地文档 / README 链接在报告里没有对应文件，只留文字
  if (/\.md(#.*)?$/.test(url) || /^(docs|examples|schemas)\//.test(url)) return esc(label);
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

function inline(text) {
  const codes = [];
  const links = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0001C${codes.length - 1}\u0001`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    links.push(linkHtml(label, url));
    return `\u0001L${links.length - 1}\u0001`;
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\u0001C(\d+)\u0001/g, (_, i) => codes[+i]);
  s = s.replace(/\u0001L(\d+)\u0001/g, (_, i) => links[+i]);
  return s;
}

/** 条目开头若是 **加粗标题**，抽出来做摘要预览 */
function headline(text) {
  const m = String(text).match(/^\*\*(.+?)\*\*/);
  return m ? m[1].replace(/[`:]/g, '') : '';
}

function plain(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderExtra(lines) {
  const out = [];
  let code = null;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (code) {
        out.push(`<pre class="snippet">${esc(code.join('\n'))}</pre>`);
        code = null;
      } else code = [];
      continue;
    }
    if (code) code.push(line);
    else if (line.trim()) {
      const t = line.trim();
      const nested = t.startsWith('- ') ? `· ${t.slice(2)}` : t;
      out.push(`<p class="note">${inline(nested)}</p>`);
    }
  }
  if (code && code.length) out.push(`<pre class="snippet">${esc(code.join('\n'))}</pre>`);
  return out.join('');
}

/* -------------------------------------------------------------- 手工内容 */

const ERAS = [
  {
    id: 'E1',
    n: '01',
    title: '从零到能用：TUI 骨架与工具集',
    from: '0.10.0',
    to: '0.30.1',
    blurb:
      '2025-11-25 首发，随后一个月内几乎天天发版。交互式 TUI、七个内置工具、会话续接这些基本盘都在这一段落定；凭据、设置、会话 ID 也随之定型。',
    bullets: [
      '首发即含 `read`/`write`/`edit`/`bash`/`glob`/`grep`/`think` 七个工具、`/export` HTML 导出、`/model` 运行时切模型，接 Anthropic / OpenAI / Google 三家。',
      'hook 与 custom tool 体系在 12 月内长出雏形，随后被 0.35.0 合并为 extensions（见下一段）。',
      '0.28.0 把 API key 从 `settings.json` 搬进 `auth.json`；0.29.0 把 `/clear` 改名 `/new`；0.29.1 统一出 `/settings` 菜单并支持 `SYSTEM.md` 替换系统提示。',
      '0.31.0 会话条目改用 8 位短 ID，同时修掉 `edit` 在 Windows 上的 CRLF 匹配失败与 UTF-8 BOM 报错 —— 本机使用史里第一次出现 Windows 专属修复。',
    ],
    picks: [
      ['0.10.0', 'Initial public release', '初版：TUI + 七个工具 + HTML 导出。'],
      ['0.28.0', '凭据搬家', '`apiKeys` 从 settings.json 移除，改存 `~/.pi/agent/auth.json`（破坏性）。'],
      ['0.29.1', '统一 /settings', '思考级别、主题、队列模式收进一个菜单；自动加载 `SYSTEM.md`。'],
      ['0.31.0', 'Windows 修修补补', 'CRLF 行尾与 BOM 导致 `edit` 失败的经典坑被修。'],
    ],
  },
  {
    id: 'E2',
    n: '02',
    title: '扩展体系成形：hooks → extensions',
    from: '0.31.0',
    to: '0.50.9',
    blurb:
      '一月份的工作几乎都在给「第三方能插手 pi 的每个角落」铺路：消息队列拆成 steer / followUp、hooks 与 custom tools 合并成 extensions、浮层 UI 组件、RPC 协议。同时也是 provider 大扩张的开始。',
    bullets: [
      '0.32.0 把 `queueMessage()` 拆成 steer / followUp 两套语义（6 条破坏性变更），消息插入时机从此可分辨。',
      '0.35.0 是扩展体系的分水岭：`hooks` + `customTools` 合并为单一 `extensions`，目录 `hooks/`、`tools/` → `extensions/`，`commands/` → `prompts/`，flag `--hook`/`--tool` → `--extension`。',
      '0.39.0 起 `ctx.ui.custom({ overlay: true })` 能画浮动模态层，扩展的 UI 能力从纯文本行升级到组件树。',
      'provider 侧：Hugging Face（0.50.2）、Kimi For Coding（0.50.3）、Vercel AI Gateway、OpenAI Codex 官方支持（0.47.0）密集接入；0.50.4 补上 SSH / mosh 下的 OSC 52 剪贴板。',
    ],
    picks: [
      ['0.32.0', 'steer / followUp', '队列 API 一分为二，`queueMode` 改名 `steeringMode`（破坏性）。'],
      ['0.35.0', 'extensions 单轨', 'hooks 与 custom tools 合流；目录与 CLI flag 全部改名（破坏性）。'],
      ['0.39.0', 'overlay 组件', '`ctx.ui.custom({ overlay: true })` 支持浮动模态 UI。'],
      ['0.50.4', 'OSC 52', '`/copy` 在远程连接下也能写进本地剪贴板。'],
    ],
  },
  {
    id: 'E3',
    n: '03',
    title: '平台化：项目优先、内置工具可被接管',
    from: '0.51.0',
    to: '0.65.1',
    blurb:
      '二到四月，pi 从「一个能跑 agent 的终端」变成「一个能被改造的平台」：资源优先级改成项目优先、内置工具的渲染与参数可被扩展接管、扩展工具默认并行执行。破坏性变更也在 0.62.0 达到历史峰值（单版 14 条）。',
    bullets: [
      '0.51.0 一次补齐 Android / Termux、Alpine ARM64 musl、Nix / Guix 支持，并加入 bash spawn hook（执行前改写命令）。',
      '0.55.0 资源优先级改为 **项目优先**（`cwd/.pi` 先于 `~/.pi/agent`），扩展名冲突不再连坐卸载整个扩展。',
      '0.58.0 Claude Opus/Sonnet 4.6 上到 1M 上下文；扩展工具调用默认并行执行，只保留 `tool_call` 预检用于拦截。',
      '0.62.0 内置 read/write/edit/bash/grep/find/ls 变成可扩展的 `ToolDefinition`，渲染器可整体替换；同时引入统一的 `sourceInfo` 来源溯源 —— 这一版 14 条破坏性变更，是全程最贵的一次升级。',
      '0.63.0 起 `edit` 支持一次改多处（multi-edit），0.64.0 让老会话里的 `oldText/newText` 自动折成 `edits[]`；0.65.0 给出 session runtime API 与 `defineTool()`。',
    ],
    picks: [
      ['0.51.0', '跨平台爆发', 'Termux、linux-arm64-musl、Nix/Guix 同时到位。'],
      ['0.55.0', '项目优先', '资源查找顺序倒转，项目级 `.pi` 覆盖用户级配置（破坏性）。'],
      ['0.62.0', '内置工具可扩展', '七个内置工具全部 ToolDefinition 化 + `sourceInfo` 溯源（14 条破坏性）。'],
      ['0.65.0', 'runtime / defineTool', '会话运行时 API 与独立工具定义助手。'],
    ],
  },
  {
    id: 'E4',
    n: '04',
    title: '换东家与稳态：模型层统一、项目信任',
    from: '0.66.0',
    to: '0.80.10',
    blurb:
      '四月到七月的主题是「收拾屋子」：仓库与 npm scope 迁到 earendil-works、`models.json` 支持注释、`ModelRuntime` 统一模型与认证、项目级资源要经过信任才加载。同期还有图像生成、Windows ARM64 二进制、`max` 思考档。',
    bullets: [
      '0.66.0 的启动公告与 0.74.0 的「仓库链接与包名迁移」标志项目从 `badlogic/pi-mono`、`@mariozechner/*` 迁到 `earendil-works/pi`、`@earendil-works/*`；0.73.1 的 `pi update --self` 提前为此做了自更新兼容。',
      '0.73.1 `models.json` 支持注释与尾逗号（JSONC），自建 provider 终于能写说明。',
      '0.74.1 接入图像生成 API、Together AI、Windows ARM64 独立二进制。',
      '0.79.0 引入 **项目信任**：启动前先问是否加载项目级 settings / 扩展 / 技能；footer 同时开始显示最近一次 prompt cache 命中率。',
      '0.80.8 `ModelRuntime` 把模型目录、认证、刷新收成一层；`/model` 能后台刷新已配置 provider 的实时目录。',
    ],
    picks: [
      ['0.71.0', '砍掉 Gemini CLI', '移除 Gemini CLI 与 Antigravity 内置 provider（破坏性）。'],
      ['0.73.1', 'JSONC', '`models.json` 允许注释与尾逗号。'],
      ['0.74.0', '迁到 earendil-works', '仓库与包 scope 全面改名，旧链接重定向。'],
      ['0.79.0', '项目信任', '未知项目不再自动加载本地资源；footer 显示 cache 命中率。'],
      ['0.80.8', 'ModelRuntime', '模型目录 / 认证 / 刷新统一到一层 SDK。'],
    ],
  },
  {
    id: 'E5',
    n: '05',
    title: '全屏 TUI 与上下文工程',
    from: '0.81.0',
    to: '0.87.1',
    blurb:
      '七月末到九月，界面与上下文两头同时动刀：全屏 TUI 上线（自带 12 条破坏性变更）、Markdown 里能画 Mermaid 与 LaTeX、`AGENTS.override.md` 可按目录覆盖上下文；prompt cache 从「看不见」变成可预热、可按模型给预算。',
    bullets: [
      '0.81.0 支持连本地 llama.cpp router，搜索并下载 Hugging Face 模型；扩展可注册完整 provider。',
      '0.84.0 全屏 TUI 模式上线（运行时可切换）、Mermaid / LaTeX 渲染、`AGENTS.override.md` 按目录覆盖上下文；同版 12 条破坏性变更，集中在扩展渲染接口。',
      '0.84.3 为 Windows 加可选的原生 PowerShell 工具，并把自更新改成「先暂存校验、再原子切换」。',
      '0.86.0 prompt cache 可预热（长工具调用期间保活），`/bug` 支持带脱敏诊断上报，压缩预算可按模型配置。',
      '0.87.0 规范化会话上下文与扩展边界：用 `context_with_system` 改系统消息、思考块不再被当作普通文本传递。',
    ],
    picks: [
      ['0.81.0', '本地模型', 'llama.cpp router 接入 + 完整 provider 扩展。'],
      ['0.84.0', '全屏 TUI', '全屏模式 + Mermaid/LaTeX + 目录级上下文覆盖（12 条破坏性）。'],
      ['0.84.3', 'Windows PowerShell', '可选原生 PowerShell 工具，Windows 下执行更自然。'],
      ['0.86.0', '缓存预热', 'prompt cache warming、`/bug`、按模型配压缩预算。'],
      ['0.87.0', '上下文边界', '会话上下文规范化 + `context_with_system`。'],
    ],
  },
  {
    id: 'E6',
    n: '06',
    title: 'codemode 纪元与 1.x 稳定化',
    from: '0.99.0',
    to: '1.3.0',
    blurb:
      '0.99.0 是整个版本史里最大的一次结构变化：codemode（模型写 JS 调工具）、MCP、虚拟模型、分类器模型、system 主题一起来了。此后 1.0 把全屏设为默认，1.0–1.3 的补丁几乎都在做同一件事：**更省 token、更少缓存失效**。',
    bullets: [
      '0.99.0 codemode + MCP + virtual models + classifier models + system 主题；扩展事件里多出 `provider_stream_event` 这类可观测钩子。',
      '0.99.1 GPT-6.1 Sol 成为 OpenAI 默认模型；1.1.0 起 `--tools` 支持 `+name`/`-name` 增量调工具，并通过 OSC 7501 上报运行状态。',
      '1.0.0 全屏成为默认 TUI（`tuiMode: "regular"` 可回退）；codemode 提示词瘦身约 40%（GPT-5.6 单请求约 5,300 → 3,300 token），错误信息改成「教模型怎么恢复」。',
      '1.2.0 给 `settings.json` / `models.json` / keybindings / themes 发布 `$schema`，编辑器里可校验可补全；OpenRouter 按 key 列出可用模型与价格。',
      '1.3.0 把「缓存不失效」做到细处：GPT-6 上中途改思考档不掉缓存、换模型时丢掉上一个模型的思考块而非塞成文本、resume 保留会话中临时启用的工具。',
    ],
    picks: [
      ['0.99.0', 'Codemode and MCP', '模型写 JS 调工具、MCP 接入、虚拟/分类器模型、system 主题。'],
      ['1.0.0', 'Fullscreen by default', '全屏成为默认；codemode 提示词瘦身 40%。'],
      ['1.1.0', '`--tools +name/-name`', '在默认工具集上做增量增删，不用整份重写。'],
      ['1.2.0', '$schema', '配置文件发布 JSON Schema，编辑器校验与补全。'],
      ['1.3.0', '缓存友好', '改思考档保缓存、换模型清思考块、resume 保留工具。'],
    ],
  },
];

const LOCAL = [
  {
    v: '1.0.0',
    state: 'live',
    stateLabel: '已生效',
    title: '全屏 TUI 是默认了',
    body:
      '本机 `settings.json` 没有设 `tuiMode`，所以现在跑的就是全屏模式。想换回终端原生 scrollback：`"tuiMode": "regular"`，或临时 `--tui-mode regular`。',
  },
  {
    v: '0.99.0',
    state: 'todo',
    stateLabel: '可考虑',
    title: '主题仍钉在 dark，没吃到 system 自适应',
    body:
      '0.99.0 起默认主题是 `system`（从终端自己的调色板取色，终端明暗切换时重建）。本机钉了 `"theme": "dark"` —— 想跟着终端走就把这行删掉或设为 `"system"`。',
  },
  {
    v: '1.3.0',
    state: 'ok',
    stateLabel: '无影响',
    title: '自建 provider 的 `baseUrl` 要带 `/v1`',
    body:
      '1.3.0 把 `kimi-coding` 换成 Chat Completions，`models.json` 里覆盖它的 `baseUrl` 现在必须带 `/v1`。本机 `wb2api` 等自定义 provider 是 `openai-completions` 且 `baseUrl` 已含 `/v1`（如 `http://127.0.0.1:7863/v1`），不受这条影响；但以后接别的 OpenAI 兼容端点时记得同一条规矩。',
  },
  {
    v: '1.2.0',
    state: 'todo',
    stateLabel: '可考虑',
    title: '`models.json` 现在能挂 `$schema`',
    body:
      '1.2.0 给 `settings.json`、`models.json`、keybindings、themes 发布了 JSON Schema。本机 `models.json` 有十来个自定义 provider / 模型条目，加一行 `$schema` 就能在编辑器里补全与报错。',
  },
  {
    v: '0.79.7 / 0.60.0',
    state: 'warn',
    stateLabel: '注意',
    title: '`pi update` 只管 pi 自己，包不会顺带升级',
    body:
      '0.60.0 起启动不再自动更新未锁定的 npm / git 包；0.79.7 起 `pi update` 默认只更新 pi 自身，`--all` 才连 packages 一起。本机装了 `pi-subagents`、`pi-web-access`、`billion-context`、`pi-open-tui` 四个包，需要定期 `pi update --all`。',
  },
  {
    v: '0.62.0 → 0.87.0',
    state: 'warn',
    stateLabel: '注意',
    title: '本地三个扩展踩在改动最密的接口上',
    body:
      '`herdr-agent-state.ts`、`question.ts`、`questionnaire.ts` 用到扩展上下文与 UI 能力：0.62.0 内置工具渲染接口重写、0.80.4 生命周期钩子（`agent_settled`、`before_provider_request`）、0.87.0 上下文边界、1.2.0 `triggerTurn` 走 `before_agent_start`、1.3.0 扩展 overlay 的 `done()` 只关自己的浮层。升级后若扩展表现异常，先查这几处。',
  },
  {
    v: '1.0.0 / 1.1.0',
    state: 'ok',
    stateLabel: '无影响',
    title: 'codemode 越用越便宜',
    body:
      'codemode 自 0.99.0 起内置。1.0.0 把提示词压掉约 40% 并让报错自带恢复提示；1.1.0 起可用 `--tools +codemode,-write` 在默认工具集上增量增删；1.0.4 起 `--tools`/`--exclude-tools` 支持 `*` 通配。',
  },
  {
    v: '0.75.5 / 0.76.0 / 0.84.3',
    state: 'live',
    stateLabel: '已生效',
    title: 'Windows 这三条直接受益',
    body:
      '0.75.5 文件工具在 Windows 上改用异步文件系统操作；0.76.0 修 Windows / JetBrains 终端里的编辑行为；0.84.3 加入可选的原生 PowerShell 工具（不用再靠 bash 转发）。',
  },
  {
    v: '0.80.6 / 1.3.0',
    state: 'ok',
    stateLabel: '说明',
    title: '默认 thinking high，上面的档位都在',
    body:
      '0.80.6 增加 `max` 档、0.80.7 起 Fable 5 支持 `xhigh`/`max`；1.3.0 在 GPT-6（API key）上中途改档不再掉缓存 —— 本机 `defaultThinkingLevel: "high"` 属于中间档，往上还能试 `xhigh`/`max`。',
  },
];

/* ---------------------------------------------------------------- 统计 */

const versions = parse(readFileSync(SRC, 'utf8'));
const newest = versions[0];
const oldest = versions[versions.length - 1];

const countByCat = {};
const breaking = [];
let itemTotal = 0;
const months = new Map();

for (const v of versions) {
  v.items = 0;
  for (const s of v.sections) {
    v.items += s.items.length;
    itemTotal += s.items.length;
    countByCat[s.key] = (countByCat[s.key] || 0) + s.items.length;
    if (s.key === 'breaking') for (const it of s.items) breaking.push({ v: v.version, date: v.date, text: it.text });
  }
  const m = v.date.slice(0, 7);
  months.set(m, (months.get(m) || 0) + 1);
}
const monthList = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const busiest = monthList.reduce((a, b) => (b[1] > a[1] ? b : a));
const spanDays = Math.round((Date.parse(newest.date) - Date.parse(oldest.date)) / 86400000);

function eraOf(v) {
  const self = versions.findIndex((x) => x.version === v.version);
  let pick = ERAS[0].id;
  // versions 是最新在前（index 越小越新）：某期起点 index >= self 即该版本属这期
  for (const e of ERAS) {
    const idx = versions.findIndex((x) => x.version === e.from);
    if (idx !== -1 && idx >= self) pick = e.id;
  }
  return pick;
}

for (const v of versions) {
  v.items = v.sections.reduce((n, s) => n + s.items.length, 0);
  v.era = eraOf(v);
}
for (const e of ERAS) {
  const inEra = versions.filter((v) => v.era === e.id);
  e.count = inEra.length;
  e.dateFrom = inEra[inEra.length - 1]?.date || '';
  e.dateTo = inEra[0]?.date || '';
  e.items = inEra.reduce((n, v) => n + v.items, 0);
  e.vFrom = inEra[inEra.length - 1]?.version || e.from;
  e.vTo = inEra[0]?.version || e.to;
}

const CAT_ORDER = ['new', 'added', 'changed', 'fixed', 'breaking', 'removed', 'other'];
const CAT_LABEL = { new: '新功能', added: '新增', changed: '变更', fixed: '修复', breaking: '破坏性变更', removed: '移除', other: '其他' };
const catTotals = CAT_ORDER.map((k) => ({ key: k, label: CAT_LABEL[k], n: countByCat[k] || 0 })).filter((c) => c.n);

/* ---------------------------------------------------------------- 渲染 */

const eraById = Object.fromEntries(ERAS.map((e) => [e.id, e]));

function renderStats() {
  const cards = [
    ['版本总数', versions.length, `${oldest.version} → ${newest.version}`],
    ['时间跨度', `${Math.round(spanDays / 30.4)} 个月`, `${oldest.date.slice(0, 7)} → ${newest.date.slice(0, 7)}`],
    ['条目总数', itemTotal, '按分类拆分'],
    ['破坏性变更', breaking.length, `分布于 ${new Set(breaking.map((b) => b.v)).size} 个版本`],
    ['最忙一个月', busiest[1], `${busiest[0]} 发了 ${busiest[1]} 个版本`],
    ['最近一版', newest.version, newest.date],
  ];
  return `<div class="stats">${cards
    .map(
      ([label, num, sub]) => `<div class="stat">
        <span class="stat-label">${esc(label)}</span>
        <span class="stat-num">${esc(num)}</span>
        <span class="stat-sub">${esc(sub)}</span>
      </div>`
    )
    .join('')}</div>`;
}

function renderMonths() {
  const max = Math.max(...monthList.map((m) => m[1]));
  const bars = monthList
    .map(([m, n]) => {
      const pct = Math.round((n / max) * 100);
      return `<div class="m-col" title="${m}：${n} 个版本">
        <span class="m-n">${n}</span>
        <span class="m-bar" style="height:${Math.max(3, pct)}%"></span>
        <span class="m-x">${m.slice(2).replace('-', '/')}</span>
      </div>`;
    })
    .join('');
  const cats = catTotals
    .map(
      (c) =>
        `<span class="c-chip c-${c.key}"><b>${c.n}</b>${esc(c.label)}</span>`
    )
    .join('');
  return `<div class="cadence">
    <div class="chart">${bars}</div>
    <div class="cadence-note">
      <p>0.x 阶段几乎「一天一版」，${esc(busiest[0])} 一个月发了 ${busiest[1]} 个版本；进入 1.x 后节奏落到每周 1–2 个功能版。</p>
      <div class="cat-chips">${cats}</div>
    </div>
  </div>`;
}

function renderEras() {
  return ERAS.map(
    (e) => `<article class="era" id="era-${e.id}">
    <div class="era-head">
      <span class="era-n">${e.n}</span>
      <div class="era-title">
        <h3>${esc(e.title)}</h3>
        <span class="era-meta">${esc(e.vFrom)} – ${esc(e.vTo)} · ${esc(e.dateFrom)} → ${esc(e.dateTo)} · ${e.count} 个版本 · ${e.items} 条</span>
      </div>
    </div>
    <p class="era-blurb">${e.blurb}</p>
    <ul class="era-points">${e.bullets.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>
    <div class="picks">${e.picks
      .map(
        ([v, t, zh]) => `<div class="pick">
        <span class="pick-v">${esc(v)}</span>
        <span class="pick-t">${inline(t)}</span>
        <span class="pick-zh">${inline(zh)}</span>
      </div>`
      )
      .join('')}</div>
  </article>`
  ).join('\n');
}

function breakingMajorText() {
  const major = breaking.filter((b) => /^1\./.test(b.v));
  if (!major.length) return '1.x 之后没有破坏性变更。';
  const vers = [...new Set(major.map((b) => b.v))];
  return `只看 1.x 的话，只剩 ${major.length} 条（${vers.join('、')}）。`;
}

function renderBreaking() {
  const rows = breaking
    .map(
      (b) => `<tr>
      <td class="b-v">${esc(b.v)}</td>
      <td class="b-d">${esc(b.date)}</td>
      <td>${inline(b.text)}${''}</td>
    </tr>`
    )
    .join('');
  return `<div class="break-note">
    <p>跨大版本升级时真正会咬人的是这 ${breaking.length} 条。历史上最贵的三次是
    <b>0.62.0</b>（14 条，内置工具 ToolDefinition 化）、<b>0.84.0</b>（12 条，全屏 TUI 与扩展渲染接口）、
    <b>0.32.0 / 0.35.0</b>（队列 API 拆分、hooks→extensions 合并）。只关心从 0.x 上到 1.3.0 的话，按这张表倒序读一遍即可。</p>
  </div>
  <table class="break-table">
    <thead><tr><th>版本</th><th>日期</th><th>变更内容</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderLocal() {
  return `<div class="local-grid">${LOCAL.map(
    (l) => `<div class="local-card local-${l.state}">
      <div class="local-top">
        <span class="local-v">${esc(l.v)}</span>
        <span class="local-state">${esc(l.stateLabel)}</span>
      </div>
      <h4>${inline(l.title)}</h4>
      <p>${inline(l.body)}</p>
    </div>`
  ).join('')}</div>`;
}

function renderVersion(v) {
  const cats = [...new Set(v.sections.map((s) => s.key))].join(' ');
  const counts = v.sections
    .map((s) => `<span class="vc c-${s.key}">${esc(CAT_LABEL[s.key] || s.label)} ${s.items.length}</span>`)
    .join('');
  const peek = v.sections.length
    ? headline(v.sections[0].items[0].text) || plain(v.sections[0].items[0].text).slice(0, 60)
    : '该版本在 CHANGELOG 里只有版本号与日期，没记录条目';
  const body = v.sections.length
    ? v.sections
        .map(
          (s) => `<div class="block">
      <h4 class="block-h c-${s.key}">${esc(s.key === 'other' ? s.title : CAT_LABEL[s.key])}<span>${s.items.length}</span></h4>
      <ul class="block-list">${s.items
        .map((it) => `<li>${inline(it.text)}${it.extra.length ? renderExtra(it.extra) : ''}</li>`)
        .join('')}</ul>
    </div>`
        )
        .join('')
    : '<p class="note">该版本只打了个版本号（CHANGELOG 里空条目），通常是发版顺序调整或空提交。</p>';
  return `<details class="ver" id="v-${esc(v.version)}" data-era="${v.era}" data-cats="${cats}">
    <summary>
      <span class="v-tag">${esc(v.version)}</span>
      <span class="v-date">${esc(v.date)}</span>
      <span class="v-counts">${counts}</span>
      <span class="v-peek">${esc(peek)}</span>
    </summary>
    <div class="v-body">${body}</div>
  </details>`;
}

function renderArchive() {
  const groups = [];
  let curMonth = null;
  for (const v of versions) {
    const m = v.date.slice(0, 7);
    if (m !== curMonth) {
      if (curMonth) groups.push('</div>');
      const n = versions.filter((x) => x.date.startsWith(m)).length;
      groups.push(`<div class="month"><div class="month-head"><span>${m}</span><em>${n} 个版本</em></div>`);
      curMonth = m;
    }
    groups.push(renderVersion(v));
  }
  groups.push('</div>');

  const eraChips = ERAS.map(
    (e) => `<button type="button" class="chip" data-era-filter="${e.id}">${e.n} ${esc(e.vFrom)}–${esc(e.vTo)}</button>`
  ).join('');
  return `<div class="archive-bar">
      <input class="search" id="search" type="search" placeholder="搜版本号 / 日期 / 关键词（按 / 聚焦）" autocomplete="off">
      <div class="chips" id="cat-chips">
        <button type="button" class="chip on" data-cat="all">全部</button>
        <button type="button" class="chip" data-cat="new">新功能</button>
        <button type="button" class="chip" data-cat="added">新增</button>
        <button type="button" class="chip" data-cat="changed">变更</button>
        <button type="button" class="chip" data-cat="fixed">修复</button>
        <button type="button" class="chip breaking" data-cat="breaking">破坏性变更</button>
      </div>
      <div class="chips" id="era-chips"><button type="button" class="chip on" data-era-filter="all">全时期</button>${eraChips}</div>
      <div class="archive-tools">
        <span class="hit" id="hit"></span>
        <button type="button" class="chip" id="expand">全部展开</button>
        <button type="button" class="chip" id="collapse">全部收起</button>
      </div>
    </div>
    <div class="archive" id="archive">${groups.join('')}</div>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pi 更新履历 · ${esc(oldest.version)} → ${esc(newest.version)} · ${esc(newest.date)}</title>
<meta name="description" content="pi（@earendil-works/pi-coding-agent）${versions.length} 个版本的更新履历整理：按六段分期回顾、${breaking.length} 条破坏性变更清单、全量可检索归档。">
<style>
  :root{
    --bg:#0b0f14; --bg2:#0e141b; --panel:#121a23; --panel2:#16202b;
    --rule:#22303d; --rule-strong:#33465a;
    --ink:#e9eef4; --muted:#94a4b5; --dim:#6d7d8e;
    --accent:#e2855b; --accent-soft:rgba(226,133,91,.14);
    --new:#7fb3ff; --added:#6fcf97; --changed:#e0b155; --fixed:#9aa7b8;
    --breaking:#f07178; --removed:#c792ea; --other:#7dd3c0;
    --mono:ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,"SF Mono",monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;
  }
  @media (prefers-color-scheme: light){
    :root{
      --bg:#fbf9f6; --bg2:#f4f0ea; --panel:#fff; --panel2:#f7f3ee;
      --rule:#e2dbd1; --rule-strong:#cdc3b6;
      --ink:#1e242c; --muted:#5d6b7a; --dim:#8b97a4;
      --accent:#b4451f; --accent-soft:rgba(180,69,31,.09);
      --new:#1f6feb; --added:#1a7f45; --changed:#9a6a09; --fixed:#5d6b7a;
      --breaking:#b3261e; --removed:#7a3fa8; --other:#12695c;
    }
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
    line-height:1.75;-webkit-font-smoothing:antialiased}
  a{color:var(--accent)}
  code{font-family:var(--mono);font-size:.88em;background:var(--panel2);
    border:1px solid var(--rule);border-radius:4px;padding:.05em .34em;white-space:nowrap}
  .wrap{max-width:1060px;margin:0 auto;padding:0 26px}

  /* ---------- header ---------- */
  header{padding:64px 0 40px;border-bottom:1px solid var(--rule);
    background:linear-gradient(180deg,var(--bg2),var(--bg))}
  .kicker{font-family:var(--mono);font-size:11.5px;letter-spacing:.18em;text-transform:uppercase;
    color:var(--accent);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .kicker .dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}
  h1{font-size:clamp(30px,4.4vw,46px);line-height:1.18;margin:16px 0 6px;letter-spacing:-.02em;font-weight:700}
  h1 .range{font-family:var(--mono);font-size:.62em;color:var(--accent);white-space:nowrap;letter-spacing:-.01em}
  .lede{color:var(--muted);font-size:15.5px;max-width:800px;margin:10px 0 0}
  .lede b{color:var(--ink)}
  .src{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin-top:18px;line-height:1.9;
    border-left:2px solid var(--rule-strong);padding-left:12px;word-break:break-all}

  /* ---------- toc ---------- */
  nav{position:sticky;top:0;z-index:20;background:var(--bg);background:color-mix(in srgb,var(--bg) 92%,transparent);
    backdrop-filter:blur(10px);border-bottom:1px solid var(--rule)}
  nav .wrap{display:flex;gap:2px;overflow-x:auto;padding:8px 26px;scrollbar-width:none}
  nav .wrap::-webkit-scrollbar{display:none}
  nav a{color:var(--muted);text-decoration:none;font-size:13px;padding:6px 11px;border-radius:6px;white-space:nowrap}
  nav a:hover{color:var(--ink);background:var(--panel2)}
  nav a .idx{font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-right:5px}

  section{padding:56px 0 4px;scroll-margin-top:56px}
  .sec-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
  h2{font-size:clamp(21px,2.6vw,27px);margin:0;letter-spacing:-.01em;font-weight:700}
  .sec-en{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
  .sec-sub{color:var(--muted);font-size:14.5px;margin:8px 0 26px;max-width:820px}

  /* ---------- stats ---------- */
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1px;
    background:var(--rule);border:1px solid var(--rule);border-radius:12px;overflow:hidden}
  .stat{background:var(--panel);padding:18px 20px;display:flex;flex-direction:column;gap:2px}
  .stat-label{font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-family:var(--mono)}
  .stat-num{font-family:var(--mono);font-size:30px;line-height:1.25;font-weight:600;color:var(--ink)}
  .stat-sub{font-size:12px;color:var(--muted);font-family:var(--mono)}

  /* ---------- cadence ---------- */
  .cadence{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:26px;align-items:end;margin-top:30px}
  @media (max-width:760px){.cadence{grid-template-columns:1fr}}
  .chart{display:flex;align-items:flex-end;gap:6px;height:190px;
    border-bottom:1px solid var(--rule-strong);padding-bottom:2px}
  .m-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:4px}
  .m-bar{width:100%;background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 42%,transparent));
    border-radius:3px 3px 0 0;transition:filter .15s}
  .m-col:hover .m-bar{filter:brightness(1.25)}
  .m-n{font-family:var(--mono);font-size:11px;color:var(--muted)}
  .m-x{font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-top:2px}
  .cadence-note p{margin:0 0 14px;font-size:14px;color:var(--muted)}
  .cat-chips{display:flex;flex-wrap:wrap;gap:6px}
  .c-chip{font-family:var(--mono);font-size:11.5px;color:var(--muted);
    border:1px solid var(--rule);border-radius:999px;padding:3px 10px;display:inline-flex;gap:6px;align-items:center}
  .c-chip b{color:var(--ink);font-weight:600}
  .c-chip.c-new{border-color:color-mix(in srgb,var(--new) 45%,var(--rule))}
  .c-chip.c-breaking{border-color:color-mix(in srgb,var(--breaking) 45%,var(--rule))}

  /* ---------- eras ---------- */
  .era{border:1px solid var(--rule);border-radius:14px;background:var(--panel);
    padding:26px 28px;margin-bottom:18px}
  .era-head{display:flex;gap:18px;align-items:flex-start}
  .era-n{font-family:var(--mono);font-size:34px;line-height:1;color:var(--rule-strong);font-weight:600}
  .era-title h3{margin:0 0 4px;font-size:19px;letter-spacing:-.01em}
  .era-meta{font-family:var(--mono);font-size:11.5px;color:var(--dim)}
  .era-blurb{color:var(--muted);font-size:14.5px;margin:16px 0 14px}
  .era-points{margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:9px}
  .era-points li{position:relative;padding-left:18px;font-size:14.5px}
  .era-points li::before{content:"";position:absolute;left:2px;top:.68em;width:6px;height:1px;background:var(--accent)}
  .picks{margin-top:20px;border-top:1px dashed var(--rule);padding-top:14px;
    display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 20px}
  .pick{display:flex;flex-direction:column;gap:2px}
  .pick-v{font-family:var(--mono);font-size:11.5px;color:var(--accent)}
  .pick-t{font-size:13.5px;font-weight:600}
  .pick-zh{font-size:13px;color:var(--muted);line-height:1.6}

  /* ---------- breaking ---------- */
  .break-note p{margin:0 0 20px;font-size:14.5px;color:var(--muted);max-width:840px}
  .break-note b{color:var(--ink)}
  .break-table{width:100%;border-collapse:collapse;font-size:13.6px}
  .break-table th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;
    text-transform:uppercase;color:var(--dim);font-weight:500;padding:0 14px 10px;
    border-bottom:2px solid var(--rule-strong);position:sticky;top:44px;background:var(--bg)}
  .break-table td{padding:11px 14px;border-bottom:1px solid var(--rule);vertical-align:top}
  .break-table tr:hover td{background:var(--panel)}
  .b-v{font-family:var(--mono);white-space:nowrap;color:var(--breaking);font-size:12.5px;width:1%}
  .b-d{font-family:var(--mono);white-space:nowrap;color:var(--dim);font-size:11.5px;width:1%}
  .break-table td:last-child{color:var(--ink)}

  /* ---------- local ---------- */
  .local-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
  .local-card{background:var(--panel);border:1px solid var(--rule);border-radius:12px;
    padding:20px 22px;border-top:2px solid var(--rule-strong)}
  .local-live{border-top-color:var(--added)}
  .local-todo{border-top-color:var(--changed)}
  .local-warn{border-top-color:var(--breaking)}
  .local-ok{border-top-color:var(--rule-strong)}
  .local-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
  .local-v{font-family:var(--mono);font-size:11.5px;color:var(--dim)}
  .local-state{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;padding:2px 9px;border-radius:999px;
    border:1px solid var(--rule-strong);color:var(--muted)}
  .local-live .local-state{color:var(--added);border-color:color-mix(in srgb,var(--added) 50%,var(--rule))}
  .local-todo .local-state{color:var(--changed);border-color:color-mix(in srgb,var(--changed) 50%,var(--rule))}
  .local-warn .local-state{color:var(--breaking);border-color:color-mix(in srgb,var(--breaking) 50%,var(--rule))}
  .local-card h4{margin:0 0 6px;font-size:15px}
  .local-card p{margin:0;font-size:13.6px;color:var(--muted);line-height:1.75}

  /* ---------- archive ---------- */
  .archive-bar{display:flex;flex-direction:column;gap:10px;margin-bottom:18px;
    position:sticky;top:41px;z-index:15;background:var(--bg);
    background:color-mix(in srgb,var(--bg) 95%,transparent);
    backdrop-filter:blur(8px);padding:12px 0}
  .search{width:100%;background:var(--panel);border:1px solid var(--rule-strong);border-radius:9px;
    color:var(--ink);font-family:inherit;font-size:14px;padding:10px 14px;outline:none}
  .search:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .search::placeholder{color:var(--dim)}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{font-family:inherit;font-size:12.5px;color:var(--muted);background:var(--panel);
    border:1px solid var(--rule);border-radius:999px;padding:4px 12px;cursor:pointer;line-height:1.6}
  .chip:hover{color:var(--ink);border-color:var(--rule-strong)}
  .chip.on{color:#fff;background:var(--accent);border-color:var(--accent)}
  @media (prefers-color-scheme: light){.chip.on{color:#fff}}
  .chip.breaking.on{background:var(--breaking);border-color:var(--breaking)}
  .archive-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .hit{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--dim)}

  .month{margin-bottom:6px}
  .month-head{display:flex;align-items:baseline;gap:10px;padding:14px 0 8px;
    border-bottom:1px solid var(--rule-strong);margin-bottom:8px}
  .month-head span{font-family:var(--mono);font-size:13px;letter-spacing:.06em;color:var(--ink)}
  .month-head em{font-style:normal;font-family:var(--mono);font-size:11px;color:var(--dim)}

  .ver{border:1px solid var(--rule);border-radius:10px;background:var(--panel);margin-bottom:6px;overflow:hidden}
  .ver[open]{border-color:var(--rule-strong);background:var(--panel)}
  .ver>summary{display:grid;grid-template-columns:74px 88px auto minmax(0,1fr);gap:12px;align-items:center;
    padding:11px 16px;cursor:pointer;list-style:none;font-size:13.5px}
  .ver>summary::-webkit-details-marker{display:none}
  .ver>summary:hover{background:var(--panel2)}
  .v-tag{font-family:var(--mono);font-size:13px;color:var(--accent);font-weight:600}
  .v-date{font-family:var(--mono);font-size:11.5px;color:var(--dim)}
  .v-counts{display:flex;gap:5px;flex-wrap:wrap}
  .vc{font-family:var(--mono);font-size:10.5px;color:var(--muted);border:1px solid var(--rule);
    border-radius:4px;padding:1px 6px;white-space:nowrap}
  .vc.c-new{color:var(--new)} .vc.c-added{color:var(--added)} .vc.c-changed{color:var(--changed)}
  .vc.c-fixed{color:var(--fixed)} .vc.c-breaking{color:var(--breaking);border-color:color-mix(in srgb,var(--breaking) 45%,var(--rule))}
  .vc.c-removed{color:var(--removed)} .vc.c-other{color:var(--other)}
  .v-peek{color:var(--dim);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media (max-width:700px){
    nav .wrap{padding:8px 16px;-webkit-mask-image:linear-gradient(90deg,#000 86%,transparent);mask-image:linear-gradient(90deg,#000 86%,transparent)}
    .ver>summary{grid-template-columns:70px 1fr;grid-template-areas:"tag date" "counts counts" "peek peek";gap:6px 10px;padding:12px 14px}
    .v-tag{grid-area:tag} .v-date{grid-area:date} .v-counts{grid-area:counts} .v-peek{grid-area:peek}
    .v-peek{white-space:normal;line-height:1.6}
    .v-body{padding:4px 14px 14px}
  }
  .v-body{padding:4px 16px 16px;border-top:1px solid var(--rule)}
  .block{padding-top:12px}
  .block-h{font-size:11.5px;font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;
    margin:0 0 8px;display:flex;align-items:center;gap:8px;color:var(--muted)}
  .block-h span{font-size:10px;color:var(--dim);border:1px solid var(--rule);border-radius:999px;padding:0 6px}
  .block-h.c-new{color:var(--new)} .block-h.c-added{color:var(--added)} .block-h.c-changed{color:var(--changed)}
  .block-h.c-fixed{color:var(--fixed)} .block-h.c-breaking{color:var(--breaking)} .block-h.c-removed{color:var(--removed)}
  .block-h.c-other{color:var(--other)}
  .block-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
  .block-list>li{position:relative;padding-left:15px;font-size:13.8px;line-height:1.72}
  .block-list>li::before{content:"";position:absolute;left:0;top:.72em;width:7px;height:1px;background:var(--rule-strong)}
  .block-list b{color:var(--ink)}
  .local-card code,.break-table code,.note code{color:var(--ink)}
  .note{margin:6px 0 0;padding-left:10px;border-left:2px solid var(--rule);color:var(--muted);font-size:13px}
  .snippet{margin:8px 0 0;background:var(--bg2);border:1px solid var(--rule);border-radius:8px;
    padding:10px 12px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.7;color:var(--muted)}
  .ref{font-family:var(--mono);font-size:.92em;color:var(--dim);text-decoration:none;
    border-bottom:1px dotted var(--rule-strong)}
  .ref:hover{color:var(--accent);border-color:var(--accent)}
  .ref.who{color:var(--accent);opacity:.85}
  .empty{padding:40px 0;text-align:center;color:var(--dim);font-size:14px}

  footer{margin:70px 0 0;padding:26px 0 70px;border-top:1px solid var(--rule);
    color:var(--dim);font-size:12.5px;font-family:var(--mono);line-height:1.9}
  footer b{color:var(--muted)}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="kicker"><span>Pi Changelog</span><span class="dot"></span><span>${esc(newest.date)} 快照</span></div>
    <h1>pi 更新履历<br><span class="range">${esc(oldest.version)} → ${esc(newest.version)}</span></h1>
    <p class="lede">十一个月、<b>${versions.length} 个版本</b>、<b>${itemTotal} 条变更</b>。从 2025-11-25 的「TUI + 七个工具」起步，到 2026-10 的 codemode、MCP、虚拟模型与缓存优化。本页把它切成六段来讲，再把 ${breaking.length} 条破坏性变更单列成表，最后附一份全量可检索的版本归档。</p>
    <p class="src">数据源：本机 <code>node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md</code>（${esc(pkgVersion || newest.version)}，${(statSync(SRC).size / 1024).toFixed(0)} KB）<br>
    抓取方式：解析 markdown 后整页内联生成，条目原文为英文，分期说明与本机影响为中文整理。</p>
  </div>
</header>

<nav>
  <div class="wrap">
    <a href="#overview"><span class="idx">01</span>总览</a>
    <a href="#cadence"><span class="idx">02</span>发布节奏</a>
    <a href="#eras"><span class="idx">03</span>六段分期</a>
    <a href="#breaking"><span class="idx">04</span>破坏性变更</a>
    <a href="#local"><span class="idx">05</span>与本机</a>
    <a href="#archive"><span class="idx">06</span>全量归档</a>
  </div>
</nav>

<main class="wrap">
  <section id="overview">
    <div class="sec-head"><h2>总览</h2><span class="sec-en">Overview</span></div>
    <p class="sec-sub">${versions.length} 个版本按类别拆开的条目数分布，以及最直观的几个数：发版最密集的是 2025 年 12 月（一个版本号体系里能连发 ${busiest[1]} 版），最近一个月回落到每周 1–2 版。</p>
    ${renderStats()}
  </section>

  <section id="cadence">
    <div class="sec-head"><h2>发布节奏与条目构成</h2><span class="sec-en">Cadence</span></div>
    <p class="sec-sub">柱高＝当月版本数。0.x 阶段是把功能快速砸出来，1.0 之后节奏明显降下来，改动转向「省 token、少掉缓存、少出错」。</p>
    ${renderMonths()}
  </section>

  <section id="eras">
    <div class="sec-head"><h2>六段分期</h2><span class="sec-en">Six Eras</span></div>
    <p class="sec-sub">按版本号与日期切成六段，每段给一句主线、几条关键事实和代表版本。想快速了解「pi 是怎么长成现在这样的」，看这一节就够；具体某条改动去最后一节搜。</p>
    ${renderEras()}
  </section>

  <section id="breaking">
    <div class="sec-head"><h2>破坏性变更清单</h2><span class="sec-en">Breaking Changes</span></div>
    <p class="sec-sub">原文照录，按版本倒序。${breakingMajorText()}</p>
    ${renderBreaking()}
  </section>

  <section id="local">
    <div class="sec-head"><h2>与本机相关</h2><span class="sec-en">Local Impact</span></div>
    <p class="sec-sub">下面这些是从这份履历里挑出来、对<b>本机这套配置</b>（pi 1.3.0、Windows、自建 <code>wb2api</code> provider、四个 npm 包 + 三个本地扩展、codemode 开启）真正有影响的条目。</p>
    ${renderLocal()}
  </section>

  <section id="archive">
    <div class="sec-head"><h2>全量归档</h2><span class="sec-en">Full Archive</span></div>
    <p class="sec-sub">${versions.length} 个版本、${itemTotal} 条变更，按月分组。点版本号展开条目；搜索框匹配版本号、日期与条目正文，按 <code>/</code> 可直接聚焦。</p>
    ${renderArchive()}
    <p class="empty" id="empty" hidden>没有匹配的版本，换个关键词试试。</p>
  </section>
</main>

<footer class="wrap">
  <b>pi 更新履历</b> · ${esc(oldest.version)}（${esc(oldest.date)}）→ ${esc(newest.version)}（${esc(newest.date)}）<br>
  ${versions.length} 个版本 / ${itemTotal} 条变更 / ${breaking.length} 条破坏性变更 · 由 <code>.scratch/pi-changelog/gen.mjs</code> 从 CHANGELOG.md 生成<br>
  上游：<a href="https://github.com/earendil-works/pi">github.com/earendil-works/pi</a> · 本报告是 2026-10-15（1.3.0）时点的快照
</footer>

<script>
(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('.ver'));
  var months = Array.prototype.slice.call(document.querySelectorAll('.month'));
  var search = document.getElementById('search');
  var hit = document.getElementById('hit');
  var empty = document.getElementById('empty');
  var catChips = Array.prototype.slice.call(document.querySelectorAll('[data-cat]'));
  var eraChips = Array.prototype.slice.call(document.querySelectorAll('[data-era-filter]'));
  var cat = 'all', era = 'all';
  var hay = new Map();

  function textOf(card){
    if(!hay.has(card)){
      var t = card.textContent.toLowerCase();
      hay.set(card, t + ' ' + card.dataset.cats + ' ' + card.dataset.era.toLowerCase());
    }
    return hay.get(card);
  }

  function apply(){
    var q = (search.value || '').trim().toLowerCase();
    var shown = 0;
    for(var i=0;i<cards.length;i++){
      var c = cards[i];
      var ok = (era === 'all' || c.dataset.era === era)
            && (cat === 'all' || c.dataset.cats.split(' ').indexOf(cat) !== -1)
            && (!q || textOf(c).indexOf(q) !== -1);
      c.hidden = !ok;
      if(ok){ shown++; if(q || cat !== 'all' || era !== 'all') c.open = true; }
    }
    for(var j=0;j<months.length;j++){
      var m = months[j];
      var any = m.querySelector('.ver:not([hidden])');
      m.hidden = !any;
    }
    hit.textContent = shown + ' / ' + cards.length + ' 个版本';
    empty.hidden = shown !== 0;
  }

  catChips.forEach(function(btn){
    btn.addEventListener('click', function(){
      cat = btn.dataset.cat;
      catChips.forEach(function(b){ b.classList.toggle('on', b === btn); });
      apply();
    });
  });
  eraChips.forEach(function(btn){
    btn.addEventListener('click', function(){
      era = btn.dataset.eraFilter;
      eraChips.forEach(function(b){ b.classList.toggle('on', b === btn); });
      apply();
    });
  });

  var t = null;
  search.addEventListener('input', function(){
    clearTimeout(t);
    t = setTimeout(apply, 120);
  });
  document.getElementById('expand').addEventListener('click', function(){
    cards.forEach(function(c){ if(!c.hidden) c.open = true; });
  });
  document.getElementById('collapse').addEventListener('click', function(){
    cards.forEach(function(c){ c.open = false; });
  });
  document.addEventListener('keydown', function(e){
    if(e.key === '/' && document.activeElement !== search){ e.preventDefault(); search.focus(); }
    if(e.key === 'Escape' && document.activeElement === search){
      search.value = ''; apply(); search.blur();
    }
  });
  apply();
})();
</script>
</body>
</html>
`;

/** 落盘 + 补站点外壳（add-shell 幂等）；file 可指向临时文件，check 也走这条路 */
function finish(file) {
  writeFileSync(file, html);
  const r = spawnSync(process.execPath, ['tools/research.mjs', 'add-shell', file], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error((r.stderr || r.stdout || '').trim() || 'add-shell 失败');
    process.exit(1);
  }
}

if (MODE === 'check') {
  // 重跑一遍，和仓库里的成品逐字节比（行尾归一化，避免 CRLF/LF 造成假失败）。
  const tmp = mkdtempSync(join(tmpdir(), 'pi-changelog-'));
  const tmpFile = join(tmp, 'pi-changelog.html');
  try {
    finish(tmpFile);
    const want = norm(readFileSync(tmpFile, 'utf8'));
    if (!existsSync(OUT)) {
      console.error(`✗ 缺 ${OUT.slice(REPO.length + 1)}，跑 node tools/pi-changelog-gen.mjs 生成`);
      process.exit(1);
    }
    const have = norm(readFileSync(OUT, 'utf8'));
    if (want !== have) {
      const a = want.split('\n');
      const b = have.split('\n');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      const dump = (label, line) => console.error(`  ${label}：${String(line ?? '<无此行>').slice(0, 120)}`);
      console.error(
        `✗ 报告与生成器不一致（第一次分叉在第 ${i + 1} 行，${a.length} 行 vs ${b.length} 行）`
      );
      dump('仓库里', b[i]);
      dump('重新生成', a[i]);
      console.error('  说明：报告是生成物，别手改；改 tools/pi-changelog-gen.mjs 的 ERAS / LOCAL 后重跑。');
      process.exit(1);
    }
    console.log(
      `✓ pi 更新履历报告与生成器一致（${versions.length} 版本 / ${itemTotal} 条 / ${breaking.length} 条破坏性变更）`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  finish(OUT);
  console.log(
    `wrote ${OUT}  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${versions.length} versions, ${itemTotal} entries, ${breaking.length} breaking)`
  );
  console.log('加壳完成（add-shell 已补站点外壳）');
}
