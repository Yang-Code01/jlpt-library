/**
 * wb-stats — 把网关的真实数据变成一条扩展状态行（`ctx.ui.setStatus`）。
 *
 * 为什么不再自己 setFooter：footer 只能有一个，pi-open-tui 已经装了一个，
 * 后装的会把前面的顶掉（这就是之前「统计 footer 消失」的真因）。扩展状态行
 * 是 pi 提供的**可叠加**通道，pi-open-tui 会把它渲在 footer 下面一行。
 *
 * 三段数据全部可缺（见 wb-gateway.ts）：
 * - 积分：网关请求日志，只算 pi 自己的调用；读不到日志目录就没有这一段
 * - tok/s：pi 自己计时（首个 delta → 最后一个 delta），不依赖上游
 * - 上游：`/status` 的 healthy/total/cooling/in_flight，15s 轮询
 *
 * 命令 `/wb2stats` 开关；会话开始默认开启。定时器一律 unref，
 * 否则 pi 退出时进程会被钉住（之前踩过：180s 不退出）。
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CreditMeter, fetchMeta, resolveGateway, short, type Busy, type GatewayConfig } from "./wb-gateway.ts";

const STATUS_KEY = "wb2api";
const STATUS_POLL_MS = 15_000;
const TICK_MS = 1_000;

const st = {
	sessionStart: Date.now(),
	turnStart: Date.now(),
	sessionCredit: 0,
	turnCredit: 0,
	tps: 0,
	busy: null as Busy | null,
	busyAt: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, dirty: true },
	stream: { start: 0, first: 0, last: 0 },
};

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let meter: CreditMeter | undefined;
	let gw: GatewayConfig = { provider: "", root: "", apiKey: "", logDir: "" };
	let activeCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	let lastText = "";

	const publish = () => {
		const ctx = activeCtx;
		if (!ctx || !enabled) return;
		// 会话被替换 / 退出后，抓在手里的 ctx 会变 stale 并抛错（pi 的 assertActive）。
		// 这里只读统计，吞掉即可；否则 pi 退出时会被一个 uncaught 打断。
		try {
			refreshTotals(ctx);
			const u = st.usage;
			const parts: string[] = [];
			if (u.input || u.output) parts.push(`↑${short(u.input)} ↓${short(u.output)}`);
			const credits = meter?.available;
			if (credits) parts.push(`积分 ${st.turnCredit.toFixed(2)}/${st.sessionCredit.toFixed(2)}`);
			const cu = ctx.getContextUsage?.();
			if (cu) parts.push(`ctx ${Math.round(cu.percent)}%/${short(cu.contextWindow)}`);
			if (st.busy) {
				const b = st.busy;
				const flag = b.cooling >= b.total || b.saturated ? "!" : "";
				parts.push(`上游 ${b.healthy}/${b.total}${flag}${b.inFlight ? ` ·${b.inFlight}忙` : ""}${b.cooling ? ` ·${b.cooling}冷` : ""}`);
			}
			if (st.tps > 0) parts.push(`${st.tps.toFixed(0)} tok/s`);
			if (u.cacheRead || u.cacheWrite) {
				const totalIn = u.input + u.cacheRead;
				const ch = totalIn > 0 ? Math.round((u.cacheRead / totalIn) * 100) : 0;
				parts.push(`R${short(u.cacheRead)} W${short(u.cacheWrite)} CH${ch}%`);
			}
			const text = parts.join(" · ");
			if (text === lastText) return;
			lastText = text;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			enabled = false;
		}
	};

	const refreshCredits = () => {
		if (!meter) return;
		void meter.refresh().then(() => {
			if (!meter) return;
			st.sessionCredit = meter.since(st.sessionStart);
			st.turnCredit = meter.since(st.turnStart);
			publish();
		});
	};

	const refreshBusy = async () => {
		if (!gw.root) return;
		const { busy } = await fetchMeta(gw);
		st.busy = busy;
		st.busyAt = Date.now();
		publish();
	};

	const install = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		gw = resolveGateway(ctx.model?.provider);
		meter = new CreditMeter(gw.logDir);
		enabled = true;
		lastText = "";
		// unref：定时器不能把 pi 的进程钉住（退出时事件循环要能自然清空）
		ticker ??= setInterval(publish, TICK_MS).unref?.();
		poller ??= setInterval(() => void refreshBusy(), STATUS_POLL_MS).unref?.();
		void refreshBusy();
		refreshCredits();
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
		st.turnStart = Date.now();
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
		// 换模型 / 换 provider 后重解析网关（别的 provider 可能没有 /status）
		activeCtx = ctx;
		gw = resolveGateway(ctx.model?.provider);
		meter = new CreditMeter(gw.logDir);
		lastText = "";
		void refreshBusy();
		refreshCredits();
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
		// 日志落盘通常紧跟响应结束，稍等再读一次
		setTimeout(refreshCredits, 600).unref?.();
	});

	pi.on("turn_start", async () => {
		st.turnStart = Date.now();
		st.turnCredit = 0;
	});

	pi.on("turn_end", async () => refreshCredits());
	pi.on("agent_settled", async () => {
		refreshCredits();
		void refreshBusy();
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
