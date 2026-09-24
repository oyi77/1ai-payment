/**
 * Unit tests for Nexus cron handlers (expiry + reminders).
 *
 * The 6h cron runs untested in prod: these pin the two handlers directly.
 * No Telegram API is hit — tests run without bot tokens (log-only paths)
 * and with a stubbed fetch for the revoke path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-cron-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexuscron";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-nexuscron";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import {
	handleExpiredSubscriptions,
	sendExpiryReminders,
} from "../../src/services/nexus-cron";

let db: Client;

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
	db.close();
});

async function seedSub(opts: {
	customerEmail: string;
	expiresOffsetMs: number;
	chatId?: string;
	inviteLink?: string;
	reminderSent?: boolean;
}): Promise<string> {
	const custId = `nc_cron_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	await db.execute({
		sql: "INSERT INTO nexus_customers (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		args: [custId, opts.customerEmail, "Cron", sqliteNow(), sqliteNow()],
	});
	const subId = `ns_cron_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	await db.execute({
		sql: `INSERT INTO nexus_subscriptions
			(id, customer_id, tier, variant, scalev_order_id, status, telegram_invite_link, telegram_chat_id, expires_at, reminder_sent_at, created_at, updated_at)
			VALUES (?, ?, 'auto_bot', 'Auto Bot', ?, 'active', ?, ?, ?, ?, ?, ?)`,
		args: [
			subId,
			custId,
			`scx_cron_${subId}`,
			opts.inviteLink ?? null,
			opts.chatId ?? null,
			sqliteNow(opts.expiresOffsetMs),
			opts.reminderSent ? sqliteNow() : null,
			sqliteNow(),
			sqliteNow(),
		],
	});
	return subId;
}

async function subStatus(id: string): Promise<string> {
	const r = await db.execute({
		sql: "SELECT status FROM nexus_subscriptions WHERE id = ?",
		args: [id],
	});
	return String((r.rows[0] as Record<string, unknown>).status);
}

describe("handleExpiredSubscriptions", () => {
	test("expires past-due subscriptions, keeps future ones active", async () => {
		const past = await seedSub({
			customerEmail: "past@example.com",
			expiresOffsetMs: -3600_000,
		});
		const future = await seedSub({
			customerEmail: "future@example.com",
			expiresOffsetMs: 30 * 86400_000,
		});
		await handleExpiredSubscriptions();
		expect(await subStatus(past)).toBe("expired");
		expect(await subStatus(future)).toBe("active");
	});

	test("revokes invite via Telegram API when token and link present", async () => {
		process.env.NEXUS_TELEGRAM_BOT_TOKEN = "test-bot-token";
		resetConfigCache();
		const calls: string[] = [];
		const prev = globalThis.fetch;
		globalThis.fetch = (async (input: unknown) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as typeof fetch;
		try {
			const sub = await seedSub({
				customerEmail: "revoke@example.com",
				expiresOffsetMs: -3600_000,
				chatId: "chat_1",
				inviteLink: "https://t.me/+invite1",
			});
			await handleExpiredSubscriptions();
			expect(await subStatus(sub)).toBe("expired");
			expect(calls.some((u) => u.includes("revokeChatInviteLink"))).toBe(
				true,
			);
		} finally {
			globalThis.fetch = prev;
			delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
			resetConfigCache();
		}
	});
});

describe("revokeTelegramInviteLink result", () => {
	test("returns true on Telegram ok, false on reject or throw", async () => {
		const { revokeTelegramInviteLink } = await import(
			"../../src/services/nexus-fulfillment"
		);
		const prev = globalThis.fetch;
		try {
			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
			expect(await revokeTelegramInviteLink("tok", "chat", "link")).toBe(true);
			globalThis.fetch = (async () =>
				new Response("bad", { status: 400 })) as typeof fetch;
			expect(await revokeTelegramInviteLink("tok", "chat", "link")).toBe(false);
			globalThis.fetch = (() => Promise.reject(new Error("down"))) as typeof fetch;
			expect(await revokeTelegramInviteLink("tok", "chat", "link")).toBe(false);
		} finally {
			globalThis.fetch = prev;
		}
	});
});

describe("handleExpiredSubscriptions skips API without chat_id", () => {
	test("no fetch call when invite link present but chat_id missing", async () => {
		process.env.NEXUS_TELEGRAM_BOT_TOKEN = "test-bot-token";
		resetConfigCache();
		const calls: string[] = [];
		const prev = globalThis.fetch;
		globalThis.fetch = (async (input: unknown) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as typeof fetch;
		try {
			const sub = await seedSub({
				customerEmail: "noch@example.com",
				expiresOffsetMs: -3600_000,
				inviteLink: "https://t.me/+invite9",
			});
			await handleExpiredSubscriptions();
			expect(calls.length).toBe(0);
			const r = await db.execute({
				sql: "SELECT status FROM nexus_subscriptions WHERE id = ?",
				args: [sub],
			});
			expect(String((r.rows[0] as Record<string, unknown>).status)).toBe("expired");
		} finally {
			globalThis.fetch = prev;
			delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
			resetConfigCache();
		}
	});
});

describe("sendExpiryReminders", () => {
	test("stamps reminder for subscriptions expiring within 48h (log-only, no token)", async () => {
		const sub = await seedSub({
			customerEmail: "remind@example.com",
			expiresOffsetMs: 24 * 3600_000,
		});
		await sendExpiryReminders();
		const r = await db.execute({
			sql: "SELECT reminder_sent_at FROM nexus_subscriptions WHERE id = ?",
			args: [sub],
		});
		expect((r.rows[0] as Record<string, unknown>).reminder_sent_at).not.toBeNull();
	});

	test("skips already-reminded and far-future subscriptions", async () => {
		const reminded = await seedSub({
			customerEmail: "reminded@example.com",
			expiresOffsetMs: 24 * 3600_000,
			reminderSent: true,
		});
		const far = await seedSub({
			customerEmail: "far@example.com",
			expiresOffsetMs: 30 * 86400_000,
		});
		await sendExpiryReminders();
		const r = await db.execute({
			sql: "SELECT id, reminder_sent_at FROM nexus_subscriptions WHERE id IN (?, ?)",
			args: [reminded, far],
		});
		const farRow = r.rows.find(
			(x) => String((x as Record<string, unknown>).id) === far,
		) as Record<string, unknown>;
		expect(farRow.reminder_sent_at).toBeNull();
	});
});

describe("backupDatabase", () => {
	test("writes a readable snapshot of the live DB (Sweep113)", async () => {
		const { backupDatabase } = await import("../../src/config/database");
		const { existsSync, rmSync } = await import("node:fs");
		const backupPath = await backupDatabase();
		expect(backupPath).toBe(`${TEST_DB}.backup`);
		expect(existsSync(backupPath)).toBe(true);
		// Snapshot is a real SQLite DB containing our tables.
		const { createClient } = await import("@libsql/client");
		const snap = createClient({ url: `file:${backupPath}` });
		const tables = await snap.execute(
			"SELECT name FROM sqlite_master WHERE type='table'",
		);
		const names = tables.rows.map((r) => String((r as Record<string, unknown>).name));
		expect(names).toContain("orders");
		expect(names).toContain("merchants");
		snap.close();
		rmSync(backupPath);
	});

	test("second snapshot overwrites the first (Sweep131)", async () => {
		const { backupDatabase } = await import("../../src/config/database");
		const { existsSync, rmSync } = await import("node:fs");
		const first = await backupDatabase();
		expect(existsSync(first)).toBe(true);
		// Must not throw "output file already exists" — the stale copy is replaced.
		const second = await backupDatabase();
		expect(second).toBe(first);
		expect(existsSync(second)).toBe(true);
		rmSync(second);
	});
});
