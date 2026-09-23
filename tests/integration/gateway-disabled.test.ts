/**
 * Disabled-gateway enforcement in payment creation.
 *
 * A merchant row with enabled=0 is an explicit opt-out ("this gateway is
 * off for me"), distinct from "never configured" (no row → platform
 * credentials apply). POST /api/payments must 403 GATEWAY_DISABLED before
 * creating any order — not silently fall back to platform creds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hash } from "../../src/utils/crypto";

const TEST_DB = join(tmpdir(), `1pay-gwdisabled-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-gwdisabled";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-gwdisabled";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.MIDTRANS_SERVER_KEY = "platform-mt-key-gwdisabled";

let app: import("hono").Hono;
let restoreMidtrans: () => void = () => {};

const A_KEY = "gwdisabled-key-a";
const B_KEY = "gwdisabled-key-b";
const H = (k: string) => ({
	"Content-Type": "application/json",
	"x-api-key": k,
});
const payBody = {
	gateway: "midtrans",
	amount: 10000,
	currency: "IDR",
	callback_url: "https://example.com/callback",
};

beforeAll(async () => {
	const { initDatabase, getDb } = await import("../../src/config/database");
	const { paymentRoutes } = await import("../../src/routes/payment");
	const { merchantRoutes } = await import("../../src/routes/merchant");
	const { Hono } = await import("hono");

	await initDatabase();
	const db = getDb();
	for (const [id, key] of [
		["merch_gwd_a", A_KEY],
		["merch_gwd_b", B_KEY],
	]) {
		await db.execute({
			sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
			args: [id, id, sha256Hash(key), `sec_${id}`],
		});
	}

	// Mock midtrans charge so no real API is hit
	const { getGateway: originalGetGateway } = await import(
		"../../src/gateways"
	);
	const midtransGw = originalGetGateway("midtrans");
	if (midtransGw) {
		const orig = midtransGw.createPayment.bind(midtransGw);
		midtransGw.createPayment = async () => ({
			gatewayReference: `trx_mock_${Date.now()}`,
			paymentUrl: "https://app.sandbox.midtrans.com/snap/v2/vtweb/mock",
			expiresAt: undefined,
		});
		restoreMidtrans = () => {
			midtransGw.createPayment = orig;
		};
	}

	app = new Hono();
	app.route("/api", paymentRoutes);
	app.route("/api", merchantRoutes);
});

afterAll(() => {
	restoreMidtrans();
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {}
});

describe("POST /api/payments with disabled gateway", () => {
	test("merchant with enabled=0 row gets 403 GATEWAY_DISABLED and no order", async () => {
		// SET creds (creates enabled=1 row), then disable it
		const set = await app.request("/api/merchants/merch_gwd_a/gateways/midtrans", {
			method: "PUT",
			headers: H(A_KEY),
			body: JSON.stringify({
				credentials: { apiKey: "merchant-mt-key" },
				environment: "sandbox",
			}),
		});
		expect(set.status).toBe(200);
		const off = await app.request(
			"/api/merchants/merch_gwd_a/gateways/midtrans",
			{
				method: "PATCH",
				headers: H(A_KEY),
				body: JSON.stringify({ enabled: false }),
			},
		);
		expect(off.status).toBe(200);

		const res = await app.request("/api/payments", {
			method: "POST",
			headers: H(A_KEY),
			body: JSON.stringify(payBody),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as {
			success: boolean;
			error: { code: string };
		};
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("GATEWAY_DISABLED");
	});

	test("merchant with no row still uses platform credentials (not 403)", async () => {
		const res = await app.request("/api/payments", {
			method: "POST",
			headers: H(B_KEY),
			body: JSON.stringify(payBody),
		});
		expect(res.status).not.toBe(403);
		expect(res.status).toBe(201);
	});

	test("re-enable restores payment creation (201)", async () => {
		const on = await app.request(
			"/api/merchants/merch_gwd_a/gateways/midtrans",
			{
				method: "PATCH",
				headers: H(A_KEY),
				body: JSON.stringify({ enabled: true }),
			},
		);
		expect(on.status).toBe(200);
		const res = await app.request("/api/payments", {
			method: "POST",
			headers: H(A_KEY),
			body: JSON.stringify(payBody),
		});
		expect(res.status).toBe(201);
	});
});
