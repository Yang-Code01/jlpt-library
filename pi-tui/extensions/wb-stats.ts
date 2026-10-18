/**
 * wb-stats — 把网关的真实数据变成一条扩展状态行（`ctx.ui.setStatus`）。
 *
 * 为什么不再自己 setFooter：footer 只能有一个，pi-open-tui 已经装了一个，
 * 后装的会把前面的顶掉（这就是之前「统计 footer 消失」的真因）。扩展状态行
 * 是 pi 提供的**可叠加**通道，pi-open-tui 会把它渲在 footer 下面一行。
 *
 * 数据源（见 wb-panel.ts / wb-gateway.ts，全部可缺）：
 * - 余额：WorkBuddy2API 控制台的 `/panel/api/overview`，15s 轮询
 * - 积分消耗：`/panel/api/request_logs`，只算 pi 自己的调用（`user_agent` 前缀 pi）
 * - 倍率：`/v1/models` 的 `credits`（`x0.51`），随 `wb2:cost` 事件交给 footer
 * - tok/s：pi 自己计时（首个 delta → 最后一个 delta），不依赖上游
 * - 上游：`/status` 的 healthy/total/cooling/in_flight，15s 轮询；**只用来取倍率，繁忙度不渲染**
 *   （`上游 1/1 ·1忙` 那段用户 2026-10 要求删除，`st.busy` 保留备用）
 *
 * 是不是 WorkBuddy 网关靠**探测**：`overview` 能答出 `accounts` 才算积分模式，
 * 否则 footer 继续用 `$`（普通 apikey 中转零改动）。取不到时保留上次余额并标记
 * 陈旧，网关恢复自动复原 —— 不把用户手里的数字换成 `—`。
 *
 * 与 open-tui 的通道是 pi 的事件总线：这里 `pi.events.emit("wb2:cost", view)`，
 * open-tui 订阅后写进 footer 状态。不用 globalThis，也不解析 setStatus 的字符串。
 *
 * 命令 `/wb2stats` 开关；会话开始默认开启。定时器一律 unref，
 * 否则 pi 退出时进程会被钉住（之前踩过：180s 不退出）。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchMeta, resolveGateway, short, type Busy, type GatewayConfig, type GatewayMeta } from "./wb-gateway.ts";
import { PanelMeter, fetchBalance, toPanelGateway, type Balance, type CostView, type PanelGateway } from "./wb-panel.ts";

const STATUS_KEY = "wb2api";
const STATUS_POLL_MS = 15_000;
const TICK_MS = 1_000;

const st = {
	sessionStart: Date.now(),
	sessionCredit: 0,
	runCredit: 0,
	/** 上次见到的会话累计，用来把日志晚到的行也单调补进来（见 refreshCredits） */
	lastSessionCredit: 0,
	tps: 0,
	busy: null as Busy | null,
	busyAt: 0,
	meta: new Map<string, GatewayMeta>(),
	/** 探测结果：true = 当前 provider 是 WorkBuddy 控制台网关 */
	isPanel: false,
	balance: undefined as Balance | undefined,
	balanceStale: false,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, dirty: true },
	stream: { start: 0, first: 0, last: 0 },
};

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let panel: PanelGateway | undefined;
	let meter: PanelMeter | undefined;
	let gw: GatewayConfig = { provider: "", root: "", apiKey: "", logDir: "" };
	let activeCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	let lastText = "";
	let lastView = "";

	const costView = (): CostView => {
		if (!st.isPanel) return { mode: "usd" };
		return {
			mode: "credits",
			credits: st.balance,
			stale: st.balanceStale,
			multiplier: st.meta.get(String(activeCtx?.model?.id ?? ""))?.credit ?? null,
		};
	};

	const publish = () => {
		const ctx = activeCtx;
		if (!ctx || !enabled) return;
		// 会话被替换 / 退出后，抓在手里的 ctx 会变 stale 并抛错（pi 的 assertActive）。
		// 这里只读统计，吞掉即可；否则 pi 退出时会被一个 uncaught 打断。
		try {
			refreshTotals(ctx);
			// 先发费用视图：footer 的余额段与这一行是两处渲染，靠这条事件同步
			const view = costView();
			const marshalled = JSON.stringify(view);
			if (marshalled !== lastView) {
				lastView = marshalled;
				pi.events.emit("wb2:cost", view);
			}
			const u = st.usage;
			const parts: string[] = [];
			if (u.input || u.output) parts.push(`↑${short(u.input)} ↓${short(u.output)}`);
			const m = meter;
			const credits = st.isPanel && m?.available;
			if (credits) {
				const flag = st.balanceStale || (m !== undefined && m.lastOkAt === 0) ? "!!" : "";
				parts.push(`积分 ${st.runCredit.toFixed(2)}/${st.sessionCredit.toFixed(2)}${flag}`);
			}
			// ctx 不再重复：footer 右上角已经有进度条 + 百分比 + 窗口（用户 2026-10 反馈这行太挤）
			// 上游繁忙度（`上游 1/1 ·1忙 ·1冷`）用户 2026-10 要求删除；/status 仍轮询，只为拿倍率 st.meta
			if (st.tps > 0) parts.push(`${st.tps.toFixed(0)} tok/s`);
			if (u.cacheRead || u.cacheWrite) {
				const totalIn = u.input + u.cacheRead;
				const ch = totalIn > 0 ? Math.round((u.cacheRead / totalIn) * 100) : 0;
				parts.push(`R${short(u.cacheRead)} W${short(u.cacheWrite)} 缓存命中${ch}%`);
			}
			const text = parts.join(" · ");
			if (text === lastText) return;
			lastText = text;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			enabled = false;
		}
	};

	/**
	 * 余额：一次 `overview`。
	 * - 200 且有 `accounts` → 积分模式，换成新数值
	 * - 404/401 → 不是控制台网关（普通中转），回落到 `$`
	 * - 连不上 → 曾经探明是面板就保留旧值标陈旧，否则继续按 `$` 渲染等下次探测
	 */
	const refreshBalance = async () => {
		const p = panel;
		if (!p) return;
		const res = await fetchBalance(p);
		if (res.kind === "ok") {
			st.isPanel = true;
			st.balance = res.balance;
			st.balanceStale = false;
		} else if (res.kind === "not-panel") {
			st.isPanel = false;
			st.balance = undefined;
			st.balanceStale = false;
		} else if (st.isPanel) {
			st.balanceStale = true;
		}
		publish();
	};

	/**
	 * 积分计量：会话数=单调累计；本轮=**增量累加**。
	 *
	 * 为什么不用 `since(runStart)` 重算本轮：网关日志落账比响应慢（可达数秒），
	 * 而 pi 的 `turn_start` 是「一次 assistant 响应」，工具循环里一轮用户请求会连发多次，
	 * 于是 `since(turnStart)` 会把上一段响应里还没落账的积分**直接甩掉**（用户 2026-10 报：x 一次次
	 * 更新、中间状态丢失、收尾数字偏小）。改成「会话累计的增量累加」后：
	 * - 晚到的行只增不减，不会被下一次刷新吃掉；
	 * - 本轮只在新的 `agent_start`（用户又发了一条）时归零。
	 */
	const refreshCredits = () => {
		const m = meter;
		if (!m?.available || !st.isPanel) return;
		void m.refresh(st.sessionStart).then((ok) => {
			if (!ok) return;
			const sessionCredit = m.since(st.sessionStart);
			const delta = sessionCredit - st.lastSessionCredit;
			// delta < 0：换模型后 meter 重建 / 日志被清，忽略即可，不回退已计的数
			if (delta > 0) st.runCredit += delta;
			st.lastSessionCredit = sessionCredit;
			st.sessionCredit = sessionCredit;
			publish();
		});
	};

	const refreshBusy = async () => {
		if (!gw.root) return;
		const { meta, busy } = await fetchMeta(gw);
		if (meta.size) st.meta = meta;
		st.busy = busy;
		st.busyAt = Date.now();
		publish();
	};

	const resolve = () => {
		gw = resolveGateway(activeCtx?.model?.provider);
		panel = toPanelGateway(gw);
		meter = new PanelMeter(panel);
		lastView = "";
		st.meta = new Map();
		st.isPanel = false;
		st.balance = undefined;
		st.balanceStale = false;
	};

	const install = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		resolve();
		enabled = true;
		lastText = "";
		// unref：定时器不能把 pi 的进程钉住（退出时事件循环要能自然清空）
		ticker ??= setInterval(publish, TICK_MS).unref?.();
		poller ??= setInterval(() => {
			void refreshBusy();
			void refreshBalance();
		}, STATUS_POLL_MS).unref?.();
		void refreshBusy();
		void refreshBalance().then(refreshCredits);
		publish();
	};

	const uninstall = (ctx: ExtensionContext) => {
		enabled = false;
		lastText = "";
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (ticker) clearInterval(ticker);
		if (poller) clearInterval(poller);
		ticker = poller = undefined;
	};

	pi.registerCommand("wb2stats", {
		description: "开关网关统计状态行（积分 / tok/s / 上游繁忙度）",
		handler: async (_args, ctx) => {
			if (enabled) {
				uninstall(ctx);
				ctx.ui.notify("网关统计已关闭", "info");
			} else {
				install(ctx);
				ctx.ui.notify("网关统计已开启", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		st.sessionStart = Date.now() - 1500;
		st.runCredit = 0;
		st.lastSessionCredit = 0;
		st.usage.dirty = true;
		st.busy = null;
		install(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			uninstall(ctx);
		} catch {}
	});

	pi.on("model_select", async (_event, ctx) => {
		// 换模型 / 换 provider 后重解析网关（别的 provider 可能没有 /panel）
		activeCtx = ctx;
		resolve();
		lastText = "";
		void refreshBusy();
		void refreshBalance().then(refreshCredits);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		st.stream = { start: Date.now(), first: 0, last: 0 };
	});

	pi.on("message_update", async () => {
		const now = Date.now();
		if (!st.stream.first) st.stream.first = now;
		st.stream.last = now;
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		st.usage.dirty = true;
		const out = event.message.usage?.output ?? 0;
		const from = st.stream.first || st.stream.start;
		const span = (st.stream.last || Date.now()) - from;
		if (out > 0 && span > 250) st.tps = (out * 1000) / span;
		// 网关落账紧跟响应结束，稍等再读一次
		setTimeout(refreshCredits, 600).unref?.();
	});

	// 本轮开算：只认「用户又发了一条」，不认 pi 的 turn_start（那是单次 assistant 响应）
	pi.on("agent_start", async () => {
		st.runCredit = 0;
		publish();
	});

	pi.on("turn_end", async () => refreshCredits());
	pi.on("agent_settled", async () => {
		// 网关落账有延迟：收尾后再补两次，让「本轮」定格在真实总和而不是最早的半截数
		refreshCredits();
		setTimeout(refreshCredits, 800).unref?.();
		setTimeout(refreshCredits, 3000).unref?.();
		void refreshBusy();
		void refreshBalance();
	});

	function refreshTotals(ctx: ExtensionContext): void {
		if (!st.usage.dirty) return;
		const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, dirty: false };
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				u.input += m.usage?.input ?? 0;
				u.output += m.usage?.output ?? 0;
				u.cacheRead += m.usage?.cacheRead ?? 0;
				u.cacheWrite += m.usage?.cacheWrite ?? 0;
			}
		}
		st.usage = u;
	}
}
