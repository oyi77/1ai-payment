/**
 * Route-level tests for saved payment methods API.
 * Exercises the real app via app.request(): auth, CRUD, cross-merchant
 * isolation, and gateway_token non-leak at the HTTP boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-sm-route-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-smroute";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-smroute";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;
let merchantAKey = "";
let merchantBKey = "";

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	// Two merchants with known API keys
	merchantAKey = "sm-route-key-a";
	merchantBKey = "sm-route-key-b";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_route_a", "Route A", sha256Hash(merchantAKey), "sec_a"],
	});
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_route_b", "Route B", sha256Hash(merchantBKey), "sec_b"],
	});

	// Import app AFTER db init (app boot calls getConfig only, safe)
	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

const VALID_BODY = {
	gateway: "midtrans",
	method_code: "card",
	method_name: "BCA Visa",
	gateway_token: "tok_route_secret",
	masked_identifier: "•••• 4242",
	expires_at: "2027-07-06T10:00:00.000Z",
};

describe("POST /api/saved-methods (route)", () => {
	test("creates method and returns 201 with NO gateway_token", async () => {
		const res = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify(VALID_BODY),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.id).toBeString();
		expect(body.data.method_name).toBe("BCA Visa");
		expect(body.data).not.toHaveProperty("gateway_token");
		expect(JSON.stringify(body)).not.toContain("tok_route_secret");
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(VALID_BODY),
		});
		expect(res.status).toBe(401);
	});

	test("returns 401 with wrong API key", async () => {
		const res = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": "wrong-key", "Content-Type": "application/json" },
			body: JSON.stringify(VALID_BODY),
		});
		expect(res.status).toBe(401);
	});

	test("returns 400 for invalid gateway", async () => {
		const res = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway: "nope" }),
		});
		expect(res.status).toBe(400);
	});

	test("idempotent: same key+gateway+token returns same id on 201", async () => {
		const res1 = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway_token: "tok_idem" }),
		});
		const res2 = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway_token: "tok_idem" }),
		});
		expect(res1.status).toBe(201);
		expect(res2.status).toBe(201);
		const b1 = await res1.json();
		const b2 = await res2.json();
		expect(b1.data.id).toBe(b2.data.id);
	});
});

describe("GET /api/saved-methods (route)", () => {
	test("lists only own methods", async () => {
		const res = await app.request("/api/saved-methods", {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		// None of A's methods leak B's token
		expect(JSON.stringify(body)).not.toContain("tok_route_secret_b");
	});

	test("GET single returns 404 for other merchant's method (isolation)", async () => {
		// Create a method as B
		const bRes = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantBKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway_token: "tok_route_secret_b" }),
		});
		const bBody = await bRes.json();
		const bMethodId = bBody.data.id;

		// A cannot see it
		const res = await app.request(`/api/saved-methods/${bMethodId}`, {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(404);

		// B can
		const resB = await app.request(`/api/saved-methods/${bMethodId}`, {
			headers: { "X-API-Key": merchantBKey },
		});
		expect(resB.status).toBe(200);
	});
});

describe("PATCH /api/saved-methods/:methodId (route)", () => {
	test("updates own method", async () => {
		const createRes = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway_token: "tok_patch_route" }),
		});
		const { data } = await createRes.json();

		const res = await app.request(`/api/saved-methods/${data.id}`, {
			method: "PATCH",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ method_name: "Renamed" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.method_name).toBe("Renamed");
	});

	test("returns 404 patching other merchant's method", async () => {
		const createRes = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantBKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway_token: "tok_patch_b" }),
		});
		const { data } = await createRes.json();

		const res = await app.request(`/api/saved-methods/${data.id}`, {
			method: "PATCH",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ method_name: "Hacked" }),
		});
		expect(res.status).toBe(404);
	});
});

describe("DELETE /api/saved-methods/:methodId (route)", () => {
	test("deletes own method (204)", async () => {
		const createRes = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantAKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway_token: "tok_del_route" }),
		});
		const { data } = await createRes.json();

		const res = await app.request(`/api/saved-methods/${data.id}`, {
			method: "DELETE",
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(204);

		// Gone
		const getRes = await app.request(`/api/saved-methods/${data.id}`, {
			headers: { "X-API-Key": merchantAKey },
		});
		expect(getRes.status).toBe(404);
	});

	test("cannot delete other merchant's method (404)", async () => {
		const createRes = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": merchantBKey, "Content-Type": "application/json" },
			body: JSON.stringify({ ...VALID_BODY, gateway_token: "tok_del_b" }),
		});
		const { data } = await createRes.json();

		const res = await app.request(`/api/saved-methods/${data.id}`, {
			method: "DELETE",
			headers: { "X-API-Key": merchantAKey },
		});
		expect(res.status).toBe(404);
	});
});
