/**
 * Migration 009 test (Sweep154): legacy plaintext webhook secrets are
 * encrypted at rest on migrate, idempotently; already-encrypted rows are
 * left untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-mig009-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-mig009";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-mig009";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { runMigrations } from "../../src/config/migrations";
import { decryptWebhookSecret, sha256Hash } from "../../src/utils/crypto";

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	// Simulate a legacy DB upgrading to Sweep154: unmark 009, plant a
	// plaintext row, then migrate — 009 must encrypt it in place.
	await db.execute("DELETE FROM _migrations WHERE version = '009'");
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_legacy", "Legacy", sha256Hash("legacy-key"), "whsec_legacy_secret"],
	});
	await runMigrations(db);
});

afterAll(() => {
	db.close();
});

describe("migration 009 (Sweep154)", () => {
	test("legacy plaintext secret is encrypted in place", async () => {
		const rows = await db.execute({
			sql: "SELECT webhook_secret FROM merchants WHERE id = ?",
			args: ["merch_legacy"],
		});
		const stored = String(rows.rows[0].webhook_secret);
		expect(stored).not.toContain("whsec_legacy_secret");
		expect(decryptWebhookSecret(stored)).toBe("whsec_legacy_secret");
	});

	test("re-run is a no-op (idempotent, no double-encrypt)", async () => {
		const before = String(
			(await db.execute({ sql: "SELECT webhook_secret FROM merchants WHERE id = ?", args: ["merch_legacy"] })).rows[0].webhook_secret,
		);
		await runMigrations(db);
		const after = String(
			(await db.execute({ sql: "SELECT webhook_secret FROM merchants WHERE id = ?", args: ["merch_legacy"] })).rows[0].webhook_secret,
		);
		expect(after).toBe(before);
		expect(decryptWebhookSecret(after)).toBe("whsec_legacy_secret");
	});

	test("no plaintext secrets remain anywhere", async () => {
		const rows = await db.execute("SELECT webhook_secret FROM merchants");
		for (const row of rows.rows) {
			expect(String(row.webhook_secret)).not.toMatch(/^whsec_/);
		}
	});
});
