/**
 * Migration 011 test: legacy plaintext vault tokens are encrypted at rest
 * in place, idempotently; rows already migrated are left untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-mig011-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-mig011";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-mig011";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { runMigrations } from "../../src/config/migrations";
import { decryptVaultToken, sha256Hash } from "../../src/utils/crypto";

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	// Simulate a legacy DB upgrading to encrypted vault: unmark 011, drop
	// the new-shape artifacts, plant a plaintext row, then migrate.
	await db.execute("DELETE FROM _migrations WHERE version = '011'");
	await db.execute("DROP INDEX IF EXISTS idx_saved_methods_lookup");
	try {
		await db.execute("ALTER TABLE saved_payment_methods DROP COLUMN token_hash");
	} catch {
		// libsql/SQLite build without DROP COLUMN — clear the value instead
		await db.execute("UPDATE saved_payment_methods SET token_hash = NULL");
	}
	await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_methods_unique ON saved_payment_methods(merchant_id, gateway, gateway_token)");
	await db.execute({
		sql: "INSERT INTO saved_payment_methods (id, merchant_id, gateway, method_code, method_name, gateway_token) VALUES (?, ?, ?, ?, ?, ?)",
		args: ["legacy-1", "merch_legacy", "midtrans", "card", "Legacy Card", "tok_legacy_secret"],
	});
	await runMigrations(db);
});

afterAll(() => {
	db.close();
});

describe("migration 011 (vault token encryption)", () => {
	test("legacy plaintext token is encrypted in place with lookup hash", async () => {
		const rows = await db.execute({
			sql: "SELECT gateway_token, token_hash FROM saved_payment_methods WHERE id = ?",
			args: ["legacy-1"],
		});
		const stored = String(rows.rows[0].gateway_token);
		const hash = String(rows.rows[0].token_hash);
		expect(stored).not.toContain("tok_legacy_secret");
		expect(decryptVaultToken(stored)).toBe("tok_legacy_secret");
		expect(hash).toBe(sha256Hash("merch_legacy\nmidtrans\ntok_legacy_secret"));
	});

	test("lookup index exists, old plaintext index is gone", async () => {
		const idx = await db.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_saved_methods_lookup', 'idx_saved_methods_unique')",
		);
		const names = idx.rows.map((r) => String((r as Record<string, unknown>).name));
		expect(names).toContain("idx_saved_methods_lookup");
		expect(names).not.toContain("idx_saved_methods_unique");
	});

	test("re-run is a no-op (idempotent, no double-encrypt)", async () => {
		const before = String(
			(await db.execute({ sql: "SELECT gateway_token FROM saved_payment_methods WHERE id = ?", args: ["legacy-1"] })).rows[0].gateway_token,
		);
		await runMigrations(db);
		const after = String(
			(await db.execute({ sql: "SELECT gateway_token FROM saved_payment_methods WHERE id = ?", args: ["legacy-1"] })).rows[0].gateway_token,
		);
		expect(after).toBe(before);
		expect(decryptVaultToken(after)).toBe("tok_legacy_secret");
	});
});
