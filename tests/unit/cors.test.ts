/**
 * Unit tests for CORS origin hardening in getConfig().
 *
 * Production must never allow a wildcard '*' or empty CORS_ORIGIN on the
 * authenticated /api/* routes — that is P0 finding #002. Confirm the config
 * layer rejects it (server refuses to boot) and that an explicit origin passes
 * through. Dev/test remain lenient so local + CI keep working.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getConfig, resetConfigCache } from "../../src/config/env";

const SAVED = { ...process.env };

beforeEach(() => {
	// Start from a clean slate; each test sets what it needs.
	for (const k of Object.keys(process.env)) delete process.env[k];
	// Required vars so getConfig doesn't throw for unrelated reasons.
	process.env.API_KEY = "test-api-key";
	process.env.ADMIN_API_KEY = "test-admin-key";
	process.env.ENCRYPTION_KEY =
		"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
});

afterEach(() => {
	for (const k of Object.keys(process.env)) delete process.env[k];
	Object.assign(process.env, SAVED);
	resetConfigCache();
});

describe("CORS origin hardening (P0 #002)", () => {
	test("production with wildcard '*' is rejected", () => {
		process.env.NODE_ENV = "production";
		process.env.CORS_ORIGIN = "*";
		resetConfigCache();
		expect(() => getConfig()).toThrow(/CORS_ORIGIN/);
	});

	test("production with empty CORS_ORIGIN is rejected", () => {
		process.env.NODE_ENV = "production";
		process.env.CORS_ORIGIN = "";
		resetConfigCache();
		expect(() => getConfig()).toThrow(/CORS_ORIGIN/);
	});

	test("production with explicit origin is allowed and reflected", () => {
		process.env.NODE_ENV = "production";
		process.env.CORS_ORIGIN = "https://app.berkahkarya.org";
		resetConfigCache();
		const cfg = getConfig();
		expect(cfg.CORS_ORIGIN).toBe("https://app.berkahkarya.org");
	});

	test("development with wildcard '*' is allowed (local dev)", () => {
		process.env.NODE_ENV = "development";
		// CORS_ORIGIN unset -> default '*' in non-production
		resetConfigCache();
		const cfg = getConfig();
		expect(cfg.CORS_ORIGIN).toBe("*");
	});

	test("test env with wildcard '*' is allowed (CI)", () => {
		process.env.NODE_ENV = "test";
		resetConfigCache();
		const cfg = getConfig();
		expect(cfg.CORS_ORIGIN).toBe("*");
	});
});

describe("CORS preflight enforcement (Sweep156)", () => {
	// HTTP-level proof that the pinned origin is echoed and everything
	// else gets NO allow-origin header: evil, suffix-spoof, null, missing.
	async function preflight(origin?: string): Promise<Response> {
		process.env.NODE_ENV = "production";
		process.env.CORS_ORIGIN = "https://app.example.com";
		resetConfigCache();
		const { app } = await import("../../src/app");
		const headers: Record<string, string> = {
			"Access-Control-Request-Method": "GET",
			"Access-Control-Request-Headers": "X-API-Key",
		};
		if (origin !== undefined) headers.Origin = origin;
		return app.request("/api/gateways", { method: "OPTIONS", headers });
	}

	test("pinned origin is echoed", async () => {
		const res = await preflight("https://app.example.com");
		expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
	});

	test("evil origin gets no allow-origin", async () => {
		const res = await preflight("https://evil.example.com");
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("suffix-spoof origin gets no allow-origin", async () => {
		const res = await preflight("https://app.example.com.evil.com");
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("null and missing origins get no allow-origin", async () => {
		expect((await preflight("null")).headers.get("access-control-allow-origin")).toBeNull();
		expect((await preflight(undefined)).headers.get("access-control-allow-origin")).toBeNull();
	});
});
