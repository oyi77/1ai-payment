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
	CORS_ORIGIN: process.env.CORS_ORIGIN,
};

afterEach(() => {
	if (originalEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = originalEnv.NODE_ENV;
	if (originalEnv.REQUIRE_HTTPS === undefined) delete process.env.REQUIRE_HTTPS;
	else process.env.REQUIRE_HTTPS = originalEnv.REQUIRE_HTTPS;
	if (originalEnv.CORS_ORIGIN === undefined) delete process.env.CORS_ORIGIN;
	else process.env.CORS_ORIGIN = originalEnv.CORS_ORIGIN;
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

	test("accepts http URL when X-Forwarded-Proto is https AND TRUST_PROXY is set", () => {
		process.env.TRUST_PROXY = "true";
		resetConfigCache();
		try {
			expect(
				isHttpsRequest(
					"http://localhost:3100/webhook/midtrans",
					"https",
				),
			).toBe(true);
		} finally {
			delete process.env.TRUST_PROXY;
			resetConfigCache();
		}
	});

	test("rejects X-Forwarded-Proto https without TRUST_PROXY (spoofable chain)", () => {
		delete process.env.TRUST_PROXY;
		resetConfigCache();
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				"https",
			),
		).toBe(false);
	});

	test("rejects http URL when X-Forwarded-Proto is http", () => {
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				"http",
			),
		).toBe(false);
	});

	test("rejects http URL with no proxy headers at all", () => {
		expect(isHttpsRequest("http://localhost:3100/webhook/midtrans")).toBe(
			false,
		);
	});

	test("accepts https URL even with non-https X-Forwarded-Proto", () => {
		expect(
			isHttpsRequest("https://api.example.com/webhook/midtrans", "http"),
		).toBe(true);
	});

	test("honors chained X-Forwarded-Proto when TRUST_PROXY is set", () => {
		process.env.TRUST_PROXY = "true";
		resetConfigCache();
		try {
			expect(
				isHttpsRequest(
					"http://localhost:3100/webhook/midtrans",
					"https, http",
				),
			).toBe(true);
		} finally {
			delete process.env.TRUST_PROXY;
			resetConfigCache();
		}
	});

	test("CF-Visitor http beats spoofed X-Forwarded-Proto https", () => {
		delete process.env.TRUST_PROXY;
		resetConfigCache();
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				"https, https",
				'{"scheme":"http"}',
			),
		).toBe(false);
	});

	test("accepts CF-Visitor https scheme behind Cloudflare", () => {
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				undefined,
				'{"scheme":"https"}',
			),
		).toBe(true);
	});

	test("rejects CF-Visitor http scheme", () => {
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				undefined,
				'{"scheme":"http"}',
			),
		).toBe(false);
	});

	test("rejects malformed CF-Visitor header", () => {
		expect(
			isHttpsRequest(
				"http://localhost:3100/webhook/midtrans",
				undefined,
				"not-json",
			),
		).toBe(false);
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
		process.env.CORS_ORIGIN = "http://localhost:3100";
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
		process.env.CORS_ORIGIN = "http://localhost:3100";
		resetConfigCache();
		expect(getConfig().REQUIRE_HTTPS).toBe(false);
	});
});
