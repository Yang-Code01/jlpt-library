/**
 * model-picker — WorkBuddy 风格的可点击选择器：模型 / 思考强度 / 上下文窗口。
 *
 * 为什么不用内置 /model：
 * - 内置 /model 写死在 interactive-mode.js 的 onSubmit 里，扩展命令无法覆盖它，
 *   所以入口是 `alt+m` 与 `/pick`。
 * - 内置选择器只显示 id/name，看不到倍率、说明、思考档位，也不能点。
 *
 * 上下文窗口不是 pi 的运行时概念，它来自 model.contextWindow。
 * 所以「切窗口」= 用改过 contextWindow 的模型克隆去 setModel（setModel 只校验 provider 的 auth）。
 * 覆盖值按模型 id 记在 model-picker-state.json，session_start 时贴回去。
 *
 * 网关元数据全部来自 wb-gateway.ts（同一份实现在 wb-stats.ts 里复用）。
 *
 * 鼠标只有 TUI 处于 fullscreen（alt-screen）模式才启用；regular 模式下键盘照常可用。
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { AGENT_DIR, fetchMeta, parseCredit, resolveGateway } from "./wb-gateway.ts";
import type { Busy, GatewayMeta } from "./wb-gateway.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, parseKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

const STATE_FILE = path.join(AGENT_DIR, "pi-tui-plus-state.json");
const LIST_MAX_ROWS = 15;

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABEL: Record<string, string> = {
	off: "关",
	minimal: "最小",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "极致",
};

type Meta = GatewayMeta;

interface Entry {
	model: Model<any>;
	id: string;
	name: string;
	credit: number | null;
	desc: string;
	supportsImages: boolean;
	onlyReasoning: boolean;
	maxCtx: number;
	levels: string[];
}

interface State {
	ctx: Record<string, number>;
}

function loadState(): State {
	try {
		const doc = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		return { ctx: doc?.ctx && typeof doc.ctx === "object" ? doc.ctx : {} };
	} catch {
		return { ctx: {} };
	}
}

function saveState(state: State): void {
	try {
		writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	} catch {
		// 记不住窗口大小不影响选模型
	}
}

function fmtCtx(n: number): string {
	if (!n) return "—";
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
	}
	return `${Math.round(n / 1000)}K`;
}

function fmtCredit(c: number | null): string {
	return c === null ? "—" : `${c.toFixed(2)}x`;
}

function wrapText(text: string, width: number, maxLines = 4): string[] {
	if (!text) return [];
	const out: string[] = [];
	let rest = text;
	while (rest.length > 0 && out.length < maxLines) {
		if (visibleWidth(rest) <= width) {
			out.push(rest);
			break;
		}
		let cut = Math.min(rest.length, width);
		while (cut > 0 && visibleWidth(rest.slice(0, cut)) > width) cut -= 1;
		if (cut <= 0) break;
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	return out;
}

/** 与 pi-ai/models.js 的判定保持一致：xhigh/max 必须显式出现在 map 里才算可选。 */
function levelsFor(model: Model<any>): string[] {
	if (!model.reasoning) return ["off"];
	const map = (model.thinkingLevelMap ?? {}) as Record<string, string | null | undefined>;
	const out: string[] = [];
	for (const level of LEVEL_ORDER) {
		const mapped = map[level];
		if (mapped === null) continue;
		if ((level === "xhigh" || level === "max") && !(level in map)) continue;
		out.push(level);
	}
	return out;
}

/** 上下文窗口档位：按模型上限取 1/4、1/2、3/4、满。 */
function ctxOptions(max: number): number[] {
	if (max <= 0) return [];
	const step = max >= 1_000_000 ? 50_000 : 25_000;
	const opts = [0.25, 0.5, 0.75, 1].map((f) => Math.max(step, Math.round((max * f) / step) * step));
	return [...new Set(opts)].sort((a, b) => a - b);
}

function iconFor(id: string, name: string): string {
	const key = `${id} ${name}`.toLowerCase();
	if (key.includes("auto")) return "⟳";
	if (key.includes("deepseek")) return "◆";
	if (key.includes("kimi")) return "◐";
	if (key.includes("glm")) return "◇";
	if (key.includes("hy") || key.includes("混元")) return "◎";
	if (key.includes("step")) return "▲";
	if (key.includes("bunny")) return "✧";
	if (key.includes("minimax")) return "◈";
	return "●";
}

function tagFor(entry: Entry): { text: string; tone: "success" | "warning" | "muted" } | null {
	if (entry.credit === 0) return { text: "免费", tone: "success" };
	if (entry.credit === null) return { text: "未标价", tone: "muted" };
	if (entry.onlyReasoning) return { text: "仅思考", tone: "warning" };
	if (entry.supportsImages) return { text: "多模态", tone: "muted" };
	return null;
}

function busyText(busy: Busy | null): string {
	if (!busy || busy.total === 0) return "未知";
	if (busy.healthy === 0) return "全部冷却";
	if (busy.inFlight === 0) return "空闲";
	return `${busy.inFlight} 请求中`;
}

type Row =
	| { kind: "model"; index: number }
	| { kind: "action"; action: "think" | "ctx" }
	| { kind: "option"; action: "think"; value: string }
	| { kind: "option"; action: "ctx"; value: number }
	| { kind: "close" };

interface Line {
	text: string;
	row?: Row;
}

/** 一行里左右两栏各自的可点区域：左边列表是模型、右边是动作或选项，命中要看 x 落在哪栏。 */
interface LineRows {
	left?: Row;
	right?: Row;
	/** 左栏文字的右边界（组件本地列，0 基） */
	split: number;
}

type KeyAction = "up" | "down" | "left" | "right" | "enter" | "esc" | "ctrlC" | "tab" | "space";

/**
 * 把终端输入解成动作。必须走 pi-tui 的 parseKey：fullscreen 模式会开启 Kitty 键盘协议，
 * 方向键会变成 `[1;1A` 之类、Esc 变成 `[27u`，自己按裸序列查表会全部接不到。
 */
function decodeKey(data: string): KeyAction | undefined {
	const id = parseKey(data);
	switch (id) {
		case "up":
		case "k":
			return "up";
		case "down":
		case "j":
			return "down";
		case "left":
		case "h":
			return "left";
		case "right":
		case "l":
			return "right";
		case "enter":
		case "return":
			return "enter";
		case "escape":
		case "esc":
			return "esc";
		case "tab":
		case "shift+tab":
			return "tab";
		case "space":
			return "space";
		case "ctrl+c":
			return "ctrlC";
	}
	// 老终端的裸序列兜底（parseKey 已覆盖大部分，这里只补最容易漏的三个）
	if (data === "\r" || data === "\n") return "enter";
	if (data === "\x1b") return "esc";
	if (data === "\t") return "tab";
	return undefined;
}

function clamp(n: number, len: number): number {
	if (len <= 0) return 0;
	return Math.min(Math.max(0, n), len - 1);
}

function padTo(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w > width) return truncateToWidth(text, width);
	return text + " ".repeat(width - w);
}

class Picker implements Component {
	private currentId: string;
	private entries: Entry[];
	private busy: Busy | null;
	private theme: any;
	private applyFn: (entry: Entry, level: string | undefined, ctxWindow: number, close: boolean) => void;
	private closeFn: () => void;
	private requestRenderFn: () => void;

	private selected: number;
	private pane: "list" | "detail" = "list";
	private menu: null | "think" | "ctx" = null;
	private menuIndex = 0;
	private detailIndex = 0;
	private offset = 0;
	private rows: (LineRows | undefined)[] = [];
	private activeLevel: string | undefined;

	constructor(opts: {
		entries: Entry[];
		busy: Busy | null;
		currentId: string;
		theme: any;
		activeLevel: string | undefined;
		onApply: (entry: Entry, level: string | undefined, ctxWindow: number, close: boolean) => void;
		onClose: () => void;
		requestRender: () => void;
	}) {
		this.entries = opts.entries;
		this.busy = opts.busy;
		this.currentId = opts.currentId;
		this.theme = opts.theme;
		this.activeLevel = opts.activeLevel;
		this.applyFn = opts.onApply;
		this.closeFn = opts.onClose;
		this.requestRenderFn = opts.requestRender;
		const idx = opts.entries.findIndex((e) => e.id === opts.currentId);
		this.selected = idx >= 0 ? idx : 0;
	}

	/** 应用成功后把 ✓ 挪到新模型上（浮层不关，所以需要主动刷新选中态）。 */
	markApplied(id: string): void {
		this.currentId = id;
		this.requestRenderFn();
	}

	private current(): Entry | undefined {
		return this.entries[this.selected];
	}

	private effectiveCtx(entry: Entry): number {
		return loadState().ctx[entry.id] ?? entry.maxCtx;
	}

	private levelFor(entry: Entry): string | undefined {
		if (this.activeLevel && entry.levels.includes(this.activeLevel)) return this.activeLevel;
		if (entry.levels.includes("high")) return "high";
		return entry.levels[entry.levels.length - 1];
	}

	private menuValues(): (string | number)[] {
		const entry = this.current();
		if (!entry) return [];
		if (this.menu === "think") return entry.levels;
		if (this.menu === "ctx") return ctxOptions(entry.maxCtx);
		return [];
	}

	private openMenu(kind: "think" | "ctx"): void {
		const entry = this.current();
		if (!entry) return;
		this.menu = kind;
		this.pane = "detail";
		const values = this.menuValues();
		const active = kind === "think" ? this.levelFor(entry) : this.effectiveCtx(entry);
		const idx = values.findIndex((v) => v === active);
		this.menuIndex = idx >= 0 ? idx : 0;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(40, width - 2);
		// 每行 = │ + 左 + │ + 右 + │，所以左右两栏宽度之和是 width - 3
		const content = Math.max(20, width - 3);
		let leftW = Math.min(42, Math.max(22, Math.floor(content * 0.52)));
		let rightW = content - leftW;
		if (rightW < 22) {
			leftW = Math.max(16, content - 23);
			rightW = content - leftW;
		}

		const leftLines = this.renderList(leftW);
		const rightLines = this.renderDetail(rightW);
		const height = Math.max(leftLines.length, rightLines.length);
		const rows: (LineRows | undefined)[] = [];
		const body: string[] = [];
		const side = theme.fg("dim", "│");
		for (let i = 0; i < height; i++) {
			const l = leftLines[i] ?? { text: "" };
			const r = rightLines[i] ?? { text: "" };
			body.push(`${side}${padTo(l.text, leftW)}${side}${padTo(r.text, rightW)}${side}`);
			rows.push({ left: l.row, right: r.row, split: leftW });
		}

		const title = this.menu === "think" ? "思考强度" : this.menu === "ctx" ? "上下文窗口" : "模型";
		const hint =
			this.menu !== null
				? "↑↓ 选 · Enter 应用 · ← 返回 · Esc 关闭"
				: this.pane === "detail"
					? "↑↓ 选 · → 子菜单 · ← 列表 · Esc 关闭"
					: "↑↓ 选 · → 详情 · Enter 应用 · Esc 关闭";
		const headerLeft = ` ${title} `;
		const room = inner - visibleWidth(headerLeft) - 2;
		const showHint = room > 12;
		const headerRight = showHint ? `${truncateToWidth(hint, room, "")} ` : "";
		const fill = Math.max(0, inner - visibleWidth(headerLeft) - visibleWidth(headerRight));
		const top =
			theme.fg("dim", "┌") + theme.fg("accent", headerLeft) + theme.fg("dim", "─".repeat(fill)) + theme.fg("muted", headerRight) + theme.fg("dim", "┐");
		const closeText = " ✕ 关闭 ";
		const fillW = Math.max(0, inner - visibleWidth(closeText) - 1);
		const bottom =
			theme.fg("dim", `└${"─".repeat(fillW)}`) +
			theme.bg("selectedBg", theme.fg("text", closeText)) +
			theme.fg("dim", "─┘");

		this.rows = [undefined, ...rows, { left: { kind: "close" }, right: { kind: "close" }, split: leftW }];
		return [top, ...body, bottom];
	}

	private renderList(leftW: number): Line[] {
		const theme = this.theme;
		const total = this.entries.length;
		const maxRows = Math.min(LIST_MAX_ROWS, total);
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + maxRows) this.offset = this.selected - maxRows + 1;

		const out: Line[] = [];
		for (let i = 0; i < maxRows; i++) {
			const index = this.offset + i;
			const entry = this.entries[index];
			if (!entry) {
				out.push({ text: "" });
				continue;
			}
			const isCurrent = entry.id === this.currentId;
			const isSelected = index === this.selected && this.pane === "list";
			const icon = iconFor(entry.id, entry.name);
			const tail = `${fmtCredit(entry.credit)}${isCurrent ? " ✓" : ""}`;
			const nameW = Math.max(8, leftW - 4 - visibleWidth(icon) - visibleWidth(tail));
			const name = truncateToWidth(entry.name, nameW, "…");
			const gap = Math.max(1, leftW - 1 - visibleWidth(icon) - visibleWidth(name) - visibleWidth(tail) - 1);
			const raw = ` ${icon} ${name}${" ".repeat(gap)}${tail}`;
			let styled = isCurrent ? theme.fg("accent", raw) : theme.fg("text", raw);
			if (isSelected) styled = theme.bg("selectedBg", styled);
			out.push({ text: styled, row: { kind: "model", index } });
		}
		if (total > maxRows) out.push({ text: theme.fg("dim", ` … ${this.selected + 1}/${total}`) });
		return out;
	}

	private renderDetail(rightW: number): Line[] {
		const theme = this.theme;
		const entry = this.current();
		if (!entry) return [{ text: "" }];

		if (this.menu !== null) {
			const values = this.menuValues();
			const active = this.menu === "think" ? this.levelFor(entry) : this.effectiveCtx(entry);
			const out: Line[] = [];
			for (let i = 0; i < values.length; i++) {
				const value = values[i];
				const label = typeof value === "string" ? (LEVEL_LABEL[value] ?? value) : fmtCtx(value);
				const isActive = value === active;
				const isSelected = i === this.menuIndex;
				const gap = Math.max(1, rightW - 5 - visibleWidth(label) - (isActive ? 2 : 0));
				let line = ` ${isActive ? theme.fg("success", "●") : theme.fg("dim", "○")} ${theme.fg("text", label)}${" ".repeat(gap)}${isActive ? theme.fg("success", "✓ ") : "  "}`;
				if (isSelected) line = theme.bg("selectedBg", line);
				out.push({ text: line, row: { kind: "option", action: this.menu, value } as Row });
			}
			return out;
		}

		const out: Line[] = [];
		const tag = tagFor(entry);
		const tagW = tag ? visibleWidth(tag.text) + 2 : 0;
		const titleText = truncateToWidth(entry.name, Math.max(6, rightW - 2 - tagW), "…");
		out.push({ text: ` ${theme.bold(theme.fg("text", titleText))}${tag ? " " + theme.fg(tag.tone, ` ${tag.text} `) : ""}` });
		for (const line of wrapText(entry.desc, rightW - 2)) out.push({ text: theme.fg("muted", ` ${line}`) });
		out.push({ text: theme.fg("dim", ` ${"─".repeat(Math.max(0, rightW - 2))}`) });

		const supportsThinking = entry.model.reasoning && entry.levels.some((l) => l !== "off");
		const levelLabel = supportsThinking ? (LEVEL_LABEL[this.levelFor(entry) ?? ""] ?? "—") : "不支持";
		const params: { label: string; value: string; action?: "think" | "ctx" }[] = [
			{ label: "消耗速度", value: entry.credit === null ? "浮动" : `${entry.credit.toFixed(2)}x 倍率` },
			{ label: "繁忙程度", value: busyText(this.busy) },
			{ label: "思考强度", value: levelLabel, action: supportsThinking ? "think" : undefined },
			{ label: "上下文窗口", value: fmtCtx(this.effectiveCtx(entry)), action: "ctx" },
		];
		const labelW = 11;
		const selAction = this.currentAction();
		for (const p of params) {
			const valueW = Math.max(4, rightW - 3 - labelW - (p.action ? 2 : 0));
			const value = truncateToWidth(p.value, valueW, "…");
			const right = " ".repeat(Math.max(0, valueW - visibleWidth(value))) + value;
			const sep = p.action ? theme.fg("muted", " ›") : "";
			const isSelected = this.pane === "detail" && p.action !== undefined && p.action === selAction;
			let line = ` ${theme.fg("muted", padTo(p.label, labelW))}${theme.fg("text", right)}${sep}`;
			if (isSelected) line = theme.bg("selectedBg", line);
			out.push({ text: line, row: p.action ? ({ kind: "action", action: p.action } as Row) : undefined });
		}
		return out;
	}

	/** 详情面板里可点的动作（无思考能力的模型没有「思考强度」项目）。 */
	private currentAction(): "think" | "ctx" | undefined {
		const entry = this.current();
		if (!entry) return undefined;
		const supportsThinking = entry.model.reasoning && entry.levels.some((l) => l !== "off");
		const actions: ("think" | "ctx")[] = supportsThinking ? ["think", "ctx"] : ["ctx"];
		return actions[this.detailIndex] ?? actions[0];
	}

	handleInput(data: string): void {
		const action = decodeKey(data);
		if (!action) return;
		if (action === "ctrlC" || action === "esc") {
			this.closeFn();
			return;
		}
		if (action === "enter") {
			if (this.menu !== null) {
				this.commitMenu();
				return;
			}
			if (this.pane === "list") {
				const entry = this.current();
				if (entry) this.applyFn(entry, this.levelFor(entry), this.effectiveCtx(entry), false);
				return;
			}
			this.openMenu(this.currentAction() ?? "ctx");
			this.requestRenderFn();
			return;
		}
		if (action === "space") {
			if (this.menu === null && this.pane === "detail") this.openMenu(this.currentAction() ?? "ctx");
			this.requestRenderFn();
			return;
		}
		// ← 逐层往外：子菜单 → 详情 → 列表；→ 逐层往里：列表 → 详情 → 子菜单
		if (action === "left") {
			if (this.menu !== null) {
				this.menu = null;
				this.pane = "detail";
			} else if (this.pane === "detail") {
				this.pane = "list";
			}
			this.requestRenderFn();
			return;
		}
		if (action === "right") {
			if (this.menu === null && this.pane === "list") {
				this.pane = "detail";
			} else if (this.menu === null && this.pane === "detail") {
				this.openMenu(this.currentAction() ?? "ctx");
			}
			this.requestRenderFn();
			return;
		}
		if (this.menu !== null) {
			const len = this.menuValues().length;
			if (action === "down") this.menuIndex = clamp(this.menuIndex + 1, len);
			if (action === "up") this.menuIndex = clamp(this.menuIndex - 1, len);
			this.requestRenderFn();
			return;
		}
		if (this.pane === "list") {
			if (action === "down" || action === "tab") this.selected = clamp(this.selected + 1, this.entries.length);
			if (action === "up") this.selected = clamp(this.selected - 1, this.entries.length);
			this.requestRenderFn();
			return;
		}
		if (action === "down" || action === "tab" || action === "up") this.detailIndex = (this.detailIndex + 1) % 2;
		this.requestRenderFn();
	}

	private commitMenu(): void {
		const entry = this.current();
		const value = this.menuValues()[this.menuIndex];
		if (!entry || value === undefined) return;
		if (this.menu === "think") {
			this.activeLevel = String(value);
			this.applyFn(entry, String(value), this.effectiveCtx(entry), false);
		} else {
			const state = loadState();
			state.ctx[entry.id] = Number(value);
			saveState(state);
			this.applyFn(entry, this.levelFor(entry), Number(value), false);
		}
		this.menu = null;
		this.pane = "detail";
		this.requestRenderFn();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			// 实测 Windows Terminal 的 wheelDelta 方向与本意相反：向下滚给正值，所以这里取反
			const up = (event.wheelDelta ?? 0) < 0;
			if (this.menu !== null) this.menuIndex = clamp(this.menuIndex + (up ? -1 : 1), this.menuValues().length);
			else if (this.pane === "detail") this.detailIndex = (this.detailIndex + 1) % 2;
			else this.selected = clamp(this.selected + (up ? -1 : 1), this.entries.length);
			this.requestRenderFn();
			return { handled: true, render: true };
		}
		if (event.type !== "click" && event.type !== "press") return undefined;
		const line = this.rows[event.y];
		if (!line) return undefined;
		// 边框占第 0 列，所以 x <= split 落在左栏（含左竖线），否则落在右栏
		const row = event.x <= line.split ? line.left : line.right;
		if (!row) return undefined;
		if (row.kind === "close") {
			this.closeFn();
			return { handled: true, render: true, focus: true };
		}
		if (row.kind === "model") {
			this.selected = row.index;
			this.pane = "list";
			this.menu = null;
			this.requestRenderFn();
			if (event.type === "click") {
				const entry = this.current();
				// 选中就切，但不关浮层：关不关由右下角的「✕ 关闭」或 Esc 决定
				if (entry) this.applyFn(entry, this.levelFor(entry), this.effectiveCtx(entry), false);
			}
			return { handled: true, render: true, focus: true };
		}
		if (row.kind === "action") {
			this.pane = "detail";
			this.detailIndex = row.action === "think" ? 0 : 1;
			this.openMenu(row.action);
			this.requestRenderFn();
			return { handled: true, render: true, focus: true };
		}
		if (row.kind === "option") {
			const idx = this.menuValues().findIndex((v) => v === row.value);
			if (idx >= 0) this.menuIndex = idx;
			if (event.type === "click") this.commitMenu();
			else this.requestRenderFn();
			return { handled: true, render: true, focus: true };
		}
		return undefined;
	}

	invalidate(): void {
		// 没有缓存，主题变更后重渲染即可
	}
}

export default function modelPickerExtension(pi: ExtensionAPI): void {
	async function openPicker(ctx: ExtensionContext): Promise<void> {
		const { meta, busy } = await fetchMeta(resolveGateway());
		const entries: Entry[] = ctx.modelRegistry.getAll().map((model) => {
			const m = meta.get(model.id);
			const nameField = String((model as any).name ?? model.id);
			const shortName = nameField.split(" · ")[0];
			return {
				model,
				id: model.id,
				name: shortName,
				credit: m?.credit ?? parseCredit(nameField.match(/x\d+(?:\.\d+)?/)?.[0]),
				desc: m?.desc ?? "",
				supportsImages: m?.supportsImages ?? false,
				onlyReasoning: m?.onlyReasoning ?? false,
				maxCtx: Number(model.contextWindow ?? 0),
				levels: levelsFor(model),
			};
		});
		if (entries.length === 0) {
			ctx.ui.notify("没有可用模型", "error");
			return;
		}

		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				let picker: Picker | undefined;
				const apply = async (entry: Entry, level: string | undefined, ctxWindow: number, close: boolean) => {
					const base = ctx.modelRegistry.find(entry.model.provider, entry.id) ?? entry.model;
					const baseWindow = Number(base.contextWindow ?? 0);
					const needModel = ctx.model?.id !== entry.id || (ctxWindow > 0 && ctxWindow !== baseWindow);
					if (needModel) {
						const target = ctxWindow > 0 && ctxWindow !== baseWindow ? { ...base, contextWindow: ctxWindow } : base;
						const ok = await pi.setModel(target as Model<any>);
						if (!ok) {
							ctx.ui.notify(`切换失败：${entry.id}`, "error");
							return;
						}
					}
					if (level && entry.levels.includes(level)) pi.setThinkingLevel(level as any);
					picker?.markApplied(entry.id);
					const state = loadState();
					state.ctx[entry.id] = ctxWindow || baseWindow;
					saveState(state);
					if (close) done();
				};
				picker = new Picker({
					entries,
					busy,
					currentId: ctx.model?.id ?? "",
					theme,
					activeLevel: pi.getThinkingLevel(),
					onApply: (entry, level, ctxWindow, close) => {
						void apply(entry, level, ctxWindow, close);
					},
					onClose: () => done(),
					requestRender: () => tui.requestRender(),
				});
				return picker;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "88%",
					minWidth: 60,
					maxHeight: "85%",
					margin: 2,
				},
			},
		);
	}

	pi.registerCommand("pick", {
		description: "模型 / 思考强度 / 上下文窗口选择器（可点击）",
		handler: async (_args, ctx) => {
			await openPicker(ctx);
		},
	});

	pi.registerShortcut(Key.alt("m"), {
		description: "打开模型选择器",
		handler: async (ctx) => {
			await openPicker(ctx);
		},
	});

	// pi 启动时只认 models.json 的原值，把上次选的窗口贴回去。
	pi.on("session_start", async (_event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const override = loadState().ctx[model.id];
		if (!override || override === Number(model.contextWindow ?? 0)) return;
		await pi.setModel({ ...model, contextWindow: override } as Model<any>);
	});
}
