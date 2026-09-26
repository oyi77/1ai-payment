/**
 * Nexus Telegram username capture + claim link (NexusDM).
 *
 * The Bot API cannot DM a raw username (sendMessage needs a chat_id the bot
 * has seen). So fulfillment stores the normalized username and returns a
 * personal claim link https://t.me/<bot>?start=sub_<id> — the customer taps
 * it, the bot sees /start with the subscription id and delivers the invite.
 * No new column: the link is deterministic from bot username + sub id.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-user-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexususer";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-nexususer";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.NEXUS_TELEGRAM_CHANNEL_ID;
process.env.NEXUS_TELEGRAM_BOT_USERNAME = "NexusTestBot";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import {
	buildClaimLink,
	handleNexusPayment,
	normalizeTelegramUsername,
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
	return {
		id: orderId,
		status: "success",
		items: [{ variant_name: "Bot Crypto" }],
	};
}

describe("normalizeTelegramUsername", () => {
	test("strips @, lowercases, accepts valid", () => {
		expect(normalizeTelegramUsername("@Budi_Crypto")).toBe("budi_crypto");
		expect(normalizeTelegramUsername("trader123")).toBe("trader123");
	});
	test("rejects too short, too long, bad chars, non-strings", () => {
		expect(normalizeTelegramUsername("ab")).toBeUndefined();
		expect(normalizeTelegramUsername("a".repeat(33))).toBeUndefined();
		expect(normalizeTelegramUsername("budi crypto")).toBeUndefined();
		expect(normalizeTelegramUsername("budi-crypto")).toBeUndefined();
		expect(normalizeTelegramUsername(42)).toBeUndefined();
		expect(normalizeTelegramUsername(null)).toBeUndefined();
	});
});

describe("buildClaimLink", () => {
	test("builds deterministic t.me link", () => {
		expect(buildClaimLink("NexusTestBot", "ns_123")).toBe(
			"https://t.me/nexustestbot?start=sub_ns_123",
		);
	});
	test("null without bot username or sub id", () => {
		expect(buildClaimLink(undefined, "ns_123")).toBeUndefined();
		expect(buildClaimLink("", "ns_123")).toBeUndefined();
		expect(buildClaimLink("NexusTestBot", "")).toBeUndefined();
	});
});

describe("fulfillment with telegram username (NexusDM)", () => {
	test("stores normalized username and returns claim link", async () => {
		const orderId = `scx-user-${Date.now()}`;
		const res = await handleNexusPayment(
			"scalev",
			body(orderId),
			"user@example.com",
			"User",
			"@Budi_Crypto",
		);
		expect(res.success).toBe(true);
		expect(res.claimLink).toBe(
			`https://t.me/nexustestbot?start=sub_${res.subscriptionId}`,
		);
		const rows = await db.execute({
			sql: "SELECT c.telegram_username FROM nexus_customers c JOIN nexus_subscriptions s ON s.customer_id = c.id WHERE s.id = ?",
			args: [res.subscriptionId ?? ""],
		});
		expect(String(rows.rows[0].telegram_username)).toBe("budi_crypto");
	});

	test("invalid username still fulfills, no username stored, claim link kept", async () => {
		const orderId = `scx-nouser-${Date.now()}`;
		const res = await handleNexusPayment(
			"scalev",
			body(orderId),
			"nouser@example.com",
			"NoUser",
			"!!!",
		);
		expect(res.success).toBe(true);
		expect(res.claimLink).toBe(
			`https://t.me/nexustestbot?start=sub_${res.subscriptionId}`,
		);
		const rows = await db.execute({
			sql: "SELECT c.telegram_username FROM nexus_customers c JOIN nexus_subscriptions s ON s.customer_id = c.id WHERE s.id = ?",
			args: [res.subscriptionId ?? ""],
		});
		expect(rows.rows[0].telegram_username).toBeNull();
	});
});
