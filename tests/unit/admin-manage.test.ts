/**
 * Admin merchant management tests — list + plan/active update.
 *
 * Closes the coverage gap on the two oldest admin routes:
 * GET /api/admin/merchants and PATCH /api/admin/merchants/:id.
 * Proves auth gating (401), shape, plan change, disable/enable,
 * cross-tenant irrelevance (admin is out-of-band by design), and 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-admin-mgmt-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-adminmgmt";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-mgmt-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;

const ADMIN = { "X-Admin-Key": "test-admin-mgmt-key" };

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_adm_a", "Admin A", sha256Hash("adm-key-a"), "sec_a"],
	});
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_adm_b", "Admin B", sha256Hash("adm-key-b"), "sec_b"],
	});
	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("GET /api/admin/merchants (admin list)", () => {
	test("lists all merchants including seeded rows", async () => {
		const res = await app.request("/api/admin/merchants", { headers: ADMIN });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		const ids = body.data.merchants.map((m: { id: string }) => m.id);
		expect(ids).toContain("merch_adm_a");
		expect(ids).toContain("merch_adm_b");
		// No API key material in the response
		expect(JSON.stringify(body)).not.toContain("api_key_hash");
	});

	test("rejects without admin key", async () => {
		const res = await app.request("/api/admin/merchants");
		expect(res.status).toBe(401);
	});

	test("rejects wrong admin key", async () => {
		const res = await app.request("/api/admin/merchants", {
			headers: { "X-Admin-Key": "wrong" },
		});
		expect(res.status).toBe(401);
	});
});

describe("PATCH /api/admin/merchants/:id (admin update)", () => {
	test("changes plan free -> pro", async () => {
		const res = await app.request("/api/admin/merchants/merch_adm_a", {
			method: "PATCH",
			headers: { ...ADMIN, "Content-Type": "application/json" },
			body: JSON.stringify({ plan: "pro" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.merchant.plan).toBe("pro");
	});

	test("disables then re-enables merchant", async () => {
		const off = await app.request("/api/admin/merchants/merch_adm_b", {
			method: "PATCH",
			headers: { ...ADMIN, "Content-Type": "application/json" },
			body: JSON.stringify({ active: false }),
		});
		expect((await off.json()).data.merchant.active).toBe(false);

		// Disabled merchant's key is rejected with 403
		const blocked = await app.request("/api/gateways", {
			headers: { "X-API-Key": "adm-key-b" },
		});
		expect(blocked.status).toBe(403);

		const on = await app.request("/api/admin/merchants/merch_adm_b", {
			method: "PATCH",
			headers: { ...ADMIN, "Content-Type": "application/json" },
			body: JSON.stringify({ active: true }),
		});
		expect((await on.json()).data.merchant.active).toBe(true);
	});

	test("404 for unknown merchant", async () => {
		const res = await app.request("/api/admin/merchants/merch_nope", {
			method: "PATCH",
			headers: { ...ADMIN, "Content-Type": "application/json" },
			body: JSON.stringify({ plan: "pro" }),
		});
		expect(res.status).toBe(404);
	});

	test("400 for invalid body", async () => {
		const res = await app.request("/api/admin/merchants/merch_adm_a", {
			method: "PATCH",
			headers: { ...ADMIN, "Content-Type": "application/json" },
			body: JSON.stringify({ plan: "ultra" }),
		});
		expect(res.status).toBe(400);
	});

	test("rejects without admin key", async () => {
		const res = await app.request("/api/admin/merchants/merch_adm_a", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ plan: "pro" }),
		});
		expect(res.status).toBe(401);
	});
});
