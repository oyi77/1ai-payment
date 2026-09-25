/**
 * Saweria webhook DISABLED tests (SaweriaFix).
 *
 * Saweria sends UNSIGNED webhooks — no signature scheme exists. Accepting
 * them meant anyone knowing an order_id could forge a success callback
 * (Sweep105 acknowledged this; the amount floor only blocked underpay).
 * POST /webhook/saweria now returns 501 unconditionally. createPayment is
 * unaffected (outbound only, no inbound trust).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = join(tmpdir(), `1pay-saweria-wh-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-saweriawh";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-saweriawh";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

let app: import("hono").Hono;
let orderId: string;

async function orderStatus(id: string): Promise<string> {
	const { getDb } = await import("../../src/config/database");
	const r = await getDb().execute({
		sql: "SELECT status FROM orders WHERE id = ?",
		args: [id],
	});
	return String((r.rows[0] as Record<string, unknown>).status);
}

beforeAll(async () => {
	const { initDatabase, getDb } = await import("../../src/config/database");
	const { Hono } = await import("hono");
	const {
		sha256Hash,
		generateMerchantId,
		generateWebhookSecret,
		generateOrderId,
	} = await import("../../src/utils/crypto");
	const { webhookRoutes } = await import("../../src/routes/webhook");

	await initDatabase();
	const db = getDb();
	const mid = generateMerchantId();
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active, plan) VALUES (?, ?, ?, ?, 1, 'pro')",
		args: [mid, "Saweria WH", sha256Hash("sw-key"), generateWebhookSecret()],
	});
	orderId = generateOrderId();
	await db.execute({
		sql: "INSERT INTO orders (id, project_id, merchant_id, gateway, amount, currency, status, callback_url, created_at, updated_at) VALUES (?, ?, ?, 'saweria', 50000, 'IDR', 'pending', 'https://example.com/cb', datetime('now'), datetime('now'))",
		args: [orderId, mid, mid],
	});

	app = new Hono();
	app.route("/webhook", webhookRoutes);
});

afterAll(() => {
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("POST /webhook/saweria (disabled — unsigned)", () => {
	test("valid-looking donation body returns 501, order untouched", async () => {
		const res = await app.request("/webhook/saweria", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				version: "1",
				created_at: new Date().toISOString(),
				id: "swtx_forged_001",
				type: "donation",
				amount_raw: 50000,
				cut: 0,
				donator_name: "Attacker",
				donator_email: "a@example.com",
				donator_is_user: false,
				message: orderId,
			}),
		});
		expect(res.status).toBe(501);
		const body = await res.json();
		expect(body.error).toMatch(/unsigned/i);
		expect(await orderStatus(orderId)).toBe("pending");
	});

	test("malformed body also returns 501 (gate fires before parsing)", async () => {
		const res = await app.request("/webhook/saweria", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ nope: true }),
		});
		expect(res.status).toBe(501);
	});
});
