/**
 * Telegram Stars refunds.
 *
 * refundStarPayment REQUIRES the payer's user_id, which Telegram only sends on
 * the successful_payment update. It is captured into order metadata there; a
 * charge without it must be refused locally instead of sending a request the
 * Bot API will reject.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDatabase } from "../../src/config/database";
import { resetConfigCache } from "../../src/config/env";
import { TelegramStarsGateway } from "../../src/gateways/telegram-stars";
import { refundStarsPayment } from "../../src/gateways/telegram-stars/refund";

const TEST_DB = join(tmpdir(), `1pay-stars-refund-${Date.now()}.db`);
const BOT_TOKEN = "123456:test-refund-token";

process.env.API_KEY = "test-api-key-starsrefund";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-starsrefund";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
resetConfigCache();

const originalFetch = globalThis.fetch;
const gateway = new TelegramStarsGateway();

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

async function seedPaidOrder(chargeId: string, metadata: Record<string, unknown>) {
	await getDb().execute({
		sql: `INSERT INTO orders (id, merchant_id, project_id, project_order_id, callback_url,
			gateway, gateway_reference, amount, currency, payment_method, status, metadata,
			created_at, updated_at)
			VALUES (?, 'merch_r', 'merch_r', ?, 'https://cb.example.com/s',
			'telegram_stars', ?, 100, 'XTR', 'stars', 'success', ?, datetime('now'), datetime('now'))`,
		args: [`ord_${chargeId}`, `proj_${chargeId}`, chargeId, JSON.stringify(metadata)],
	});
}

describe("refundStarsPayment", () => {
	test("sends user_id and charge id, and reports success", async () => {
		const calls: Array<{ url: string; body: string }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			calls.push({ url: String(input), body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
		}) as unknown as typeof fetch;

		const result = await refundStarsPayment("chg_1", 100, undefined, 12345);
		expect(result.status).toBe("success");
		expect(calls[0].url).toContain(`/bot${BOT_TOKEN}/refundStarPayment`);
		const sent = JSON.parse(calls[0].body);
		expect(sent.user_id).toBe(12345);
		expect(sent.telegram_payment_charge_id).toBe("chg_1");
	});

	test("refuses without a payer id instead of calling the API", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		await expect(refundStarsPayment("chg_2", 100)).rejects.toThrow(/user_id/);
		expect(called).toBe(false);
	});

	test("surfaces a Bot API rejection as an error", async () => {
		globalThis.fetch = (async () =>
			new Response("CHARGE_ALREADY_REFUNDED", { status: 400 })) as unknown as typeof fetch;
		await expect(refundStarsPayment("chg_3", 100, undefined, 1)).rejects.toThrow(/Refund failed/);
	});
});

describe("gateway.refundPayment resolves the payer from order metadata", () => {
	test("uses telegram_user_id captured at payment time", async () => {
		await seedPaidOrder("chg_ok", { telegram_user_id: 98765 });
		const calls: Array<{ body: string }> = [];
		globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
			calls.push({ body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
		}) as unknown as typeof fetch;

		const result = await gateway.refundPayment("chg_ok", 100);
		expect(result.status).toBe("success");
		expect(JSON.parse(calls[0].body).user_id).toBe(98765);
	});

	test("refuses when the order has no captured user id", async () => {
		await seedPaidOrder("chg_nouser", {});
		await expect(gateway.refundPayment("chg_nouser", 100)).rejects.toThrow(/user_id/);
	});

	test("surfaces a database fault instead of reporting a missing payer", async () => {
		// Close the handle behind the service: a DB fault must not masquerade as
		// "this order has no telegram_user_id", which sends operators hunting
		// the order instead of the database.
		const db = getDb();
		const originalExecute = db.execute.bind(db);
		db.execute = (() => {
			throw new Error("disk I/O error");
		}) as typeof db.execute;
		try {
			await expect(
				gateway.refundPayment("chg_db", 100),
			).rejects.toThrow(/Could not read the order/);
		} finally {
			db.execute = originalExecute;
		}
	});
});
