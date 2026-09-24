/**
 * Link/subscription lifetime alignment (Sweep170).
 *
 * The invite LINK must expire with the subscription: expire_date sent to
 * createChatInviteLink ~= subscription expires_at (both = created +
 * durationDays). This pins the entry-gate half of expiry. Member removal
 * (joined members staying past expiry) is structurally blocked — no flow
 * captures member user_id; see LIFETIME MODEL in nexus-fulfillment.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-life-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexuslife";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-nexuslife";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.NEXUS_TELEGRAM_BOT_TOKEN = "tg-life-token";
process.env.NEXUS_TELEGRAM_CHANNEL_ID = "-100999";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { handleNexusPayment } from "../../src/services/nexus-fulfillment";
import { resetVariantMap } from "../../src/services/nexus-config";

let db: Client;
const prevFetch = globalThis.fetch;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
});

afterAll(() => {
	globalThis.fetch = prevFetch;
	db.close();
});

describe("link/subscription lifetime alignment (Sweep170)", () => {
	test("link expire_date ~= subscription expires_at (30d default)", async () => {
		let linkBody = "";
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			linkBody = String(init?.body ?? "");
			return new Response(JSON.stringify({ ok: true, result: { invite_link: "https://t.me/+life1" } }), { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const before = Date.now();
			const orderId = `scx-life-${Date.now()}`;
			const res = await handleNexusPayment(
				"scalev",
				{ id: orderId, status: "success", items: [{ variant_name: "Bot Crypto" }] },
				"life@example.com",
				"Life",
			);
			expect(res.success).toBe(true);
			const sent = JSON.parse(linkBody) as { expire_date: number };
			const linkDays = (sent.expire_date - Math.floor(before / 1000)) / 86400;
			expect(linkDays).toBeGreaterThan(29.9);
			expect(linkDays).toBeLessThan(30.1);
			const rows = await db.execute({
				sql: "SELECT expires_at FROM nexus_subscriptions WHERE id = ?",
				args: [res.subscriptionId ?? ""],
			});
			const expiresAt = new Date(String(rows.rows[0].expires_at).replace(" ", "T") + "Z").getTime();
			const subDays = (expiresAt - before) / 86400000;
			expect(subDays).toBeGreaterThan(29.9);
			expect(subDays).toBeLessThan(30.1);
		} finally {
			globalThis.fetch = prevFetch;
		}
	});
});
