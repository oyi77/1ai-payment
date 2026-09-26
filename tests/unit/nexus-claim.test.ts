/**
 * Nexus claim endpoint (NexusDM): GET /api/admin/nexus/claim/:subId.
 *
 * The Telegram bot holding X-Admin-Key resolves a tapped claim link
 * (t.me/<bot>?start=sub_<id>) to the invite + status. 404 when unknown,
 * revoked, or expired — the bot tells the user to contact support.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-nexus-claim-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-nexusclaim";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-claim-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;
let activeSub: string;
let revokedSub: string;

const ADMIN = { "X-Admin-Key": "test-admin-claim-key" };

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	const now = "2026-09-26 10:00:00";
	await db.execute({
		sql: "INSERT INTO nexus_customers (id, email, name, telegram_username, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		args: ["cust_claim", "claim@example.com", "Claim", "budi_crypto", now, now],
	});
	activeSub = `ns_claim_active_${Date.now()}`;
	revokedSub = `ns_claim_revoked_${Date.now()}`;
	await db.execute({
		sql: `INSERT INTO nexus_subscriptions
			(id, customer_id, tier, variant, scalev_order_id, status, telegram_invite_link, telegram_chat_id, expires_at, created_at, updated_at)
			VALUES (?, 'cust_claim', 'auto_bot', 'Auto Bot', 'scx-claim-1', 'active', 'https://t.me/+inv123', NULL, '2026-10-26 10:00:00', ?, ?)`,
		args: [activeSub, now, now],
	});
	await db.execute({
		sql: `INSERT INTO nexus_subscriptions
			(id, customer_id, tier, variant, scalev_order_id, status, telegram_invite_link, telegram_chat_id, expires_at, created_at, updated_at)
			VALUES (?, 'cust_claim', 'auto_bot', 'Auto Bot', 'scx-claim-2', 'revoked', NULL, NULL, '2026-10-26 10:00:00', ?, ?)`,
		args: [revokedSub, now, now],
	});
	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("GET /api/admin/nexus/claim/:subId", () => {
	test("rejects without admin key", async () => {
		const res = await app.request(`/api/admin/nexus/claim/${activeSub}`);
		expect(res.status).toBe(401);
	});

	test("resolves active subscription with invite + username", async () => {
		const res = await app.request(`/api/admin/nexus/claim/${activeSub}`, {
			headers: ADMIN,
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.subscription_id).toBe(activeSub);
		expect(body.data.tier).toBe("auto_bot");
		expect(body.data.telegram_invite_link).toBe("https://t.me/+inv123");
		expect(body.data.telegram_username).toBe("budi_crypto");
	});

	test("404 for unknown subscription", async () => {
		const res = await app.request("/api/admin/nexus/claim/ns_nope_123", {
			headers: ADMIN,
		});
		expect(res.status).toBe(404);
	});

	test("404 for revoked subscription (same as missing)", async () => {
		const res = await app.request(`/api/admin/nexus/claim/${revokedSub}`, {
			headers: ADMIN,
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error.code).toBe("NOT_FOUND");
	});
});
