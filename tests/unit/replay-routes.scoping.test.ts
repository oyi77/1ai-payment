/**
 * Route-level scoping tests for webhook-delivery replay.
 *
 * POST /api/webhook-deliveries/:id/replay must not let a merchant replay
 * another merchant's dead letter (404, no info leak). Only 404/401 paths are
 * tested here — the happy path performs a network forward, covered elsewhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-replay-route-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-replayr";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-replayr";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;
let merchantAKey = "";

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	merchantAKey = "replay-route-key-a";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_replay_a", "Replay A", sha256Hash(merchantAKey), "sec_a"],
	});

	// Order owned by A
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_replay_a', 'merch_replay_a', 'merch_replay_a', 'https://a.example/hook', 'midtrans', 10000, 'IDR', 'success', 'idem_replay_a', datetime('now'), datetime('now'))`,
		args: [],
	});
	// Order owned by someone else
	await db.execute({
		sql: `INSERT INTO orders (id, project_id, merchant_id, callback_url, gateway, amount, currency, status, idempotency_key, created_at, updated_at)
		      VALUES ('ord_replay_other', 'merch_other', 'merch_other', 'https://other.example/hook', 'midtrans', 10000, 'IDR', 'success', 'idem_replay_other', datetime('now'), datetime('now'))`,
		args: [],
	});

	// Dead letters
	await db.execute({
		sql: "INSERT INTO dead_letter_events (id, order_id, gateway, event_data, error, attempts) VALUES ('dl_a', 'ord_replay_a', 'midtrans', '{}', NULL, 3)",
		args: [],
	});
	await db.execute({
		sql: "INSERT INTO dead_letter_events (id, order_id, gateway, event_data, error, attempts) VALUES ('dl_other', 'ord_replay_other', 'midtrans', '{}', NULL, 3)",
		args: [],
	});

	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("POST /api/webhook-deliveries/:id/replay (scoping)", () => {
	test("returns 401 without API key", async () => {
		const res = await app.request("/api/webhook-deliveries/dl_a/replay", {
			method: "POST",
		});
		expect(res.status).toBe(401);
	});

	test("returns 404 for non-existent dead letter", async () => {
		const res = await app.request("/api/webhook-deliveries/dl_nope/replay", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(404);
	});

	test("cross-merchant replay is blocked (404, no info leak)", async () => {
		const res = await app.request("/api/webhook-deliveries/dl_other/replay", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(JSON.stringify(body)).not.toContain("dl_other");
		expect(JSON.stringify(body)).not.toContain("ord_replay_other");
	});
});