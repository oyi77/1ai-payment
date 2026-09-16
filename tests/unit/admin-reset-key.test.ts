/**
 * Admin API-key reset tests — account recovery escape hatch.
 *
 * Scenario: a merchant loses the API key. Self-service rotate requires the
 * CURRENT key, so a lost key = permanent lockout. Only an admin (X-Admin-Key)
 * can mint a replacement via POST /api/admin/merchants/:id/api-key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-admin-reset-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-reset";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-reset-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	// NOTE: bun test runs files in ONE shared process (no --isolate), so
	// app.request() lands on a shared app instance and process.env mutates
	// race. Use a per-file unique merchant id + verify state via this file's
	// own db handle (DATABASE_PATH points here), never via sibling state.
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_locked", "Locked Out", sha256Hash("lost-key-gone"), "sec_lock"],
	});
	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("POST /api/admin/merchants/:id/api-key (recovery)", () => {
	test("rejects without admin key", async () => {
		const res = await app.request("/api/admin/merchants/merch_locked/api-key", {
			method: "POST",
		});
		expect(res.status).toBe(401);
	});

	test("rejects wrong admin key", async () => {
		const res = await app.request("/api/admin/merchants/merch_locked/api-key", {
			method: "POST",
			headers: { "X-Admin-Key": "wrong" },
		});
		expect(res.status).toBe(401);
	});

	test("404 for unknown merchant", async () => {
		const res = await app.request("/api/admin/merchants/merch_nope/api-key", {
			method: "POST",
			headers: { "X-Admin-Key": "test-admin-reset-key" },
		});
		expect(res.status).toBe(404);
	});

	test("admin resets key; old hash gone; response shows key once", async () => {
		const res = await app.request("/api/admin/merchants/merch_locked/api-key", {
			method: "POST",
			headers: { "X-Admin-Key": "test-admin-reset-key" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		const newKey = body.data.api_key as string;
		expect(newKey.length).toBeGreaterThan(16);

		// Old hash gone from DB (lookup by sha256 no longer finds the row)
		const oldHash = await db.execute({
			sql: "SELECT id FROM merchants WHERE api_key_hash = ?",
			args: [sha256Hash("lost-key-gone")],
		});
		expect(oldHash.rows.length).toBe(0);

		// New hash is live in THIS file's DB (proves rotation took effect;
		// merchant-fetch-by-new-key is covered via live smoke + the equivalent
		// service-level path which does not race with sibling files).
		const newHash = await db.execute({
			sql: "SELECT id FROM merchants WHERE api_key_hash = ?",
			args: [sha256Hash(newKey)],
		});
		expect(newHash.rows.length).toBe(1);
	});
});
