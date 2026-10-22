/**
 * Route-level pin: POST /webhook/telegram_stars must ANSWER pre_checkout_query.
 *
 * The module-level tests pass even if the route never calls them (learned the
 * hard way with Scalev metadata). This drives the real Hono route, so deleting
 * the wiring fails here.
 *
 * Telegram cancels the payment if no answer arrives within 10s, and retries
 * are pointless — the route must reply 200 in both the answered and
 * could-not-answer cases.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getDb, initDatabase } from "../../src/config/database";
import { resetConfigCache } from "../../src/config/env";
import { webhookRoutes } from "../../src/routes/webhook";

const TEST_DB = join(tmpdir(), `1pay-stars-route-${Date.now()}.db`);
const BOT_TOKEN = "123456:route-token";
const WEBHOOK_SECRET = "whsec_route_stars";

process.env.API_KEY = "test-api-key-starsroute";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-starsroute";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
resetConfigCache();

const originalFetch = globalThis.fetch;
let app: Hono;

function preCheckoutUpdate(orderId: string, amount = 100) {
	return {
		update_id: 42,
		pre_checkout_query: {
			id: `pcq_${orderId}`,
			from: { id: 777, first_name: "Buyer" },
			currency: "XTR",
			total_amount: amount,
			invoice_payload: JSON.stringify({ order_id: orderId }),
		},
	};
}

async function post(body: unknown) {
	return app.request("/webhook/telegram_stars", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
			"X-Forwarded-Proto": "https",
		},
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	await initDatabase();
	await getDb().execute({
		sql: `INSERT INTO orders (id, merchant_id, project_id, project_order_id, callback_url,
			gateway, gateway_reference, amount, currency, payment_method, status, metadata,
			created_at, updated_at)
			VALUES ('pay_route_ok', 'merch_r', 'merch_r', 'proj_1', 'https://cb.example.com/s',
			'telegram_stars', 'chg_route_ok', 100, 'XTR', 'stars', 'pending', '{}',
			datetime('now'), datetime('now'))`,
	});
	app = new Hono();
	app.route("/webhook", webhookRoutes);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	getDb().close();
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("POST /webhook/telegram_stars pre-checkout", () => {
	test("approves and actually calls answerPreCheckoutQuery", async () => {
		const calls: Array<{ url: string; body: string }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			calls.push({ url: String(input), body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
		}) as unknown as typeof fetch;

		const res = await post(preCheckoutUpdate("pay_route_ok"));
		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
		expect(calls[0].url).toContain("/answerPreCheckoutQuery");
		expect(JSON.parse(calls[0].body).ok).toBe(true);
	});

	test("rejects an unknown order with a buyer-facing reason", async () => {
		const calls: Array<{ body: string }> = [];
		globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
			calls.push({ body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
		}) as unknown as typeof fetch;

		const res = await post(preCheckoutUpdate("pay_missing"));
		expect(res.status).toBe(200);
		const sent = JSON.parse(calls[0].body);
		expect(sent.ok).toBe(false);
		expect(sent.error_message).toBeTruthy();
	});

	test("rejects an unsigned pre-checkout before answering", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const res = await app.request("/webhook/telegram_stars", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
			body: JSON.stringify(preCheckoutUpdate("pay_route_ok")),
		});
		expect(res.status).toBe(401);
		expect(called).toBe(false);
	});
});
