/**
 * Route-level tests for transaction + webhook-delivery listing scoping.
 *
 * These endpoints JOIN orders / webhook_events and must be strictly
 * merchant-scoped — a merchant must never see another merchant's orders,
 * transactions, or webhook deliveries. This is a cross-tenant leak surface.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-list-route-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-listroute";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-listroute";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;
let merchantAKey = "";
let merchantBKey = "";

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	merchantAKey = "list-route-key-a";
	merchantBKey = "list-route-key-b";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_list_a", "List A", sha256Hash(merchantAKey), "sec_a"],
	});
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_list_b", "List B", sha256Hash(merchantBKey), "sec_b"],
	});

	// Seed orders for both merchants
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_a_1', 'merch_list_a', 'merch_list_a', 'https://a.example/hook', 'midtrans', 10000, 'IDR', 'success', 'idem_a_1', datetime('now'), datetime('now'))`,
		args: [],
	});
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_b_1', 'merch_list_b', 'merch_list_b', 'https://b.example/hook', 'midtrans', 99999, 'IDR', 'pending', 'idem_b_1', datetime('now'), datetime('now'))`,
		args: [],
	});

	// Seed webhook events for both orders
	await db.execute({
		sql: `INSERT INTO webhook_events (id, gateway, order_id, status, raw_payload, created_at)
		      VALUES ('wh_a_1', 'midtrans', 'ord_a_1', 'success', '{"order":"a"}', datetime('now'))`,
		args: [],
	});
	await db.execute({
		sql: `INSERT INTO webhook_events (id, gateway, order_id, status, raw_payload, created_at)
		      VALUES ('wh_b_1', 'midtrans', 'ord_b_1', 'success', '{"order":"b-secret"}', datetime('now'))`,
		args: [],
	});

	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("GET /api/transactions (scoping)", () => {
	test("merchant A sees only its own transaction", async () => {
		const res = await app.request("/api/transactions", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.total).toBe(1);
		expect(body.data.transactions[0].id).toBe("ord_a_1");
		expect(JSON.stringify(body)).not.toContain("ord_b_1");
		expect(JSON.stringify(body)).not.toContain("99999");
	});

	test("merchant B sees only its own transaction", async () => {
		const res = await app.request("/api/transactions", {
			headers: { "X-API-Key": merchantBKey },
		});
		const body = await res.json();
		expect(body.data.total).toBe(1);
		expect(body.data.transactions[0].id).toBe("ord_b_1");
		expect(JSON.stringify(body)).not.toContain("ord_a_1");
	});

	test("filters by status", async () => {
		// A has only 'success'
		const res = await app.request("/api/transactions?status=pending", {
			headers: { "X-API-Key": merchantAKey },
		});
		const body = await res.json();
		expect(body.data.total).toBe(0);

		const resB = await app.request("/api/transactions?status=pending", {
			headers: { "X-API-Key": merchantBKey },
		});
		const bodyB = await resB.json();
		expect(bodyB.data.total).toBe(1);
		expect(bodyB.data.transactions[0].id).toBe("ord_b_1");
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/transactions");
		expect(res.status).toBe(401);
	});
});

describe("GET /api/webhook-deliveries (scoping)", () => {
	test("merchant A sees only its own webhook events", async () => {
		const res = await app.request("/api/webhook-deliveries", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.total).toBe(1);
		expect(body.data.deliveries[0].id).toBe("wh_a_1");
		expect(JSON.stringify(body)).not.toContain("wh_b_1");
		// raw payload must NOT be exposed (only id/order_id/status/signature/created_at)
		expect(JSON.stringify(body)).not.toContain("a-secret");
	});

	test("merchant B sees only its own webhook events", async () => {
		const res = await app.request("/api/webhook-deliveries", {
			headers: { "X-API-Key": merchantBKey },
		});
		const body = await res.json();
		expect(body.data.total).toBe(1);
		expect(body.data.deliveries[0].id).toBe("wh_b_1");
	});

	test("filters by order_id and stays scoped", async () => {
		// A filters on B's order id -> empty (scoped join)
		const res = await app.request("/api/webhook-deliveries?order_id=ord_b_1", {
			headers: { "X-API-Key": merchantAKey },
		});
		const body = await res.json();
		expect(body.data.total).toBe(0);
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/webhook-deliveries");
		expect(res.status).toBe(401);
	});
});
