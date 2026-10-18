/**
 * wb-panel 的纯函数与计费器测试。
 *
 * 跑法（Node 24，`wb-gateway.ts` 里的参数属性需要 transform 模式）：
 *   cd pi-tui && npm test
 *   # = node --experimental-transform-types --test test/
 *
 * 这些断言都能真的失败：聚合口径错了余额就错、单调累加退化成重算就会掉数、
 * 到期提醒阈值写反就会天天占着 footer。打印布尔值的「冒烟」不算测试，
 * 见仓库根 `CODING_STANDARDS.md`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	EXPIRY_WARN_MS,
	PanelMeter,
	aggregateAccounts,
	fetchBalance,
	formatCredits,
	parseCreditRows,
	parsePanelTime,
	shortExpiry,
	shouldShowExpiry,
} from "../extensions/wb-panel.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function account(over: Record<string, unknown> = {}) {
	return {
		credits: 100,
		credits_total: 200,
		credits_earliest_expiry: "2026-10-31T23:59:59+08:00",
		credits_earliest_remaining: 10,
		...over,
	};
}

function piEntry(over: Record<string, unknown> = {}) {
	return {
		time: "2026-10-18T07:42:20.246337113+08:00",
		request_id: "req-1",
		model: "cn:deepseek-v4.1-flash",
		total_tokens: 100,
		credit: 0.06,
		credit_known: true,
		user_agent: "pi (win32 10.0.26300; x64)",
		...over,
	};
}

test("formatCredits 把积分数值压成 footer 放得下的形状", () => {
	assert.equal(formatCredits(4568), "4568");
	assert.equal(formatCredits(7250), "7250");
	assert.equal(formatCredits(12.34), "12");
	assert.equal(formatCredits(3.21), "3.2");
	assert.equal(formatCredits(9.97), "10");
	assert.equal(formatCredits(0), "0");
	assert.equal(formatCredits(999), "999");
	assert.equal(formatCredits(12_500), "12500");
	assert.equal(formatCredits(125_400), "125k");
	assert.equal(formatCredits(1_250_000), "1.3M");
	assert.equal(formatCredits(Number.NaN), "0");
});

test("parsePanelTime 认纳秒时间戳，也认「零值」为空", () => {
	assert.equal(
		parsePanelTime("2026-10-18T07:42:20.246337113+08:00"),
		Date.parse("2026-10-18T07:42:20.246+08:00"),
	);
	assert.equal(parsePanelTime("0001-01-01T00:00:00Z"), undefined);
	assert.equal(parsePanelTime(""), undefined);
	assert.equal(parsePanelTime(undefined), undefined);
});

test("aggregateAccounts 只累加健康账号，取最早到期的批次", () => {
	const doc = {
		accounts: [
			account({ nickname: "a", credits: 4568, credits_total: 7250, credits_earliest_expiry: "2026-10-31T23:59:59+08:00", credits_earliest_remaining: 28 }),
			account({ nickname: "b", credits: 100, credits_total: 300, credits_earliest_expiry: "2026-10-20T00:00:00+08:00", credits_earliest_remaining: 100 }),
			account({ nickname: "disabled", credits: 999, credits_total: 999, disabled: true }),
			account({ nickname: "unhealthy", credits: 999, credits_total: 999, healthy: false }),
		],
	};
	const balance = aggregateAccounts(doc, 1_000);
	assert.ok(balance);
	assert.equal(balance.remaining, 4668);
	assert.equal(balance.total, 7550);
	assert.equal(balance.expiryAt, Date.parse("2026-10-20T00:00:00+08:00"));
	assert.equal(balance.expiryRemaining, 100);
	assert.equal(balance.at, 1_000);
});

test("aggregateAccounts 在没有可用账号时返回 null（调用方据此回落到 $）", () => {
	assert.equal(aggregateAccounts({}, 0), null);
	assert.equal(aggregateAccounts({ accounts: [] }, 0), null);
	assert.equal(aggregateAccounts({ accounts: [account({ disabled: true })] }, 0), null);
	assert.equal(aggregateAccounts(null, 0), null);
});

test("shouldShowExpiry 只在真会被浪费时出现", () => {
	const now = Date.parse("2026-10-18T00:00:00+08:00");
	// 平时（28/7250、两周后到期）：不占 footer
	assert.equal(shouldShowExpiry(28, 7250, now + 13 * DAY, now), false);
	// 真实账号进入 3 天窗口，但只有 28/7250（0.4%）会过期 —— 量太小，还是不吵
	assert.equal(shouldShowExpiry(28, 7250, now + 2 * DAY, now), false);
	// 一大批量快到期：这才是该提醒的
	assert.equal(shouldShowExpiry(5_000, 10_000, now + 2 * DAY, now), true);
	// 量够大但还早（超过 3 天窗口）
	assert.equal(shouldShowExpiry(5_000, 10_000, now + EXPIRY_WARN_MS + HOUR, now), false);
	assert.equal(shouldShowExpiry(5_000, 10_000, now + 30 * DAY, now), false);
	// 已过期 / 无到期时间 / 没有到期量
	assert.equal(shouldShowExpiry(5_000, 10_000, now - HOUR, now), false);
	assert.equal(shouldShowExpiry(5_000, 10_000, undefined, now), false);
	assert.equal(shouldShowExpiry(0, 10_000, now + DAY, now), false);
});

test("shortExpiry 输出 M-DD", () => {
	assert.equal(shortExpiry(new Date(2026, 9, 31).getTime()), "10-31");
	assert.equal(shortExpiry(new Date(2026, 0, 5).getTime()), "1-05");
});

test("parseCreditRows 只认 pi 自己发出去的请求", () => {
	const doc = {
		entries: [
			piEntry({ request_id: "req-pi" }),
			piEntry({ request_id: "req-codex", user_agent: "codex_cli_rs/0.20" }),
			piEntry({ request_id: "req-claude", user_agent: "claude-cli/1.0" }),
		],
	};
	const rows = parseCreditRows(doc);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.id, "req-pi");
	assert.equal(rows[0]!.credit, 0.06);
});

test("parseCreditRows 给缺失 request_id 的行拼一个稳定 id", () => {
	const doc = { entries: [piEntry({ request_id: undefined })] };
	const rows = parseCreditRows(doc);
	assert.equal(rows.length, 1);
	const t = parsePanelTime("2026-10-18T07:42:20.246337113+08:00");
	assert.equal(rows[0]!.id, `${t}:cn:deepseek-v4.1-flash:100`);
});

test("parseCreditRows 跳过没有 credit / 时间的行", () => {
	const doc = {
		entries: [piEntry({ credit: null }), piEntry({ time: "0001-01-01T00:00:00Z" }), piEntry({ credit: 0.5, request_id: "ok" })],
	};
	const rows = parseCreditRows(doc);
	assert.deepEqual(rows.map((r) => r.id), ["ok"]);
});

/** 用假的 fetch 让计费器跑在固定日志上。 */
function stubLogs(windows: Array<Array<Record<string, unknown>>>): () => void {
	const original = globalThis.fetch;
	let call = 0;
	globalThis.fetch = (async () => {
		const entries = windows[Math.min(call, windows.length - 1)] ?? [];
		call += 1;
		return new Response(JSON.stringify({ entries }), { status: 200 });
	}) as unknown as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

const T0 = Date.parse("2026-10-18T07:00:00+08:00");

function row(id: string, minutes: number, credit: number): Record<string, unknown> {
	return piEntry({ request_id: id, credit, time: new Date(T0 + minutes * 60_000).toISOString() });
}

test("PanelMeter 单调累加：日志滚出窗口也不掉数", async () => {
	// 第一次拿到 A、B 两条；第二次窗口里只剩 C（A/B 被网关挤出窗口）
	const restore = stubLogs([[row("a", 1, 0.05), row("b", 2, 0.06)], [row("b", 2, 0.06), row("c", 3, 0.07)]]);
	try {
		const meter = new PanelMeter({ root: "http://127.0.0.1:7863", apiKey: "k" });
		assert.equal(await meter.refresh(T0), true);
		assert.equal(meter.since(T0), 0.11);
		assert.equal(await meter.refresh(T0), true);
		// b 不重复计数（0.05+0.06+0.07），a 不因为滚出窗口而消失
		assert.ok(Math.abs(meter.since(T0) - 0.18) < 1e-9);
		// 只用后半段窗口算「本轮」时也不受累计影响
		assert.ok(Math.abs(meter.since(T0 + 2.5 * 60_000) - 0.07) < 1e-9);
	} finally {
		restore();
	}
});

test("PanelMeter 拉取失败时保留已计入的数", async () => {
	const restore = stubLogs([[row("a", 1, 0.05)]]);
	try {
		const meter = new PanelMeter({ root: "http://127.0.0.1:7863", apiKey: "k" });
		await meter.refresh(T0);
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
		assert.equal(await meter.refresh(T0), false);
		assert.equal(meter.since(T0), 0.05);
	} finally {
		restore();
	}
});

test("fetchBalance 三种结果分别对应积分模式 / 非控制台网关 / 网络故障", async () => {
	const gw = { root: "http://127.0.0.1:7863", apiKey: "k" };
	const original = globalThis.fetch;
	try {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ accounts: [account({ credits: 4568, credits_total: 7250 })] }), { status: 200 })) as unknown as typeof fetch;
		const ok = await fetchBalance(gw);
		assert.equal(ok.kind, "ok");
		if (ok.kind !== "ok") assert.fail("expected ok");
		assert.equal(ok.balance.remaining, 4568);

		globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
		assert.equal((await fetchBalance(gw)).kind, "not-panel");

		globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
		assert.equal((await fetchBalance(gw)).kind, "not-panel");

		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		assert.equal((await fetchBalance(gw)).kind, "error");
	} finally {
		globalThis.fetch = original;
	}
});
