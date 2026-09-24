/**
 * Unit tests for revokeNexusAccess (Sweep145).
 *
 * A terminal-negative Scalev event (cancelled/expired/failed/refunded) for
 * a fulfilled order must end paid access — otherwise a refunded customer
 * keeps Telegram access until expires_at. Only ACTIVE rows are touched;
 * repeat revokes and unknown orders are no-ops.
 *
 * No bot token is set here, so the Telegram revoke call is skipped
 * (fire-safe pattern) while the row status still flips to 'revoked'.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-revoke-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexus-revoke";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-nexus-revoke";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import {
	handleNexusPayment,
	revokeNexusAccess,
} from "../../src/services/nexus-fulfillment";

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

async function subStatus(scalevOrderId: string): Promise<string | null> {
	const rows = await db.execute({
		sql: "SELECT status FROM nexus_subscriptions WHERE scalev_order_id = ?",
		args: [scalevOrderId],
	});
	if (rows.rows.length === 0) return null;
	return String((rows.rows[0] as Record<string, unknown>).status);
}

describe("revokeNexusAccess", () => {
	test("revokes an active subscription on refund", async () => {
		const orderId = `scx-revoke-${Date.now()}`;
		const fulfilled = await handleNexusPayment(
			"scalev",
			scalevBody(orderId),
			"revoke@example.com",
			"Revoke",
		);
		expect(fulfilled.success).toBe(true);
		expect(await subStatus(orderId)).toBe("active");

		const { revoked } = await revokeNexusAccess(orderId, "refunded");
		expect(revoked).toBe(1);
		expect(await subStatus(orderId)).toBe("revoked");
	});

	test("repeat revoke is a no-op (only ACTIVE rows touched)", async () => {
		const orderId = `scx-revoke-repeat-${Date.now()}`;
		await handleNexusPayment("scalev", scalevBody(orderId), "rep@example.com", "Rep");
		expect((await revokeNexusAccess(orderId, "cancelled")).revoked).toBe(1);
		expect((await revokeNexusAccess(orderId, "cancelled")).revoked).toBe(0);
		expect(await subStatus(orderId)).toBe("revoked");
	});

	test("unknown order is a no-op", async () => {
		expect(
			(await revokeNexusAccess(`scx-nope-${Date.now()}`, "expired")).revoked,
		).toBe(0);
	});

	test("empty order id is a no-op", async () => {
		expect((await revokeNexusAccess("", "failed")).revoked).toBe(0);
	});
});
