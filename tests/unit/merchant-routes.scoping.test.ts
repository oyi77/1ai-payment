/**
 * Route-level tests for merchant update + rotate-key scoping.
 *
 * PATCH /api/merchants/:id and POST /api/merchants/:id/api-key must be
 * strictly owner-scoped — a merchant must not update another merchant's
 * profile or rotate their API key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-merchant-route-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-merchr";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-merchr";
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

	merchantAKey = "merch-route-key-a";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_u_a", "Update A", sha256Hash(merchantAKey), "sec_a"],
	});

	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("PATCH /api/merchants/:id (scoping)", () => {
	test("updates own merchant name", async () => {
		const res = await app.request("/api/merchants/merch_u_a", {
			method: "PATCH",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Updated A" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.name).toBe("Updated A");
	});

	test("rejects update of non-existent merchant (403, no info leak)", async () => {
		const res = await app.request("/api/merchants/merch_nonexistent", {
			method: "PATCH",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Noop" }),
		});
		expect(res.status).toBe(403);
	});

	test("rejects update of other merchant (403 — cross-tenant)", async () => {
		const res = await app.request("/api/merchants/merch_i_dont_own", {
			method: "PATCH",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Hacked" }),
		});
		expect(res.status).toBe(403);
	});
});

describe("POST /api/merchants/:id/api-key (scoping)", () => {
	test("rotates own key and returns success", async () => {
		const res = await app.request("/api/merchants/merch_u_a/api-key", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.api_key).toBeString();
		// Old key no longer works
		const oldKeyRes = await app.request("/api/merchants/merch_u_a", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(oldKeyRes.status).toBe(401);

		// Update merchantAKey so other tests don't break
		merchantAKey = body.data.api_key;
	});

	test("rejects rotate of other merchant (403)", async () => {
		const res = await app.request("/api/merchants/merch_i_dont_own/api-key", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
		});
		expect(res.status).toBe(403);
	});
});