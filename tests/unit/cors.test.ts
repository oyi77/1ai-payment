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
