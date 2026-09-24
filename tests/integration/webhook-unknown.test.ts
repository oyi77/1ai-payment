/**
 * Unknown-order webhook path: valid signature but no matching order.
 *
 * Must 200 (no gateway retry) AND record the event (audit row). Guards the
 * Sweep64 fail-closed fix: a non-dedupe DB error returns 200 immediately
 * WITHOUT running Nexus fulfillment (no subscription without an audit row).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const TEST_DB = join(tmpdir(), `1pay-whunknown-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-whunknown";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-whunknown";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.MIDTRANS_SERVER_KEY = "midtrans_test_key_whunknown";

let app: import("hono").Hono;

beforeAll(async () => {
	const { initDatabase } = await import("../../src/config/database");
	const { paymentRoutes } = await import("../../src/routes/payment");
	const { webhookRoutes } = await import("../../src/routes/webhook");
	const { Hono } = await import("hono");

	await initDatabase();
	app = new Hono();
	app.route("/api", paymentRoutes);
	app.route("/webhook", webhookRoutes);
});

afterAll(() => {
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {}
});

function signedMidtrans(orderId: string, amount: string) {
	const statusCode = "200";
	const sig = crypto
		.createHash("sha512")
		.update(`${orderId}${statusCode}${amount}midtrans_test_key_whunknown`)
		.digest("hex");
	return {
		transaction_status: "settlement",
		order_id: orderId,
		status_code: statusCode,
		gross_amount: amount,
		payment_type: "bank_transfer",
		signature_key: sig,
	};
}

describe("POST /webhook/midtrans for unknown orders", () => {
	test("200 + event recorded (audit row), no order created", async () => {
		const ghostId = `ghost_${Date.now()}`;
		const res = await app.request("/webhook/midtrans", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(signedMidtrans(ghostId, "15000.00")),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

		const { getDb } = await import("../../src/config/database");
		const rows = await getDb().execute({
			sql: "SELECT order_id, gateway, status FROM webhook_events WHERE order_id = ?",
			args: [ghostId],
		});
		expect(rows.rows.length).toBe(1);
		expect((rows.rows[0] as Record<string, unknown>).gateway).toBe(
			"midtrans",
		);

		const { getOrderById } = await import("../../src/services/order.service");
		expect(await getOrderById(ghostId)).toBeNull();
	});

	test("duplicate unknown webhook dedupes to one row", async () => {
		const ghostId = `ghost_dup_${Date.now()}`;
		const body = JSON.stringify(signedMidtrans(ghostId, "15000.00"));
		for (let i = 0; i < 2; i++) {
			const res = await app.request("/webhook/midtrans", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			expect(res.status).toBe(200);
		}
		const { getDb } = await import("../../src/config/database");
		const rows = await getDb().execute({
			sql: "SELECT COUNT(*) AS n FROM webhook_events WHERE order_id = ?",
			args: [ghostId],
		});
		expect(Number((rows.rows[0] as Record<string, unknown>).n)).toBe(1);
	});
});
