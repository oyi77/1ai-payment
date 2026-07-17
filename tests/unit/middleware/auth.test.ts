/**
 * Unit tests for auth middleware — API-key lookup in merchants table,
 * env fallback, disabled merchant rejection, admin-key skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hash } from "../../../src/utils/crypto";
import { resetConfigCache } from "../../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-auth-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-auth";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-auth";
process.env.ENCRYPTION_KEY = "f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { authMiddleware } from "../../../src/middleware/auth";
import { initDatabase, getDb } from "../../../src/config/database";
import type { Client } from "@libsql/client";

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	// Insert a test merchant
	const apiKeyHash = sha256Hash("valid-merchant-key");
	await db.execute({
		sql: "INSERT OR REPLACE INTO merchants (id, name, api_key_hash, webhook_secret, active) VALUES (?, ?, ?, ?, ?)",
		args: ["merch_test", "Test Merchant", apiKeyHash, "whsec_test", 1],
	});

	// Insert a disabled merchant
	const disabledHash = sha256Hash("disabled-merchant-key");
	await db.execute({
		sql: "INSERT OR REPLACE INTO merchants (id, name, api_key_hash, webhook_secret, active) VALUES (?, ?, ?, ?, ?)",
		args: ["merch_disabled", "Disabled Merchant", disabledHash, "whsec_disabled", 0],
	});
});

afterAll(() => {
	db.close();
});

async function callAuth(apiKey?: string, adminKey?: string): Promise<{
	status: number;
	body: Record<string, unknown>;
	merchantId?: string;
	merchantName?: string;
	merchantPlan?: string;
}> {
	const app = new Hono();
	let captured: Record<string, unknown> = {};

	app.use("*", authMiddleware);
	app.get("/test", (c) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ctx = c as any;
		captured = {
			merchantId: ctx.get("merchantId"),
			merchantName: ctx.get("merchantName"),
			merchantPlan: ctx.get("merchantPlan"),
		};
		return c.json({ success: true });
	});

	const req = new Request("http://localhost/test", {
		headers: {
			...(apiKey ? { "X-API-Key": apiKey } : {}),
			...(adminKey ? { "X-Admin-Key": adminKey } : {}),
		},
	});
	const res = await app.fetch(req);
	const body = await res.json() as Record<string, unknown>;
	return { status: res.status, body, ...captured };
}

describe("authMiddleware", () => {
	test("returns 401 when API key is missing", async () => {
		const { status, body } = await callAuth();
		expect(status).toBe(401);
		expect(body.success).toBe(false);
	});

	test("returns 401 when API key is invalid", async () => {
		const { status, body } = await callAuth("bad-key");
		expect(status).toBe(401);
		expect(body.success).toBe(false);
	});

	test("authenticates with valid merchant API key", async () => {
		const res = await callAuth("valid-merchant-key");
		expect(res.status).toBe(200);
		expect(res.merchantId).toBe("merch_test");
		expect(res.merchantName).toBe("Test Merchant");
		expect(res.merchantPlan).toBe("free");
	});

	test("rejects disabled merchant with 403", async () => {
		const { status, body } = await callAuth("disabled-merchant-key");
		expect(status).toBe(403);
		expect(body.success).toBe(false);
	});

	test("falls back to env API_KEY when merchant not found", async () => {
		const res = await callAuth("test-api-key-auth");
		expect(res.status).toBe(200);
		expect(res.merchantId).toBe("merch_default");
		expect(res.merchantName).toBe("Default");
		expect(res.merchantPlan).toBe("free");
	});

	test("skips merchant auth when admin key is present and no API key", async () => {
		const res = await callAuth(undefined, "test-admin-key-auth");
		expect(res.status).toBe(200);
	});
});
