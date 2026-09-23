/**
 * Unit tests for Nexus fulfillment idempotency.
 *
 * fulfillOrder pre-checks scalev_order_id before INSERT, but two parallel
 * webhooks for the same Scalev order both pass the check and insert twice.
 * Migration 007 adds a UNIQUE partial index; the INSERT catch returns the
 * winner instead of 500ing (mirrors the refunds/vault backstops).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-idem-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexus";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-nexus";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { handleNexusPayment } from "../../src/services/nexus-fulfillment";

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
});

afterAll(() => {
	db.close();
});

function scalevBody(orderId: string): Record<string, unknown> {
	return {
		id: orderId,
		status: "success",
		items: [{ variant_name: "Bot Crypto" }],
	};
}

describe("handleNexusPayment idempotency", () => {
	test("sequential same order returns the same subscription", async () => {
		const orderId = `scx-seq-${Date.now()}`;
		const a = await handleNexusPayment(
			"scalev",
			scalevBody(orderId),
			"seq@example.com",
			"Seq",
		);
		expect(a.success).toBe(true);
		const b = await handleNexusPayment(
			"scalev",
			scalevBody(orderId),
			"seq@example.com",
			"Seq",
		);
		expect(b.success).toBe(true);
		expect(b.subscriptionId).toBe(a.subscriptionId);
	});

	test("parallel same order: single subscription row, both callers get the winner", async () => {
		const orderId = `scx-race-${Date.now()}-${Math.random()}`;
		const [a, b] = await Promise.all([
			handleNexusPayment(
				"scalev",
				scalevBody(orderId),
				"race@example.com",
				"Race",
			),
			handleNexusPayment(
				"scalev",
				scalevBody(orderId),
				"race@example.com",
				"Race",
			),
		]);
		expect(a.success).toBe(true);
		expect(b.success).toBe(true);
		expect(a.subscriptionId).toBe(b.subscriptionId);
		const rows = await db.execute({
			sql: "SELECT COUNT(*) AS n FROM nexus_subscriptions WHERE scalev_order_id = ?",
			args: [orderId],
		});
		expect(Number((rows.rows[0] as Record<string, unknown>).n)).toBe(1);
	});
});
