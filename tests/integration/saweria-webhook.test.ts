/**
 * Saweria webhook reconciliation tests (Sweep105).
 *
 * Saweria signs NOTHING: verifySignature only checks id+message presence.
 * Anyone who knows an order_id can forge a success callback, so the route
 * enforces an amount floor — underpay forgeries (paid X, claim Y>X) are
 * 200-skipped without touching the order, exact/overpay passes.
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

function webhook(overrides: Record<string, unknown> = {}) {
	return {
		id: "swtx_forge_001",
		type: "donation",
		message: orderId,
		amount_raw: 1000,
		cut: 0,
		donator_name: "Forger",
		donator_email: "forger@example.com",
		created_at: new Date().toISOString(),
		...overrides,
	};
}

beforeAll(async () => {
	const { initDatabase, getDb } = await import("../../src/config/database");
	const { Hono } = await import("hono");
	const { sha256Hash, generateMerchantId, generateWebhookSecret, generateOrderId } =
		await import("../../src/utils/crypto");
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

describe("POST /webhook/saweria (unsigned reconciliation)", () => {
	test("underpay forgery 200-skipped, order stays pending", async () => {
		const res = await app.request("/webhook/saweria", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(webhook({ amount_raw: 1000 })),
		});
		expect(res.status).toBe(200);
		expect(await orderStatus(orderId)).toBe("pending");
	});

	test("exact-amount callback marks success", async () => {
		const res = await app.request("/webhook/saweria", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(webhook({ id: "swtx_real_002", amount_raw: 50000 })),
		});
		expect(res.status).toBe(200);
		expect(await orderStatus(orderId)).toBe("success");
	});

	test("unsigned body without id/message still 401", async () => {
		const res = await app.request("/webhook/saweria", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ nope: true }),
		});
		expect(res.status).toBe(401);
	});
});
