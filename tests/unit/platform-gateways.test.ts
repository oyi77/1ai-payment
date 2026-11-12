/**
 * Unit tests — Platform gateway service + admin CRUD routes.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = join(
	tmpdir(),
	`1pay-plat-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);
process.env.API_KEY = "test-api-key-plat";
process.env.ADMIN_API_KEY = "test-admin-key-plat";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.ADMIN_AUTH_EXPERIMENTAL = "false";

import { initDatabase } from "../../src/config/database";
import { getDb } from "../../src/config/database";
import { resetConfigCache } from "../../src/config/env";
import {
	SUPPORTED_PLATFORM_GATEWAYS,
	getPlatformGateway,
	isPlatformGateway,
} from "../../src/services/platform-gateway.service";

beforeEach(async () => {
	process.env.ADMIN_API_KEY = "test-admin-key-plat";
	resetConfigCache();
	await initDatabase();
	await getDb().execute("DELETE FROM platform_gateways");
});

afterEach(() => {
	resetConfigCache();
});

describe("SUPPORTED_PLATFORM_GATEWAYS", () => {
	test("has shopee and gopay", () => {
		expect(SUPPORTED_PLATFORM_GATEWAYS).toContain("shopee");
		expect(SUPPORTED_PLATFORM_GATEWAYS).toContain("gopay");
	});
});

describe("isPlatformGateway", () => {
	test("accepts supported gateways", () => {
		expect(isPlatformGateway("shopee")).toBe(true);
		expect(isPlatformGateway("gopay")).toBe(true);
	});
	test("rejects non-platform gateways", () => {
		expect(isPlatformGateway("midtrans")).toBe(false);
		expect(isPlatformGateway("unknown")).toBe(false);
		expect(isPlatformGateway("")).toBe(false);
	});
});

describe("getPlatformGateway", () => {
	test("returns null when nothing stored", async () => {
		const rec = await getPlatformGateway("shopee");
		expect(rec).toBeNull();
	});

	test("returns stored credentials after PUT", async () => {
		const db = getDb();
		const { encrypt } = await import("../../src/utils/crypto");
		const creds = { session: '{"foo":1}', staticQris: "000201010211..." };
		await db.execute({
			sql: `INSERT INTO platform_gateways (id, gateway, credentials, environment, enabled)
            VALUES ('pgw_shopee', 'shopee', ?, 'production', 1)`,
			args: [encrypt(JSON.stringify(creds))],
		});
		const rec = await getPlatformGateway("shopee");
		expect(rec).not.toBeNull();
		expect(rec?.gateway).toBe("shopee");
		expect(rec?.environment).toBe("production");
		expect(rec?.enabled).toBe(true);
		expect(rec?.credentials.session).toBe('{"foo":1}');
	});

	test("returns null when disabled", async () => {
		const db = getDb();
		const { encrypt } = await import("../../src/utils/crypto");
		await db.execute({
			sql: `INSERT INTO platform_gateways (id, gateway, credentials, environment, enabled)
            VALUES ('pgw_gopay', 'gopay', ?, 'sandbox', 0)`,
			args: [encrypt(JSON.stringify({ session: "x" }))],
		});
		const rec = await getPlatformGateway("gopay");
		expect(rec).toBeNull();
	});
});

describe("admin /api/admin/platform routes", () => {
	let BASE: string;
	let server: ReturnType<typeof Bun.serve>;

	beforeEach(async () => {
		process.env.ADMIN_API_KEY = "test-admin-key-plat";
		resetConfigCache();
		const { Hono } = await import("hono");
		const { platformGatewaysRouter } = await import(
			"../../src/routes/admin/platform-gateways"
		);
		const app = new Hono();
		app.route("/api/admin", platformGatewaysRouter);
		server = Bun.serve({ port: 0, fetch: app.fetch });
		BASE = `http://localhost:${server.port}/api/admin`;
	});

	afterEach(() => {
		server?.stop(true);
		resetConfigCache();
	});

	const ADMIN = { "X-Admin-Key": "test-admin-key-plat", "Content-Type": "application/json" };

	test("401 without admin key", async () => {
		const res = await fetch(`${BASE}/platform`);
		expect(res.status).toBe(401);
	});

	test("200 lists supported gateways", async () => {
		const res = await fetch(`${BASE}/platform`, { headers: ADMIN });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.success).toBe(true);
		expect(data.data.supported).toContain("shopee");
		expect(data.data.not_connected).toContain("shopee");
	});

	test("PUT upserts credentials and returns masked", async () => {
		const res = await fetch(`${BASE}/platform/shopee`, {
			method: "PUT",
			headers: ADMIN,
			body: JSON.stringify({
				credentials: { session: '{"token":"abc"}', staticQris: "000201010211" },
				environment: "production",
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.success).toBe(true);
		// Session masked (length only), staticQris truncated but not empty.
		expect(data.data.credentials.session).toMatch(/^<\d+ chars>$/);
		expect(data.data.credentials.staticQris).toMatch(/^000201010211/);

		// Persisted.
		const rec = await getPlatformGateway("shopee");
		expect(rec?.credentials.session).toBe('{"token":"abc"}');
	});

	test("PATCH toggles enabled", async () => {
		await fetch(`${BASE}/platform/gopay`, {
			method: "PUT",
			headers: ADMIN,
			body: JSON.stringify({ credentials: { session: "{}" } }),
		});
		const res = await fetch(`${BASE}/platform/gopay`, {
			method: "PATCH",
			headers: ADMIN,
			body: JSON.stringify({ enabled: false }),
		});
		expect(res.status).toBe(200);
		const rec = await getPlatformGateway("gopay");
		expect(rec).toBeNull(); // disabled → filtered out
	});

	test("DELETE removes connection", async () => {
		await fetch(`${BASE}/platform/gopay`, {
			method: "PUT",
			headers: ADMIN,
			body: JSON.stringify({ credentials: { session: "{}" } }),
		});
		const res = await fetch(`${BASE}/platform/gopay`, {
			method: "DELETE",
			headers: ADMIN,
		});
		expect(res.status).toBe(200);
		const rec = await getPlatformGateway("gopay");
		expect(rec).toBeNull();
	});

	test("400 on unsupported gateway", async () => {
		const res = await fetch(`${BASE}/platform/midtrans`, { headers: ADMIN });
		expect(res.status).toBe(400);
	});

	test("POST OTP endpoints disabled without experimental flag", async () => {
		const res = await fetch(`${BASE}/platform/shopee/otp/start`, {
			method: "POST",
			headers: ADMIN,
			body: JSON.stringify({ phone: "081234567890" }),
		});
		expect(res.status).toBe(403);
		const data = await res.json();
		expect(data.error.code).toBe("FEATURE_DISABLED");
	});
});

describe("resolveSession priority", () => {
	test("platform_gateways wins over env fallback", async () => {
		process.env.SHOPEE_SESSION_JSON = "env-session";
		resetConfigCache();
		const db = getDb();
		const { encrypt } = await import("../../src/utils/crypto");
		await db.execute({
			sql: `INSERT INTO platform_gateways (id, gateway, credentials, environment, enabled)
            VALUES ('pgw_shopee', 'shopee', ?, 'production', 1)`,
			args: [encrypt(JSON.stringify({ session: "platform-session" }))],
		});
		const { resolveSession } = await import(
			"../../src/services/platform-gateway.service"
		);
		const session = await resolveSession("shopee");
		expect(session).toBe("platform-session");
	});
});