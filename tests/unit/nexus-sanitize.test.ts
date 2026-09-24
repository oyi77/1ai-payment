/**
 * Nexus PII sanitizers (Sweep176): unbounded webhook email/name fields
 * are capped/shaped before reaching nexus_customers; malformed email
 * degrades to anonymous fulfillment instead of storing junk.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-san-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexussan";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-nexussan";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.NEXUS_TELEGRAM_CHANNEL_ID;
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import {
	handleNexusPayment,
	sanitizeCustomerEmail,
	sanitizeCustomerName,
} from "../../src/services/nexus-fulfillment";

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
});

afterAll(() => {
	db.close();
});

function body(orderId: string): Record<string, unknown> {
	return { id: orderId, status: "success", items: [{ variant_name: "Bot Crypto" }] };
}

describe("sanitizers (Sweep176)", () => {
	test("valid email and name pass through", () => {
		expect(sanitizeCustomerEmail("budi@example.com")).toBe("budi@example.com");
		expect(sanitizeCustomerName("Budi Santoso")).toBe("Budi Santoso");
	});

	test("oversized email degrades to undefined, name truncates at 128", () => {
		expect(sanitizeCustomerEmail("a".repeat(300) + "@example.com")).toBeUndefined();
		const long = "N".repeat(200);
		expect(sanitizeCustomerName(long)).toBe("N".repeat(128));
	});

	test("malformed email and blank name degrade", () => {
		expect(sanitizeCustomerEmail("not-an-email")).toBeUndefined();
		expect(sanitizeCustomerEmail(42)).toBeUndefined();
		expect(sanitizeCustomerName("   ")).toBeUndefined();
		expect(sanitizeCustomerName(null)).toBeUndefined();
	});
});

describe("fulfillment with dirty PII (Sweep176)", () => {
	test("giant email still fulfills, stored anonymously", async () => {
		const orderId = `scx-san-${Date.now()}`;
		const res = await handleNexusPayment("scalev", body(orderId), "X".repeat(5000), "Dirty");
		expect(res.success).toBe(true);
		const rows = await db.execute({
			sql: "SELECT c.email, c.name FROM nexus_customers c JOIN nexus_subscriptions s ON s.customer_id = c.id WHERE s.id = ?",
			args: [res.subscriptionId ?? ""],
		});
		const row = rows.rows[0] as Record<string, unknown>;
		expect(row.email).toBeNull();
		expect(String(row.name)).toBe("Dirty");
	});

	test("giant name truncates, email kept", async () => {
		const orderId = `scx-san2-${Date.now()}`;
		const res = await handleNexusPayment("scalev", body(orderId), "kept@example.com", "N".repeat(500));
		expect(res.success).toBe(true);
		const rows = await db.execute({
			sql: "SELECT c.email, c.name FROM nexus_customers c JOIN nexus_subscriptions s ON s.customer_id = c.id WHERE s.id = ?",
			args: [res.subscriptionId ?? ""],
		});
		const row = rows.rows[0] as Record<string, unknown>;
		expect(String(row.email)).toBe("kept@example.com");
		expect(String(row.name).length).toBe(128);
	});
});
