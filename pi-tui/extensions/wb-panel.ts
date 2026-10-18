/**
 * wb-panel — WorkBuddy2API 控制台（`/panel`）的 JSON API 客户端与纯函数。
 *
 * 为什么不用网页抓取：`/panel` 是服务端渲染的 HTML，但它自己页面里的 `app.js`
 * 走的是一层正经 JSON API（`fetch('/panel/api/' + path)` + `Authorization: Bearer`），
 * 所以这里直接打那层，字段稳定、不需要解析 DOM。
 *
 * 两个端点：
 * - `GET /panel/api/overview`      → `accounts[]`：`credits` / `credits_total` / 最早到期批次
 * - `GET /panel/api/request_logs?from=<unix>&limit=N` → `entries[]`：逐条 `credit`
 *   与 `user_agent`（pi 的请求以 `pi` 开头，同一账号里还有 codex / claude 的消耗）
 *
 * 判定「这是不是 WorkBuddy 网关」的方式是**探测**：`overview` 能答出 `accounts`
 * 才算；404/401 就是别人的网关，调用方回落到 `$` 费用（见 `open-tui/footer.ts`）。
 * 纯函数（`aggregateAccounts` / `parseCreditRows` / `shouldShowExpiry` / `formatCredits`）
 * 单独导出，测试见 `pi-tui/test/wb-panel.test.ts`。
 */

import { gatewayRoot, type GatewayConfig } from "./wb-gateway.ts";

export interface PanelGateway {
	/** `http://host:port`（已去掉 `/v1`） */
	root: string;
	apiKey: string;
}

/** `/v1` 后面挂的那层面板，路径固定为 `/panel/api`。 */
export function panelBase(root: string): string {
	return `${gatewayRoot(root)}/panel/api`;
}

export function toPanelGateway(gw: Pick<GatewayConfig, "root" | "apiKey">): PanelGateway | undefined {
	if (!gw.root) return undefined;
	return { root: gatewayRoot(gw.root), apiKey: gw.apiKey };
}

export interface Balance {
	/** 可用积分（健康且未禁用账号求和） */
	remaining: number;
	/** 总额度（同上） */
	total: number;
	/** 最早一批积分的过期时刻（毫秒），无则 undefined */
	expiryAt?: number;
	/** 最早一批还剩多少积分 */
	expiryRemaining?: number;
	/** 这次拿到数据的时刻（毫秒） */
	at: number;
}

/**
 * footer / telemetry 的「费用」渲染口径，由 wb-stats 通过 `wb2:cost` 事件下发。
 *
 * - `usd`：普通 apikey 网关，沿用 pi 自己算的钱（`$0.123`）
 * - `credits`：WorkBuddy 控制台网关，显示积分余额（`⚡4568/7250`）
 */
export interface CostView {
	mode: "usd" | "credits";
	/** 只有 credits 模式才有：最近一次成功的余额 */
	credits?: Balance;
	/** 取不到最新余额（网关抖动）：保留旧值但标灰加 `!!` */
	stale?: boolean;
	/** 当前模型的倍率（`/v1/models` 的 `x0.51` → 0.51），telemetry 段用它代替 $/M */
	multiplier?: number | null;
}

export type BalanceResult =
	| { kind: "ok"; balance: Balance }
	/** 对方不是 WorkBuddy 网关（或无此端点）：应回落到 `$` 费用 */
	| { kind: "not-panel"; status: number }
	/** 曾经是、这次取不到：保留上次数值并标记陈旧 */
	| { kind: "error"; status: number };

export interface CreditRow {
	id: string;
	t: number;
	credit: number;
}

function num(value: unknown): number | null {
	// 网关的 JSON 里可能写 `null` 或空串；`Number(null)` 是 0，会让「没有这个字段」
	// 静默变成「这个字段是 0 积分」，所以必须显式挡掉。
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

/** `2026-10-31T23:59:59+08:00` → 毫秒；解析不出来就 undefined。 */
export function parsePanelTime(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	if (/^0001-01-01/.test(value)) return undefined;
	const t = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isFinite(t) ? t : undefined;
}

/**
 * 多账号聚合：网关会在账号之间调度，用户实际可用的是**池子总和**。
 * 禁用（`disabled`）与不健康（顶层 `healthy === false`）的账号不计入，
 * 否则余额会凭空多出一截取不出来的额度。
 */
export function aggregateAccounts(doc: unknown, now = Date.now()): Balance | null {
	const root = doc as { accounts?: unknown } | null;
	const list = Array.isArray(root?.accounts) ? root!.accounts : undefined;
	if (!list) return null;
	let remaining = 0;
	let total = 0;
	let expiryAt: number | undefined;
	let expiryRemaining: number | undefined;
	let counted = 0;
	for (const raw of list) {
		const acc = raw as Record<string, unknown> | null;
		if (!acc || typeof acc !== "object") continue;
		if (acc.disabled === true || acc.healthy === false) continue;
		const credits = num(acc.credits);
		if (credits === null) continue;
		const cap = num(acc.credits_total) ?? 0;
		const at = parsePanelTime(acc.credits_earliest_expiry);
		const left = num(acc.credits_earliest_remaining);
		remaining += credits;
		total += cap;
		counted += 1;
		if (at !== undefined && (expiryAt === undefined || at < expiryAt)) {
			expiryAt = at;
			expiryRemaining = left ?? undefined;
		}
	}
	if (counted === 0) return null;
	return { remaining, total, expiryAt, expiryRemaining, at: now };
}

/** 只认 pi 自己发出去的请求（`user_agent` 形如 `pi (win32 10.0.26300; x64)`）。 */
export function isPiRequest(entry: Record<string, unknown>): boolean {
	return String(entry.user_agent ?? "").startsWith("pi");
}

/**
 * 解析请求日志。`request_id` 缺失时用时间 + 模型 + token 拼一个稳定 id，
 * 保证同一个请求不会因为重复拉取而重复计费。
 */
export function parseCreditRows(doc: unknown): CreditRow[] {
	const root = doc as { entries?: unknown } | null;
	const list = Array.isArray(root?.entries) ? root!.entries : [];
	const rows: CreditRow[] = [];
	for (const raw of list) {
		const entry = raw as Record<string, unknown> | null;
		if (!entry || typeof entry !== "object" || !isPiRequest(entry)) continue;
		const credit = num(entry.credit);
		const t = parsePanelTime(entry.time);
		if (credit === null || t === undefined) continue;
		const id =
			typeof entry.request_id === "string" && entry.request_id
				? entry.request_id
				: `${t}:${String(entry.model ?? "")}:${String(entry.total_tokens ?? "")}`;
		rows.push({ id, t, credit });
	}
	return rows;
}

export const EXPIRY_WARN_MS = 3 * 24 * 60 * 60 * 1000;
/** 快到期的这一批至少占总额的 5% 才值得提醒 */
export const EXPIRY_WARN_SHARE = 0.05;

/**
 * 到期提醒只在「真会被浪费」时出现，两个门槛**同时**满足：
 * 1. 这批积分 3 天内到期；
 * 2. 这批占总额 ≥ 5%。
 *
 * 只用第 1 条会天天响（真实数据里最早批次是 28/7250，一直在小到期日上）；
 * 只用第 2 条会在还有一个月时就占位。所以「量小」或者「还早」都不打扰。
 */
export function shouldShowExpiry(
	expiryRemaining: number | undefined,
	total: number,
	expiryAt: number | undefined,
	now = Date.now(),
): boolean {
	if (expiryAt === undefined || expiryAt <= now) return false;
	const left = expiryRemaining ?? 0;
	if (left <= 0) return false;
	if (expiryAt - now > EXPIRY_WARN_MS) return false;
	return total <= 0 || left / total >= EXPIRY_WARN_SHARE;
}

/**
 * 积分不显示小数点后的噪声，但**余额要精确到个位**（用户会拿它对账）：
 * 4568 → `4568`，12.34 → `12.3`，12.5万 → `125k`，125万 → `1.3M`。
 */
export function formatCredits(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 10) return n.toFixed(1).replace(/\.0$/, "");
	if (n < 100_000) return String(Math.round(n));
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `⏳28@10-31` 用的日期形状（本地时区，够短）。 */
export function shortExpiry(at: number): string {
	const d = new Date(at);
	return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`;
}

async function getJson(url: string, apiKey: string, timeoutMs: number): Promise<{ status: number; doc?: unknown }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
		const res = await fetch(url, { headers, signal: ctrl.signal });
		if (!res.ok) return { status: res.status };
		const doc = await res.json().catch(() => undefined);
		return { status: res.status, doc };
	} catch {
		return { status: 0 };
	} finally {
		clearTimeout(timer);
	}
}

/** 余额：一次 `overview`。`status 0` = 连不上（保留上次值）。 */
export async function fetchBalance(gw: PanelGateway, timeoutMs = 2500, now = Date.now()): Promise<BalanceResult> {
	const { status, doc } = await getJson(`${panelBase(gw.root)}/overview`, gw.apiKey, timeoutMs);
	if (status === 0) return { kind: "error", status };
	if (status === 404 || status === 401 || status === 403) return { kind: "not-panel", status };
	if (status < 200 || status >= 300) return { kind: "error", status };
	const balance = aggregateAccounts(doc, now);
	if (!balance) return { kind: "not-panel", status };
	return { kind: "ok", balance };
}

/** 逐条积分：`from` 交给服务端按时间过滤，避免「最近 N 条」里没有早期记录。 */
export async function fetchPiCredits(
	gw: PanelGateway,
	fromMs: number,
	limit = 2000,
	timeoutMs = 2500,
): Promise<CreditRow[] | null> {
	const fromSec = Math.max(0, Math.floor(fromMs / 1000));
	const url = `${panelBase(gw.root)}/request_logs?from=${fromSec}&limit=${Math.max(1, limit)}`;
	const { status, doc } = await getJson(url, gw.apiKey, timeoutMs);
	if (status < 200 || status >= 300) return null;
	return parseCreditRows(doc);
}

/**
 * 会话积分计：**单调累加**。
 *
 * 网关的请求日志是滑动窗口，按「当前日志里有什么」重算会让早期消耗悄悄消失
 * （数字越用越小）。这里以 `request_id` 为键累加，滚出窗口的行照样留在账上；
 * 重复拉取同一段也不会重复计数。
 */
export class PanelMeter {
	private rows = new Map<string, CreditRow>();
	private lastOk = 0;

	constructor(
		private gw: PanelGateway | undefined,
		private readonly limit = 2000,
	) {}

	get available(): boolean {
		return Boolean(this.gw?.root);
	}

	get lastOkAt(): number {
		return this.lastOk;
	}

	reset(): void {
		this.rows.clear();
		this.lastOk = 0;
	}

	/** 拉一次日志；返回 false 表示这次没拿到（保留已计的数）。 */
	async refresh(fromMs: number): Promise<boolean> {
		const gw = this.gw;
		if (!gw) return false;
		const rows = await fetchPiCredits(gw, fromMs, this.limit);
		if (!rows) return false;
		for (const row of rows) {
			if (row.t >= fromMs) this.rows.set(row.id, row);
		}
		this.lastOk = Date.now();
		this.trim();
		return true;
	}

	/** 从某个时刻起的累计积分（`turn` 与 `session` 都用这个口径）。 */
	since(tsMs: number): number {
		let sum = 0;
		for (const row of this.rows.values()) if (row.t >= tsMs) sum += row.credit;
		return sum;
	}

	/** 防御长时间会话：只留最近 `limit` 条（顺序即插入顺序）。 */
	private trim(): void {
		const overflow = this.rows.size - this.limit;
		if (overflow <= 0) return;
		let drop = overflow;
		for (const id of this.rows.keys()) {
			if (drop-- <= 0) break;
			this.rows.delete(id);
		}
	}
}
