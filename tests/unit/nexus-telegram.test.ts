/**
 * Nexus Telegram paths (Sweep88): invite-mint on fulfill + DM-sent reminder.
 *
 * Both need bot token + channel/chat ids; existing Nexus tests run without
 * tokens (undefined paths). These stub global fetch and isolate env per
 * test (shared-process suite: restore everything in finally).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-tg-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexustg";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-nexustg";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { handleNexusPayment } from "../../src/services/nexus-fulfillment";
import {
	resetVariantMap,
} from "../../src/services/nexus-config";
import { sendExpiryReminders } from "../../src/services/nexus-cron";

let db: Client;
const prevFetch = globalThis.fetch;

function sqliteNow(offsetMs = 0): string {
	return new Date(Date.now() + offsetMs)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);
}

beforeAll(async () => {
	await initDatabase();
	db = getDb();
});

afterAll(() => {
	globalThis.fetch = prevFetch;
	db.close();
});

function withTokens() {
	process.env.NEXUS_TELEGRAM_BOT_TOKEN = "tg-test-token";
	process.env.NEXUS_TELEGRAM_CHANNEL_ID = "-100123";
	resetConfigCache();
	resetVariantMap();
}

function withoutTokens() {
	delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
	delete process.env.TELEGRAM_BOT_TOKEN;
	delete process.env.NEXUS_TELEGRAM_CHANNEL_ID;
	resetConfigCache();
	resetVariantMap();
	globalThis.fetch = prevFetch;
}

describe("fulfillOrder invite mint", () => {
	test("stores invite link when Telegram API confirms", async () => {
		withTokens();
		const calls: Array<{ url: string; body: string }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			calls.push({ url: String(input), body: String(init?.body ?? "") });
			return new Response(
				JSON.stringify({ ok: true, result: { invite_link: "https://t.me/+minted1" } }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		try {
			const orderId = `scx-mint-${Date.now()}`;
			const res = await handleNexusPayment(
				"scalev",
				{ id: orderId, status: "success", items: [{ variant_name: "Bot Crypto" }] },
				"mint@example.com",
				"Mint",
			);
			expect(res.success).toBe(true);
			expect(res.inviteLink).toBe("https://t.me/+minted1");
			expect(calls.some((c) => c.url.includes("createChatInviteLink"))).toBe(true);
			const mintCall = calls.find((c) => c.url.includes("createChatInviteLink"));
			const sent = JSON.parse(mintCall!.body) as Record<string, unknown>;
			expect(sent.member_limit).toBe(1);
			expect(sent.chat_id).toBe("-100123");
		} finally {
			withoutTokens();
		}
	});

	test("stores null link when Telegram API rejects (row still created)", async () => {
		withTokens();
		globalThis.fetch = (async () =>
			new Response("bad request", { status: 400 })) as unknown as typeof fetch;
		try {
			const orderId = `scx-mintfail-${Date.now()}`;
			const res = await handleNexusPayment(
				"scalev",
				{ id: orderId, status: "success", items: [{ variant_name: "Bot Crypto" }] },
				"mintfail@example.com",
				"MintFail",
			);
			expect(res.success).toBe(true);
			expect(res.inviteLink).toBeUndefined();
			const rows = await db.execute({
				sql: "SELECT telegram_invite_link FROM nexus_subscriptions WHERE scalev_order_id = ?",
				args: [orderId],
			});
			expect(rows.rows.length).toBe(1);
			expect((rows.rows[0] as Record<string, unknown>).telegram_invite_link).toBeNull();
		} finally {
			withoutTokens();
		}
	});
});

describe("sendExpiryReminders DM-sent path", () => {
	test("sends DM via sendMessage and stamps reminder", async () => {
		withTokens();
		const sent: Array<{ url: string; body: string }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			sent.push({ url: String(input), body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const custId = `nc_dm_${Date.now()}`;
			await db.execute({
				sql: "INSERT INTO nexus_customers (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				args: [custId, "dm@example.com", "Dm", sqliteNow(), sqliteNow()],
			});
			const subId = `ns_dm_${Date.now()}`;
			await db.execute({
				sql: `INSERT INTO nexus_subscriptions
					(id, customer_id, tier, variant, scalev_order_id, status, telegram_invite_link, telegram_chat_id, expires_at, reminder_sent_at, created_at, updated_at)
					VALUES (?, ?, 'auto_bot', 'Auto Bot', ?, 'active', ?, ?, ?, NULL, ?, ?)`,
				args: [
					subId,
					custId,
					`scx_dm_${subId}`,
					"https://t.me/+dm1",
					"chat_dm_1",
					sqliteNow(24 * 3600_000),
					sqliteNow(),
					sqliteNow(),
				],
			});
			await sendExpiryReminders();
			expect(sent.some((c) => c.url.includes("/sendMessage"))).toBe(true);
			const dm = sent.find((c) => c.url.includes("/sendMessage"));
			const payload = JSON.parse(dm!.body) as Record<string, unknown>;
			expect(payload.chat_id).toBe("chat_dm_1");
			expect(String(payload.text)).toContain("Dm");
			const rows = await db.execute({
				sql: "SELECT reminder_sent_at FROM nexus_subscriptions WHERE id = ?",
				args: [subId],
			});
			expect(
				(rows.rows[0] as Record<string, unknown>).reminder_sent_at,
			).not.toBeNull();
		} finally {
			withoutTokens();
		}
	});
});
