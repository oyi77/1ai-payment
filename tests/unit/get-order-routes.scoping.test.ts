/**
 * Route-level scoping tests for GET /api/payments/:id.
 *
 * A merchant must not read another merchant's payment order (404, no info
 * leak). Non-existent orders also 404 — indistinguishable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-getorder-route-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-getorder";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-getorder";
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

	merchantAKey = "getorder-route-key-a";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_get_a", "Get A", sha256Hash(merchantAKey), "sec_a"],
	});

	// Order owned by A
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_get_a', 'merch_get_a', 'merch_get_a', 'https://a.example/hook', 'midtrans', 10000, 'IDR', 'success', 'idem_get_a', datetime('now'), datetime('now'))`,
		args: [],
	});
	// Order owned by someone else
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_get_other', 'merch_other', 'merch_other', 'https://other.example/hook', 'midtrans', 10000, 'IDR', 'success', 'idem_get_other', datetime('now'), datetime('now'))`,
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

describe("GET /api/payments/:id (scoping)", () => {
	test("returns own order (200)", async () => {
		const res = await app.request("/api/payments/ord_get_a", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.id).toBe("ord_get_a");
		expect(body.data.amount).toBe(10000);
	});

	test("cross-merchant order returns 404", async () => {
		const res = await app.request("/api/payments/ord_get_other", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(404);
	});

	test("non-existent order returns 404", async () => {
		const res = await app.request("/api/payments/ord_nope", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(404);
	});

	test("cross-merchant and non-existent are indistinguishable (no existence oracle)", async () => {
		const cross = await app.request("/api/payments/ord_get_other", {
			headers: { "X-API-Key": merchantAKey },
		});
		const missing = await app.request("/api/payments/ord_nope", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(cross.status).toBe(missing.status);
		const crossBody = await cross.json();
		const missingBody = await missing.json();
		// Status + error code are identical; message differs only in the
		// attacker-supplied id (which they already know), so not a leak.
		expect(crossBody.error.code).toBe(missingBody.error.code);
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/payments/ord_get_a");
		expect(res.status).toBe(401);
	});
});