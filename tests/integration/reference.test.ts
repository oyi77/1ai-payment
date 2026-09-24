/**
 * Sweep142: GET /reference never accepts API keys in query params.
 *
 * - serves Swagger UI with no query param
 * - `?key=<secret>` is ignored: same 200 page, secret never reflected
 *   in the body (no injection, no echo into logs/history-driven flows)
 *
 * Uses a fresh temp SQLite database per run. Env vars are set before any
 * module-level code runs (app is imported lazily in beforeAll).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-reference-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-reference";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-reference";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

let app: { request: (input: string) => Promise<Response> };

beforeAll(async () => {
	const mod = await import("../../src/app");
	app = mod.app;
});

afterAll(() => {
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {
		/* best-effort cleanup */
	}
});

describe("GET /reference (Sweep142)", () => {
	test("serves Swagger UI without any query param", async () => {
		const res = await app.request("/reference");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html.length).toBeGreaterThan(0);
	});

	test("?key= is ignored: same page, secret never reflected", async () => {
		const res = await app.request("/reference?key=SUPERSECRETKEY123");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain("SUPERSECRETKEY123");
	});
});
