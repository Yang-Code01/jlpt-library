/**
 * wb-gateway — 网关能力的唯一入口（选择器、统计、以后的新扩展都从这里拿数据）。
 *
 * 三层数据，全部可缺：
 * - `GET /v1/models`  每模型的 credits / 中文说明 / 是否多模态 / 是否仅思考
 * - `GET /status`     上游账号的 healthy / total / cooling / in_flight
 * - 请求日志 jsonl    真正的积分消耗（pi 拿不到 `usage.credit`，pi-ai 的
 *                     parseChunkUsage 只挑标准字段，所以只能读网关自己落的日志）
 *
 * 可移植性靠「配置 + 探测 + 降级」：
 * - provider / 地址 / key 从 `~/.pi/agent/models.json` 读，不写死 wb2api；
 * - 日志目录从配置或环境变量读，读不到就没有积分段（其余照常）；
 * - 网关不认这些端点就返回 null，调用方自己决定隐藏哪一段。
 *
 * 配置：`~/.pi/agent/pi-tui-plus.json`
 *   { "gateway": { "provider": "wb2api", "logDir": "F:\\docker\\workbuddy2api\\data\\request-logs" } }
 * 环境变量优先级更高：WB2API_PROVIDER / WB2API_LOG_DIR / WB2API_BASE_URL
 */

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const CONFIG_FILE = path.join(AGENT_DIR, "pi-tui-plus.json");
export const STATE_FILE = path.join(AGENT_DIR, "pi-tui-plus-state.json");
const MODELS_JSON = path.join(AGENT_DIR, "models.json");

export interface GatewayConfig {
	provider: string;
	root: string;
	apiKey: string;
	logDir: string;
}

export interface GatewayMeta {
	credit: number | null;
	desc: string;
	supportsImages: boolean;
	onlyReasoning: boolean;
	maxCtx: number;
}

export interface Busy {
	healthy: number;
	total: number;
	cooling: number;
	inFlight: number;
	saturated: boolean;
}

export interface PlusConfig {
	gateway?: { provider?: string; baseUrl?: string; logDir?: string };
	[key: string]: unknown;
}

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

export function loadConfig(): PlusConfig {
	const doc = readJson(CONFIG_FILE);
	return doc && typeof doc === "object" ? (doc as PlusConfig) : {};
}

/** `http://host:port/v1` → `http://host:port`（网关的非 /v1 端点挂在根上）。 */
export function gatewayRoot(baseUrl: string): string {
	return String(baseUrl ?? "").replace(/\/v1\/?$/, "");
}

/**
 * 解析当前网关。provider 缺省时取 models.json 里第一个带 baseUrl 的 provider，
 * 这样换一个网关（one-api / new-api / 官方）也能用，不必改代码。
 */
export function resolveGateway(providerHint?: string): GatewayConfig {
	const config = loadConfig();
	const models = readJson(MODELS_JSON) ?? {};
	const providers: Record<string, any> = models?.providers ?? {};
	const names = Object.keys(providers);
	const preferred = [
		providerHint,
		process.env.WB2API_PROVIDER,
		config.gateway?.provider,
		names.find((n) => providers[n]?.baseUrl),
	].filter((n): n is string => Boolean(n));
	const provider = preferred.find((n) => providers[n]) ?? names[0] ?? "";
	const p = providers[provider] ?? {};
	const baseUrl = process.env.WB2API_BASE_URL || config.gateway?.baseUrl || String(p.baseUrl ?? "");
	return {
		provider,
		root: gatewayRoot(baseUrl),
		apiKey: String(p.apiKey ?? (p.apiKeyEnv ? process.env[p.apiKeyEnv] : "") ?? ""),
		logDir: process.env.WB2API_LOG_DIR || String(config.gateway?.logDir ?? ""),
	};
}

/** 网关的 credits 字段有三种写法：`x0.43`、`0.71 credits`、null。 */
export function parseCredit(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
	const m = String(raw).match(/-?\d+(\.\d+)?/);
	return m ? Number(m[0]) : null;
}

export async function fetchMeta(gw: GatewayConfig, timeoutMs = 1500): Promise<{ meta: Map<string, GatewayMeta>; busy: Busy | null }> {
	const meta = new Map<string, GatewayMeta>();
	let busy: Busy | null = null;
	if (!gw.root) return { meta, busy };
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	const headers = gw.apiKey ? { Authorization: `Bearer ${gw.apiKey}` } : undefined;
	try {
		const [modelsRes, statusRes] = await Promise.all([
			fetch(`${gw.root}/v1/models`, { headers, signal: ctrl.signal }).catch(() => undefined),
			fetch(`${gw.root}/status`, { headers, signal: ctrl.signal }).catch(() => undefined),
		]);
		if (modelsRes?.ok) {
			const doc: any = await modelsRes.json().catch(() => undefined);
			const list: any[] = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc) ? doc : [];
			for (const m of list) {
				if (!m?.id) continue;
				meta.set(String(m.id), {
					credit: parseCredit(m.credits),
					desc: String(m.description ?? "").replace(/^\[[^\]]*\]\s*/, ""),
					supportsImages: Boolean(m.supports_images),
					onlyReasoning: Boolean(m.only_reasoning),
					maxCtx: Number(m.context_length) || 0,
				});
			}
		}
		if (statusRes?.ok) {
			const doc: any = await statusRes.json().catch(() => undefined);
			const accounts: any[] = Array.isArray(doc?.accounts) ? doc.accounts : Object.values(doc?.accounts ?? {});
			busy = {
				healthy: Number(doc?.healthy) || 0,
				total: Number(doc?.total) || accounts.length,
				cooling: Number(doc?.cooling) || 0,
				inFlight: accounts.reduce((n: number, a: any) => n + (Number(a?.in_flight) || 0), 0),
				saturated: Boolean(doc?.in_flight_full),
			};
		}
	} finally {
		clearTimeout(timer);
	}
	return { meta, busy };
}

/**
 * 日志时间形如 `2026-10-18T04:00:00.366000585+08:00`（9 位纳秒），JS 只认到毫秒。
 */
export function parseTime(s: unknown): number {
	if (typeof s !== "string") return 0;
	const t = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isFinite(t) ? t : 0;
}

export function short(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function shortPath(p: string): string {
	const home = os.homedir();
	const s = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	const parts = s.split(/[\\/]/).filter(Boolean);
	if (parts.length <= 3) return s;
	return `${parts[0] === "~" ? "~" : parts[0]}/…/${parts.slice(-2).join("/")}`;
}

interface LogRow {
	t: number;
	credit: number;
}

function dayFile(dir: string, d: Date): string {
	const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return path.join(dir, `requests-${ymd}.jsonl`);
}

/**
 * 从网关请求日志里数积分。
 *
 * 只统计 `user_agent` 以 `pi` 开头的行 —— 同一份日志里还有 codex / claude 的请求。
 * 按 mtime 短路：文件没变就不重读（否则每秒读一遍几十 MB）。
 * 注意缓存命中时要把旧行带回来（`rows.push(...cached)`），否则积分会被清空。
 */
export class CreditMeter {
	private file = "";
	private mtimeMs = -1;
	private rows: LogRow[] = [];
	private busy = false;

	constructor(private readonly logDir: string) {}

	get available(): boolean {
		return Boolean(this.logDir);
	}

	async refresh(): Promise<void> {
		if (!this.logDir || this.busy) return;
		this.busy = true;
		try {
			const today = dayFile(this.logDir, new Date());
			const files = [today];
			const midnight = new Date();
			midnight.setHours(0, 0, 0, 0);
			const rows: LogRow[] = [];
			let mtime = -1;
			for (const file of files) {
				const isToday = file === today;
				try {
					const s = await stat(file);
					if (isToday) mtime = s.mtimeMs;
					if (isToday && file === this.file && s.mtimeMs === this.mtimeMs) {
						rows.push(...this.rows);
						continue;
					}
					const text = await readFile(file, "utf8");
					for (const line of text.split("\n")) {
						if (!line.startsWith("{")) continue;
						try {
							const r = JSON.parse(line);
							if (!String(r.user_agent ?? "").startsWith("pi")) continue;
							rows.push({ t: parseTime(r.time), credit: Number(r.credit) || 0 });
						} catch {}
					}
				} catch {}
			}
			rows.sort((a, b) => a.t - b.t);
			this.rows = rows;
			this.file = today;
			this.mtimeMs = mtime;
		} finally {
			this.busy = false;
		}
	}

	/** 从某个时间点起的累计积分。 */
	since(ts: number): number {
		let sum = 0;
		for (const row of this.rows) if (row.t >= ts) sum += row.credit;
		return sum;
	}
}
