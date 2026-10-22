/**
 * Request-ID replay claim must not outlive a withdrawn event.
 *
 * The claim row (webhook_requests) used to be written before the order
 * lookup and amount reconciliation. When a later gate returned 200 without
 * processing — underpaid success, for example — the claim stayed behind, so
 * the gateway's retry with the same request id matched its own stale row and
 * got a "duplicate" 200 for a payment that was never recorded. The claim is
 * now written only after every skip path has returned.
 * A non-duplicate DB failure on the event insert must also release the
 * claim — the event was not recorded, so the gateway retry has to be able to
 * record it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { getDb, initDatabase } from "../../src/config/database";
import { resetConfigCache } from "../../src/config/env";
import { createOrder } from "../../src/services/order.service";
import { spyOn } from "bun:test";

const TEST_DB = join(tmpdir(), `1pay-wh-replay-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-whreplay";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-whreplay";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.MIDTRANS_SERVER_KEY = "midtrans_test_key_whreplay";

resetConfigCache();

let app: Hono;

function signedMidtrans(orderId: string, amount: string) {
	const statusCode = "200";
	const signature_key = crypto
		.createHash("sha512")
		.update(`${orderId}${statusCode}${amount}midtrans_test_key_whreplay`)
		.digest("hex");
	return {
		transaction_status: "settlement",
		order_id: orderId,
		status_code: statusCode,
		gross_amount: amount,
		payment_type: "bank_transfer",
		signature_key,
	};
}

function post(
	orderId: string,
	amount: string,
	requestId: string,
): Promise<Response> {
	return app.request("/webhook/midtrans", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Request-Id": requestId,
		},
		body: JSON.stringify(signedMidtrans(orderId, amount)),
	});
}

async function claims(requestId: string): Promise<number> {
	const res = await getDb().execute({
		sql: "SELECT id FROM webhook_requests WHERE request_id = ?",
		args: [requestId],
	});
	return res.rows.length;
}

async function eventCount(orderId: string): Promise<number> {
	const res = await getDb().execute({
		sql: "SELECT id FROM webhook_events WHERE order_id = ?",
		args: [orderId],
	});
	return res.rows.length;
}

async function orderStatus(orderId: string): Promise<string> {
	const res = await getDb().execute({
		sql: "SELECT status FROM orders WHERE id = ?",
		args: [orderId],
	});
	return String((res.rows[0] as Record<string, unknown>)?.status ?? "");
}

beforeAll(async () => {
	await initDatabase();
	const { paymentRoutes } = await import("../../src/routes/payment");
	const { webhookRoutes } = await import("../../src/routes/webhook");
	const { Hono: HonoApp } = await import("hono");
	app = new HonoApp();
	app.route("/api", paymentRoutes);
	app.route("/webhook", webhookRoutes);
});

afterAll(() => {
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {
		/* best-effort cleanup */
	}
});

describe("request-id replay claim ordering", () => {
	test("an underpaid success does not consume the request id", async () => {
		const order = await createOrder({
			project_id: "replay_test",
			merchant_id: "merch_replay",
			callback_url: "https://example.com/cb",
			gateway: "midtrans",
			amount: 50000,
			currency: "IDR",
		});
		const requestId = `req_underpaid_${Date.now()}`;

		// Short money: 200-skip, nothing recorded, claim must stay free.
		const first = await post(order.id, "10000.00", requestId);
		expect(first.status).toBe(200);
		expect(await claims(requestId)).toBe(0);
		expect(await eventCount(order.id)).toBe(0);
		expect(await orderStatus(order.id)).toBe("pending");

		// The same request id retried with the corrected amount must process.
		const retry = await post(order.id, "50000.00", requestId);
		expect(retry.status).toBe(200);
		expect(await claims(requestId)).toBe(1);
		expect(await eventCount(order.id)).toBe(1);
		expect(await orderStatus(order.id)).toBe("success");
	});

	test("a processed event claims its request id and blocks a replay", async () => {
		const order = await createOrder({
			project_id: "replay_test",
			merchant_id: "merch_replay",
			callback_url: "https://example.com/cb",
			gateway: "midtrans",
			amount: 25000,
			currency: "IDR",
		});
		const requestId = `req_ok_${Date.now()}`;

		const first = await post(order.id, "25000.00", requestId);
		expect(first.status).toBe(200);
		expect(await claims(requestId)).toBe(1);
		expect(await eventCount(order.id)).toBe(1);
		expect(await orderStatus(order.id)).toBe("success");

		const replay = await post(order.id, "25000.00", requestId);
		expect(replay.status).toBe(200);
		expect(await eventCount(order.id)).toBe(1);
	});

	test("a failed event insert releases the claim for the retry", async () => {
		const order = await createOrder({
			project_id: "replay_test",
			merchant_id: "merch_replay",
			callback_url: "https://example.com/cb",
			gateway: "midtrans",
			amount: 75000,
			currency: "IDR",
		});
		const requestId = `req_dbfail_${Date.now()}`;

		// Poison only the event insert: the claim write must still succeed.
		const db = getDb();
		const realExecute = db.execute.bind(db);
		const poisoned = spyOn(db, "execute").mockImplementation(((
			stmt: Parameters<typeof realExecute>[0],
		) => {
			const sql = typeof stmt === "string" ? stmt : String(stmt.sql);
			if (sql.includes("INSERT INTO webhook_events")) {
				return Promise.reject(new Error("simulated disk failure"));
			}
			return realExecute(stmt);
		}) as typeof realExecute);

		try {
			const failed = await post(order.id, "75000.00", requestId);
			expect(failed.status).toBe(200);
		} finally {
			poisoned.mockRestore();
		}

		// Nothing was recorded, so the id must be free again...
		expect(await claims(requestId)).toBe(0);
		expect(await eventCount(order.id)).toBe(0);

		// ...and the gateway's retry has to be processed, not deduped away.
		const retry = await post(order.id, "75000.00", requestId);
		expect(retry.status).toBe(200);
		expect(await claims(requestId)).toBe(1);
		expect(await eventCount(order.id)).toBe(1);
		expect(await orderStatus(order.id)).toBe("success");
	});

});
