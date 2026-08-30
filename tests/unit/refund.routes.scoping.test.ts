/**
 * Route-level tests for refund API scoping + error redaction.
 *
 * createRefund must not leak: whether an order exists, who owns it, or its
 * status — all surface as a redacted gateway error. Cross-merchant refund
 * attempts must be rejected (404, no info leak).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-refund-route-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-refundr";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-refundr";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;
let merchantAKey = "";

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	merchantAKey = "refund-route-key-a";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_refund_a", "Refund A", sha256Hash(merchantAKey), "sec_a"],
	});

	// A successful order owned by merchant A
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_refund_a', 'merch_refund_a', 'merch_refund_a', 'https://a.example/hook', 'midtrans', 50000, 'IDR', 'success', 'idem_refund_a', datetime('now'), datetime('now'))`,
		args: [],
	});
	// A successful order owned by someone else
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_other', 'merch_other', 'merch_other', 'https://other.example/hook', 'midtrans', 50000, 'IDR', 'success', 'idem_other', datetime('now'), datetime('now'))`,
		args: [],
	});
	// A pending (non-refundable) order owned by merchant A
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_refund_pending', 'merch_refund_a', 'merch_refund_a', 'https://a.example/hook', 'midtrans', 50000, 'IDR', 'pending', 'idem_pending', datetime('now'), datetime('now'))`,
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

describe("POST /api/refunds (scoping + redaction)", () => {
	test("creates refund for own successful order (201)", async () => {
		const res = await app.request("/api/refunds", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "ord_refund_a", amount: 10000 }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.order_id).toBe("ord_refund_a");
		expect(body.data.amount).toBe(10000);
	});

	test("cross-merchant refund attempt is rejected (404, no info leak)", async () => {
		const res = await app.request("/api/refunds", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "ord_other", amount: 10000 }),
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		// Redacted — must not reveal the other merchant's order exists
		expect(body.success).toBe(false);
		expect(JSON.stringify(body)).not.toContain("ord_other");
	});

	test("non-refundable status is rejected (400)", async () => {
		const res = await app.request("/api/refunds", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "ord_refund_pending", amount: 10000 }),
		});
		expect(res.status).toBe(400);
	});

	test("refund exceeding order amount is rejected (400)", async () => {
		const res = await app.request("/api/refunds", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "ord_refund_a", amount: 999999 }),
		});
		expect(res.status).toBe(400);
	});

	test("non-existent order returns 404 (redacted)", async () => {
		const res = await app.request("/api/refunds", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "ord_nope", amount: 10000 }),
		});
		expect(res.status).toBe(404);
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/refunds", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: "ord_refund_a", amount: 10000 }),
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/refunds (scoping)", () => {
	test("lists only own refunds", async () => {
		const res = await app.request("/api/refunds", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.total).toBeGreaterThanOrEqual(1);
		// The refunded order is A's
		for (const r of body.data.refunds) {
			expect(r.order_id).not.toBe("ord_other");
		}
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/refunds");
		expect(res.status).toBe(401);
	});
});
