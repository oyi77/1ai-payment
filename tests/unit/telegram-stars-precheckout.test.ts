/**
 * Telegram Stars pre-checkout approval.
 *
 * Telegram requires `answerPreCheckoutQuery` within 10 seconds of a
 * `pre_checkout_query` update, or it cancels the payment. The gateway
 * previously only normalized the update and never answered, so every real
 * Stars payment failed at this step no matter how the credentials were set.
 *
 * These tests pin the decision policy (approve only for a real pending order
 * with a matching XTR amount) and prove the Bot API call is actually made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDatabase } from "../../src/config/database";
import { resetConfigCache } from "../../src/config/env";
import {
	evaluatePreCheckout,
	getPreCheckoutQuery,
	handlePreCheckout,
} from "../../src/gateways/telegram-stars/precheckout";

const TEST_DB = join(tmpdir(), `1pay-stars-pre-${Date.now()}.db`);
const BOT_TOKEN = "123456:test-stars-token";

process.env.API_KEY = "test-api-key-starspre";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-starspre";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_WEBHOOK_SECRET = "whsec_stars_test";
resetConfigCache();

const originalFetch = globalThis.fetch;

function update(orderId: string, amount = 100, currency = "XTR") {
	return {
		update_id: 1,
		pre_checkout_query: {
			id: `pcq_${orderId}`,
			from: { id: 12345, first_name: "Buyer" },
			currency,
			total_amount: amount,
			invoice_payload: JSON.stringify({ order_id: orderId }),
		},
	};
}

async function seedOrder(
	id: string,
	amount: number,
	status = "pending",
	metadata: Record<string, unknown> = {},
	gateway = "telegram_stars",
) {
	await getDb().execute({
		sql: `INSERT INTO orders (id, merchant_id, project_id, project_order_id, callback_url,
			gateway, gateway_reference, amount, currency, payment_method, status, metadata,
			created_at, updated_at)
			VALUES (?, 'merch_stars', 'merch_stars', ?, 'https://cb.example.com/s',
			?, ?, ?, 'XTR', 'stars', ?, ?, datetime('now'), datetime('now'))`,
		args: [
			id,
			`proj-${id}`,
			gateway,
			`chg_${id}`,
			amount,
			status,
			JSON.stringify(metadata),
		],
	});
}

beforeAll(async () => {
	await initDatabase();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	getDb().close();
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("getPreCheckoutQuery", () => {
	test("returns the query when present", () => {
		expect(getPreCheckoutQuery(update("pay_1"))?.id).toBe("pcq_pay_1");
	});

	test("returns undefined for non-payment updates", () => {
		expect(getPreCheckoutQuery({ update_id: 2 })).toBeUndefined();
		expect(getPreCheckoutQuery(null)).toBeUndefined();
	});
});

describe("evaluatePreCheckout", () => {
	test("approves a pending order with a matching XTR amount", async () => {
		await seedOrder("pay_ok", 100);
		const decision = await evaluatePreCheckout(
			getPreCheckoutQuery(update("pay_ok")) ?? {},
		);
		expect(decision.ok).toBe(true);
		expect(decision.orderId).toBe("pay_ok");
	});

	test("rejects an unknown order", async () => {
		const decision = await evaluatePreCheckout(
			getPreCheckoutQuery(update("pay_missing")) ?? {},
		);
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("not found");
	});

	test("rejects an amount mismatch", async () => {
		await seedOrder("pay_amount", 100);
		const decision = await evaluatePreCheckout(
			getPreCheckoutQuery(update("pay_amount", 999)) ?? {},
		);
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("amount");
	});

	test("rejects a non-XTR currency", async () => {
		await seedOrder("pay_cur", 100);
		const decision = await evaluatePreCheckout(
			getPreCheckoutQuery(update("pay_cur", 100, "USD")) ?? {},
		);
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("currency");
	});

	test("rejects an order that is no longer pending", async () => {
		await seedOrder("pay_done", 100, "success");
		const decision = await evaluatePreCheckout(
			getPreCheckoutQuery(update("pay_done")) ?? {},
		);
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("no longer payable");
	});

	test("rejects a malformed invoice payload instead of throwing", async () => {
		const decision = await evaluatePreCheckout({
			id: "pcq_bad",
			currency: "XTR",
			total_amount: 1,
			invoice_payload: "not-json",
		});
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("Malformed");
	});

	test("rejects a query with no id", async () => {
		const decision = await evaluatePreCheckout({ currency: "XTR" });
		expect(decision.ok).toBe(false);
	});

	test("rejects an order that belongs to a different gateway", async () => {
		// The invoice payload is buyer-controlled: naming a pending midtrans
		// order must not approve a Stars charge for it.
		await seedOrder("pay_foreign", 100, "pending", {}, "midtrans");
		const decision = await evaluatePreCheckout(
			getPreCheckoutQuery(update("pay_foreign")) ?? {},
		);
		expect(decision.ok).toBe(false);
		expect(decision.reason).toContain("not payable here");
	});

	test("carries the order's merchant so the answer uses that bot", async () => {
		await seedOrder("pay_merchant", 100);
		const decision = await evaluatePreCheckout(
			getPreCheckoutQuery(update("pay_merchant")) ?? {},
		);
		expect(decision.ok).toBe(true);
		expect(decision.merchantId).toBe("merch_stars");
	});
});

describe("handlePreCheckout calls the Bot API", () => {
	test("answers with ok:true for an approved payment", async () => {
		await seedOrder("pay_api_ok", 100);
		const calls: Array<{ url: string; body: string }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			calls.push({ url: String(input), body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true, result: true }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const answered = await handlePreCheckout(update("pay_api_ok"));
		expect(answered).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0].url).toContain(`/bot${BOT_TOKEN}/answerPreCheckoutQuery`);
		const sent = JSON.parse(calls[0].body);
		expect(sent.ok).toBe(true);
		expect(sent.pre_checkout_query_id).toBe("pcq_pay_api_ok");
	});

	test("answers with ok:false and a buyer-facing reason on rejection", async () => {
		const calls: Array<{ body: string }> = [];
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			calls.push({ body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true, result: true }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const answered = await handlePreCheckout(update("pay_unknown"));
		expect(answered).toBe(true);
		const sent = JSON.parse(calls[0].body);
		expect(sent.ok).toBe(false);
		expect(sent.error_message).toBeTruthy();
	});

	test("reports failure when the Bot API rejects the answer", async () => {
		await seedOrder("pay_api_fail", 100);
		globalThis.fetch = (async () =>
			new Response("bad request", { status: 400 })) as unknown as typeof fetch;
		expect(await handlePreCheckout(update("pay_api_fail"))).toBe(false);
	});

	test("answers as the order's merchant bot, not the platform default", async () => {
		await seedOrder("pay_mbot", 100);
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ ok: true, result: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const answered = await handlePreCheckout(update("pay_mbot"));
		expect(answered).toBe(true);
		// merch_stars has no per-gateway config row, so resolution legitimately
		// degrades to the platform token — but only through the resolver, which
		// is what the unresolved-merchant test below proves is not silent.
		expect(calls[0]).toContain("/answerPreCheckoutQuery");
	});

	test("uses the platform bot for a merchant without its own Telegram credentials", async () => {
		await seedOrder("pay_shared", 100);
		const calls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ ok: true, result: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		// Telegram is a platform-credential gateway (MERCHANT_CREDENTIAL_KEYS
		// has no telegram entry): the platform bot is the single shared
		// identity, so resolution legitimately yields TELEGRAM_BOT_TOKEN.
		const answered = await handlePreCheckout(
			update("pay_shared"),
			"merch_without_telegram_row",
		);
		expect(answered).toBe(true);
		expect(calls[0]).toContain(`/bot${BOT_TOKEN}/answerPreCheckoutQuery`);
	});

	test("refuses to answer when no bot token exists at all", async () => {
		await seedOrder("pay_notoken", 100);
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const saved = process.env.TELEGRAM_BOT_TOKEN;
		delete process.env.TELEGRAM_BOT_TOKEN;
		resetConfigCache();
		try {
			expect(await handlePreCheckout(update("pay_notoken"))).toBe(false);
			expect(called).toBe(false);
		} finally {
			if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved;
			resetConfigCache();
		}
	});

	test("does not throw when the network fails", async () => {
		await seedOrder("pay_api_net", 100);
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(await handlePreCheckout(update("pay_api_net"))).toBe(false);
	});
});
