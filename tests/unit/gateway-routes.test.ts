/**
 * Route-level tests for gateway listing endpoints.
 *
 * GET /api/gateways and GET /api/gateways/:gateway/methods — pure service
 * lookups behind merchant auth. Uses the env API_KEY fallback (no merchant
 * row needed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-gw-route-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-gwroute";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-gwroute";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase } from "../../src/config/database";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;

beforeAll(async () => {
	await initDatabase();
	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		rmSync(TEST_DB);
	} catch {}
});

const AUTH = { "X-API-Key": "test-api-key-gwroute" };

describe("GET /api/gateways (route)", () => {
	test("lists all registered gateways with methods", async () => {
		const res = await app.request("/api/gateways", { headers: AUTH });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
		// All 13 gateways present
		const names = body.data.map((g: { gateway: string }) => g.gateway);
		expect(names).toContain("midtrans");
		expect(names).toContain("tripay");
		expect(names).toContain("saweria");
		expect(names.length).toBeGreaterThanOrEqual(13);
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/gateways");
		expect(res.status).toBe(401);
	});
});

describe("GET /api/gateways/:gateway/methods (route)", () => {
	test("returns methods for a known gateway", async () => {
		const res = await app.request("/api/gateways/midtrans/methods", {
			headers: AUTH,
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data).toHaveProperty("gateway");
		expect(body.data.gateway).toBe("midtrans");
		expect(Array.isArray(body.data.methods)).toBe(true);
		expect(body.data.methods.length).toBeGreaterThan(0);
		expect(body.data.methods[0]).toHaveProperty("code");
		expect(body.data.methods[0]).toHaveProperty("name");
	});

	test("returns 400 for unknown gateway (enum validation)", async () => {
		const res = await app.request("/api/gateways/nope/methods", {
			headers: AUTH,
		});
		expect(res.status).toBe(400);
	});

	test("returns 401 without API key", async () => {
		const res = await app.request("/api/gateways/midtrans/methods");
		expect(res.status).toBe(401);
	});
});
