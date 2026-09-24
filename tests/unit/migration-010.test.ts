/**
 * Migration 010 test (Sweep159): the webhook dedupe key widens from
 * (order_id, gateway, status) to (+ gateway_reference) so a genuine second
 * payment with a new reference is recorded while exact retries still dedupe.
 * Simulates a live DB on the old shape, then migrates and proves the new key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-mig010-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-mig010";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-mig010";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { runMigrations } from "../../src/config/migrations";

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	// Simulate a live DB on the OLD shape: unmark 010, restore old index.
	await db.execute("DELETE FROM _migrations WHERE version = '010'");
	await db.execute("DROP INDEX IF EXISTS idx_webhook_events_dedup");
	await db.execute(
		"CREATE UNIQUE INDEX idx_webhook_events_dedup ON webhook_events(order_id, gateway, status) WHERE order_id IS NOT NULL",
	);
	await runMigrations(db);
});

afterAll(() => {
	db.close();
});

describe("migration 010 (Sweep159)", () => {
	test("dedupe index carries gateway_reference", async () => {
		const rows = await db.execute({
			sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_webhook_events_dedup'",
		});
		expect(rows.rows.length).toBe(1);
		const sql = String(rows.rows[0].sql);
		expect(sql).toContain("gateway_reference");
	});

	test("same status + new reference inserts; same reference rejects", async () => {
		await db.execute({
			sql: "INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status) VALUES (?, 'tripay', 'ord_m10', 'REF-1', 'success')",
			args: [`we_m10_a_${Date.now()}`],
		});
		await db.execute({
			sql: "INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status) VALUES (?, 'tripay', 'ord_m10', 'REF-2', 'success')",
			args: [`we_m10_b_${Date.now()}`],
		});
		let threw = false;
		try {
			await db.execute({
				sql: "INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status) VALUES (?, 'tripay', 'ord_m10', 'REF-2', 'success')",
				args: [`we_m10_c_${Date.now()}`],
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test("re-run is a no-op (idempotent)", async () => {
		await runMigrations(db);
		const rows = await db.execute({
			sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_webhook_events_dedup'",
		});
		expect(String(rows.rows[0].sql)).toContain("gateway_reference");
	});
});
