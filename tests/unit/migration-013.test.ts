/**
 * Migration 013 test: webhook_requests table for request ID replay tracking
 * and dead_letter_queue for failed mutation fanouts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-mig013-${Date.now()}.db`);

process.env.API_KEY = "mig013_client_key_distinct";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "mig013_admin_key_distinct";
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
});

afterAll(() => {
	db.close();
});

describe("migration 013 (webhook_requests + dead_letter_queue)", () => {
	test("webhook_requests table exists and enforces (request_id, gateway) uniqueness", async () => {
		await db.execute({
			sql: "INSERT INTO webhook_requests (id, request_id, gateway) VALUES (?, ?, ?)",
			args: ["req-1", "idem-key-abc", "midtrans"],
		});

		// Duplicate insertion with same request_id and gateway must fail
		let duplicateThrew = false;
		try {
			await db.execute({
				sql: "INSERT INTO webhook_requests (id, request_id, gateway) VALUES (?, ?, ?)",
				args: ["req-2", "idem-key-abc", "midtrans"],
			});
		} catch (err: unknown) {
			duplicateThrew = true;
			expect(String(err)).toContain("UNIQUE constraint failed");
		}
		expect(duplicateThrew).toBe(true);

		// Different gateway with same request_id is allowed
		await db.execute({
			sql: "INSERT INTO webhook_requests (id, request_id, gateway) VALUES (?, ?, ?)",
			args: ["req-3", "idem-key-abc", "nowpayments"],
		});
		const count = await db.execute("SELECT COUNT(*) as count FROM webhook_requests");
		expect(Number(count.rows[0].count)).toBe(2);
	});

	test("dead_letter_queue table exists and indexes are present", async () => {
		await db.execute({
			sql: "INSERT INTO dead_letter_queue (id, type, payload, error_reason) VALUES (?, ?, ?, ?)",
			args: ["dlq-1", "mutation_fanout", '{"event_id":"evt-1"}', "failed_delivery"],
		});

		const rows = await db.execute("SELECT * FROM dead_letter_queue WHERE id = 'dlq-1'");
		expect(rows.rows.length).toBe(1);
		expect(String(rows.rows[0].type)).toBe("mutation_fanout");
		expect(Number(rows.rows[0].retry_count)).toBe(0);

		// Check index
		const idx = await db.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_dlq_type', 'idx_dlq_retry', 'idx_webhook_requests_request')",
		);
		const names = idx.rows.map((r) => String((r as Record<string, unknown>).name));
		expect(names).toContain("idx_dlq_type");
		expect(names).toContain("idx_dlq_retry");
		expect(names).toContain("idx_webhook_requests_request");
	});

	test("re-running migrations is idempotent", async () => {
		await runMigrations(db);
		const count = await db.execute("SELECT COUNT(*) as count FROM webhook_requests");
		expect(Number(count.rows[0].count)).toBe(2);
	});
});
