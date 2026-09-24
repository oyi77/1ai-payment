/**
 * Body-size guard (Sweep76): Hono/Bun parse bodies unbounded, and webhooks
 * store raw bodies — a 100MB POST is a DoS vector. Two layers:
 * 1. bodyLimitMiddleware → 413 on declared Content-Length > 1MB (pre-auth).
 * 2. readCappedText → stream-level abort for chunked/lying clients.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-bodylimit-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-bodylimit";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-bodylimit";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase } from "../../src/config/database";
import type { app as AppType } from "../../src/app";
import { MAX_BODY_BYTES } from "../../src/middleware/body-limit";

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

describe("bodyLimitMiddleware routes", () => {
	test("declared Content-Length > cap → 413 pre-auth (no key needed)", async () => {
		const res = await app.request("/api/payments", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"content-length": String(MAX_BODY_BYTES + 1),
			},
			body: JSON.stringify({
				gateway: "midtrans",
				amount: 1,
				callback_url: "https://example.com/cb",
			}),
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as {
			success: boolean;
			error: { code: string };
		};
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("valid-JSON giant webhook body → 413 from capped read (pre-verify)", async () => {
		// Capped read runs before signature verification: no HMAC needed.
		const res = await app.request("/webhook/midtrans", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pad: "w".repeat(MAX_BODY_BYTES) }),
		});
		expect(res.status).toBe(413);
	});

	test("normal bodies unaffected (health 200)", async () => {
		const res = await app.request("/health");
		expect(res.status).toBe(200);
	});

	test("health exposes gateway counts, not per-gateway map (Sweep108)", async () => {
		const { getGatewayNames } = await import("../../src/gateways");
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			gateways: { configured: number; total: number };
		};
		expect(body.status).toBe("ok");
		expect(body.gateways.total).toBe(getGatewayNames().length);
		expect(body.gateways.configured).toBeGreaterThanOrEqual(0);
		expect(body.gateways.configured).toBeLessThanOrEqual(body.gateways.total);
		expect(JSON.stringify(body.gateways)).not.toContain("missing_key");
	});

	test("CORS wired: preflight on /api/* returns ACAO (test env wildcard)", async () => {
		const res = await app.request("/api/payments", {
			method: "OPTIONS",
			headers: {
				Origin: "https://evil.example",
				"Access-Control-Request-Method": "POST",
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	test("CORS scoped: preflight off /api/* carries no ACAO", async () => {
		const res = await app.request("/health", {
			method: "OPTIONS",
			headers: {
				Origin: "https://evil.example",
				"Access-Control-Request-Method": "GET",
			},
		});
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});
