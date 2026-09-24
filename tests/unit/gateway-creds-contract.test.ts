/**
 * Merchant gateway credential contract tests.
 *
 * Closes the write-time validation gap: the SET route must reject
 * (400) credentials for platform-owned gateways (paypal/telegram/x402/
 * erc8183 treasury identity) and unknown credential keys that would never
 * be read by resolveGatewayConfig (dead-on-write).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { MERCHANT_CREDENTIAL_KEYS, resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-gwcontract-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-gwcontract";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-gwcontract";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;
let mKey = "";

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	mKey = "gwcontract-key";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_gwcon", "GW Contract", sha256Hash(mKey), "sec_gw"],
	});
	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("merchant credential key contract", () => {
	test("contract covers the 8 merchant-credential gateways", () => {
		expect(Object.keys(MERCHANT_CREDENTIAL_KEYS).sort()).toEqual([
			"duitku",
			"ipaymu",
			"midtrans",
			"nowpayments",
			"saweria",
			"scalev",
			"tripay",
			"xendit",
		]);
	});

	test("platform-owned gateways have NO contract entry", () => {
		for (const g of ["paypal", "telegram_stars", "telegram_payments", "x402", "erc8183"]) {
			expect(MERCHANT_CREDENTIAL_KEYS[g]).toBeUndefined();
		}
	});
});

describe("PUT /api/merchants/:id/gateways/:gateway (SET validation)", () => {
	test("rejects creds for platform-owned gateway (400)", async () => {
		const res = await app.request("/api/merchants/merch_gwcon/gateways/paypal", {
			method: "PUT",
			headers: { "X-API-Key": mKey, "Content-Type": "application/json" },
			body: JSON.stringify({ credentials: { clientId: "x" } }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe("INVALID_GATEWAY");
	});

	test("rejects unknown credential keys (400)", async () => {
		const res = await app.request("/api/merchants/merch_gwcon/gateways/midtrans", {
			method: "PUT",
			headers: { "X-API-Key": mKey, "Content-Type": "application/json" },
			body: JSON.stringify({ credentials: { apiKey: "k", bogus: "x" } }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe("INVALID_CREDENTIALS");
		expect(body.error.message).toContain("bogus");
	});

	test("accepts exact contract keys (200) and omits secrets", async () => {
		const res = await app.request("/api/merchants/merch_gwcon/gateways/midtrans", {
			method: "PUT",
			headers: { "X-API-Key": mKey, "Content-Type": "application/json" },
			body: JSON.stringify({ credentials: { apiKey: "merchant-mt-key" } }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(JSON.stringify(body)).not.toContain("merchant-mt-key");
	});

	test("rejects cross-merchant write (403)", async () => {
		const res = await app.request("/api/merchants/merch_other/gateways/midtrans", {
			method: "PUT",
			headers: { "X-API-Key": mKey, "Content-Type": "application/json" },
			body: JSON.stringify({ credentials: { apiKey: "k" } }),
		});
		expect(res.status).toBe(403);
	});
});

describe("GET /api/merchants/:id/gateways (Sweep146 read isolation)", () => {
	test("rejects cross-merchant read (403, before any DB lookup)", async () => {
		const res = await app.request("/api/merchants/merch_other/gateways", {
			headers: { "X-API-Key": mKey },
		});
		expect(res.status).toBe(403);
	});

	test("own list never exposes stored credentials", async () => {
		const res = await app.request("/api/merchants/merch_gwcon/gateways", {
			headers: { "X-API-Key": mKey },
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain("merchant-mt-key");
		expect(text).not.toContain("credentials");
	});
});
