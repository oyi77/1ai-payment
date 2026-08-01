/**
 * Unit tests for webhook HTTPS enforcement.
 *
 * Covers:
 * - isHttpsRequest: URL scheme + X-Forwarded-Proto handling
 * - REQUIRE_HTTPS env parsing and default (NODE_ENV === "production")
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getConfig, resetConfigCache } from "../../src/config/env";
import { isHttpsRequest } from "../../src/routes/webhook";

const originalEnv = {
	NODE_ENV: process.env.NODE_ENV,
	REQUIRE_HTTPS: process.env.REQUIRE_HTTPS,
};

afterEach(() => {
	if (originalEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = originalEnv.NODE_ENV;
	if (originalEnv.REQUIRE_HTTPS === undefined) delete process.env.REQUIRE_HTTPS;
	else process.env.REQUIRE_HTTPS = originalEnv.REQUIRE_HTTPS;
	resetConfigCache();
});

describe("isHttpsRequest", () => {
	test("accepts https URLs", () => {
		expect(isHttpsRequest("https://api.example.com/webhook/midtrans")).toBe(
			true,
		);
	});

	test("rejects plain http URLs", () => {
		expect(isHttpsRequest("http://api.example.com/webhook/midtrans")).toBe(
			false,
		);
	});

	test("accepts http URL when X-Forwarded-Proto is https", () => {
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				"https",
			),
		).toBe(true);
	});

	test("rejects http URL when X-Forwarded-Proto is http", () => {
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				"http",
			),
		).toBe(false);
	});

	test("rejects http URL with no X-Forwarded-Proto", () => {
		expect(isHttpsRequest("http://localhost:3100/webhook/midtrans")).toBe(
			false,
		);
	});

	test("accepts https URL even with non-https X-Forwarded-Proto", () => {
		expect(
			isHttpsRequest("https://api.example.com/webhook/midtrans", "http"),
		).toBe(true);
	});
});

describe("REQUIRE_HTTPS config", () => {
	test("defaults to false outside production", () => {
		process.env.NODE_ENV = "test";
		delete process.env.REQUIRE_HTTPS;
		resetConfigCache();
		expect(getConfig().REQUIRE_HTTPS).toBe(false);
	});

	test("defaults to true when NODE_ENV is production", () => {
		process.env.NODE_ENV = "production";
		delete process.env.REQUIRE_HTTPS;
		resetConfigCache();
		expect(getConfig().REQUIRE_HTTPS).toBe(true);
	});

	test("true is parsed from 'true'", () => {
		process.env.NODE_ENV = "test";
		process.env.REQUIRE_HTTPS = "true";
		resetConfigCache();
		expect(getConfig().REQUIRE_HTTPS).toBe(true);
	});

	test("true is parsed from '1' and 'yes'", () => {
		process.env.NODE_ENV = "test";
		for (const value of ["1", "yes"]) {
			process.env.REQUIRE_HTTPS = value;
			resetConfigCache();
			expect(getConfig().REQUIRE_HTTPS).toBe(true);
		}
	});

	test("explicit false overrides production default", () => {
		process.env.NODE_ENV = "production";
		process.env.REQUIRE_HTTPS = "false";
		resetConfigCache();
		expect(getConfig().REQUIRE_HTTPS).toBe(false);
	});
});
