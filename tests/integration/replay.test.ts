/**
 * Integration tests for POST /api/webhook-deliveries/{id}/replay
 *
 * Exercises the dead-letter replay endpoint end to end:
 * - a successful replay re-forwards the stored event and stamps replayed_at
 * - unknown dead letters and dead letters owned by another merchant are 404
 * - a failing project callback surfaces as 502 REPLAY_FAILED after retries
 * - a missing API key is rejected with 401
 *
 * Uses a fresh temp SQLite database per run. Env vars are set before any
 * module-level code runs (imports are evaluated lazily under Bun inside a
 * test file with top-level await).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../src/config/env";
import type {
	CreateOrderParams,
	Order,
} from "../../src/services/order.service";

const TEST_DB = join(tmpdir(), `1pay-replay-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-replay";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

let app: import("hono").Hono;
let createOrderFn: (params: CreateOrderParams) => Promise<Order>;

/**
 * Run a callback with setTimeout replaced so delays execute instantly.
 * The original setTimeout is restored after the callback completes.
 */
async function withInstantTimers<T>(fn: () => Promise<T>): Promise<T> {
	globalThis.setTimeout = ((
		fn: (...args: unknown[]) => void,
		_ms?: number,
	) => originalSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
	try {
		return await fn();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
}

/**
 * Create a merchant, a paid order owned by it, and a dead-letter entry that
 * failed to forward, so the replay endpoint has something to work with.
 */
async function createReplayFixture(
	merchantId = "merch_replay",
	dlId = "dl_replay_1",
): Promise<Order> {
	const { getDb } = await import("../../src/config/database");
	const db = getDb();

	const order = await createOrderFn({
		project_id: merchantId,
		merchant_id: merchantId,
		callback_url: "https://cb.example.com/hook",
		gateway: "midtrans",
		amount: 50000,
		currency: "IDR",
	});

	await db.execute({
		sql: "UPDATE orders SET status = 'success', gateway_reference = ? WHERE id = ?",
		args: ["gw_replay_1", order.id],
	});

	const event = {
		gateway: "midtrans",
		order_id: order.id,
		gateway_reference: "gw_replay_1",
		status: "success",
		amount: 50000,
		currency: "IDR",
		payment_method: "bank_transfer",
		paid_at: new Date().toISOString(),
		metadata: null,
	};
	await db.execute({
		sql: `INSERT INTO dead_letter_events (id, order_id, gateway, event_data, error, attempts)
          VALUES (?, ?, 'midtrans', ?, 'boom', 3)`,
		args: [
			dlId,
			order.id,
			JSON.stringify({
				event,
				order_id: order.id,
				callback_url: order.callback_url,
				payload: JSON.stringify({
					gateway: "midtrans",
					order_id: order.id,
					status: "success",
					amount: 50000,
					currency: "IDR",
				}),
			}),
		],
	});

	return order;
}

beforeAll(async () => {
	const { initDatabase, getDb } = await import("../../src/config/database");
	const { paymentRoutes } = await import("../../src/routes/payment");
	const { createOrder } = await import("../../src/services/order.service");
	const { sha256Hash } = await import("../../src/utils/crypto");
	const { Hono } = await import("hono");

	await initDatabase();
	const db = getDb();

	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active) VALUES (?, ?, ?, ?, 1)",
		args: [
			"merch_replay",
			"Replay",
			sha256Hash("test-key-replay"),
			"whsec_replay",
		],
	});

	createOrderFn = createOrder;
	app = new Hono();
	app.route("/api", paymentRoutes);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.setTimeout = originalSetTimeout;
});

afterAll(() => {
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("POST /api/webhook-deliveries/{id}/replay", () => {
	test("re-forwards a stored dead letter and stamps replayed_at", async () => {
		const order = await createReplayFixture();
		let fetchCalls = 0;

		globalThis.fetch = ((url, init) => {
			fetchCalls++;
			expect(String(url)).toBe("https://cb.example.com/hook");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(init?.body as string);
			expect(body.event).toBe("payment.success");
			expect(body.order_id).toBe(order.id);
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const res = await app.request("/api/webhook-deliveries/dl_replay_1/replay", {
			method: "POST",
			headers: { "X-API-Key": "test-key-replay" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.id).toBe("dl_replay_1");
		expect(body.data.replayed_at).toBeTruthy();
		expect(fetchCalls).toBe(1);
	});

	test("404 for an unknown dead letter id", async () => {
		const res = await app.request(
			"/api/webhook-deliveries/dl_does_not_exist/replay",
			{
				method: "POST",
				headers: { "X-API-Key": "test-key-replay" },
			},
		);

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("NOT_FOUND");
	});

	test("404 when the dead letter belongs to another merchant", async () => {
		const { getDb } = await import("../../src/config/database");
		const { sha256Hash } = await import("../../src/utils/crypto");
		const db = getDb();

		await db.execute({
			sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active) VALUES (?, ?, ?, ?, 1)",
			args: [
				"merch_other",
				"Other",
				sha256Hash("test-key-other"),
				"whsec_other",
			],
		});
		await createReplayFixture("merch_other", "dl_replay_other");

		let fetchCalls = 0;
		globalThis.fetch = (() => {
			fetchCalls++;
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const res = await app.request(
			"/api/webhook-deliveries/dl_replay_other/replay",
			{
				method: "POST",
				headers: { "X-API-Key": "test-key-replay" },
			},
		);

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error.code).toBe("NOT_FOUND");
		// Ownership is rejected before any re-forward attempt happens.
		expect(fetchCalls).toBe(0);
	});

	test("502 REPLAY_FAILED when the project callback keeps failing", async () => {
		await createReplayFixture("merch_replay", "dl_replay_fail");
		let fetchCalls = 0;

		globalThis.fetch = (() => {
			fetchCalls++;
			return Promise.resolve(
				new Response("Internal Server Error", { status: 500 }),
			);
		}) as unknown as typeof fetch;

		const res = await withInstantTimers(() =>
			app.request("/api/webhook-deliveries/dl_replay_fail/replay", {
				method: "POST",
				headers: { "X-API-Key": "test-key-replay" },
			}),
		);

		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error.code).toBe("REPLAY_FAILED");
		// Caller must receive a generic message — internal forward/secret state must NOT leak.
		expect(body.error.message).toBe("Replay failed, please retry or contact support");
		expect(body.error.message).not.toContain("HTTP 500");
		expect(body.error.message).not.toContain("webhook secret");
		expect(fetchCalls).toBe(3);
	});

	test("401 without an API key", async () => {
		const res = await app.request("/api/webhook-deliveries/dl_replay_1/replay", {
			method: "POST",
		});

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe("UNAUTHORIZED");
	});
});
