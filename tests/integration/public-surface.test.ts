/**
 * Public-surface tests (Sweep150).
 *
 * Unauthenticated routes must not leak internals: uniform 404 envelope,
 * health exposes counts only (no per-gateway map — Sweep108), unknown
 * webhook gateways are rejected without echoing the input name, and
 * baseline security headers are present.
 *
 * Uses a fresh temp SQLite database per run. Env vars are set before any
 * module-level code runs (app is imported lazily in beforeAll).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-pubsurface-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-pubsurface";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-pubsurface";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

let app: { request: (input: string, init?: RequestInit) => Promise<Response> };

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

describe("public surface (Sweep150)", () => {
	test("unknown route returns the uniform 404 envelope", async () => {
		const res = await app.request("/nope-xyz-123");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			success: false,
			error: { code: "NOT_FOUND", message: "Route not found" },
		});
	});

	test("health exposes counts only, no per-gateway map", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(typeof body.gateways.configured).toBe("number");
		expect(typeof body.gateways.total).toBe("number");
		expect(Object.keys(body.gateways).sort()).toEqual([
			"configured",
			"total",
		]);
	});

	test("unknown webhook gateway rejected without echoing input", async () => {
		const res = await app.request("/webhook/fakegwzzz", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(501);
		const text = await res.text();
		expect(text).not.toContain("fakegwzzz");
	});

	test("baseline security headers present on public routes", async () => {
		const res = await app.request("/health");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
	});
});

describe("Content-Security-Policy (Sweep165)", () => {
	test("static pages carry the exfil-containment policy", async () => {
		for (const path of ["/", "/dashboard", "/payment/finish"]) {
			const res = await app.request(path);
			const csp = res.headers.get("content-security-policy") ?? "";
			expect(csp).toContain("connect-src 'self'");
			expect(csp).toContain("object-src 'none'");
			expect(csp).toContain("frame-ancestors 'self'");
			expect(csp).toContain("cdn.tailwindcss.com");
			expect(csp).not.toContain("jsdelivr");
		}
	});

	test("API and docs routes carry no CSP (untouched)", async () => {
		for (const path of ["/health", "/doc", "/reference"]) {
			const res = await app.request(path);
			expect(res.headers.get("content-security-policy")).toBeNull();
		}
	});
});
