/**
 * Parked gateways must never look available.
 *
 * Scalev stays registered (webhook + fulfillment + stored credentials keep
 * working) but cannot take new payments while its business plan is inactive:
 * every storefront route returns 404 "Store not found". The failure mode this
 * guards against is silent drift — the gateway is unusable yet still listed as
 * enabled, still counted in /health, and still reachable through
 * POST /api/payments with an error that reads like a retryable upstream blip.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getDb, initDatabase } from "../../src/config/database";
import { PARKED_GATEWAYS, getGateway, getGatewayNames } from "../../src/gateways";
import { paymentRoutes } from "../../src/routes/payment";
import {
	getGatewayHealth,
	getGatewayMethods,
	getSelectableGateways,
} from "../../src/services/gateway.service";
import { sha256Hash } from "../../src/utils/crypto";

const TEST_DB = join(tmpdir(), `1pay-parked-${Date.now()}.db`);
const API_KEY = "parked-gateway-test-key";

process.env.API_KEY = API_KEY;
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "parked-admin-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
// Give Scalev every credential it asks for: parking must win over
// configuration, not depend on the credentials being absent.
process.env.SCALEV_STOREFRONT_API_KEY = "sfpk_parked_test";
process.env.SCALEV_STORE_ID = "store_parked_test";
process.env.SCALEV_VARIANT_ID = "123";
process.env.SCALEV_WEBHOOK_SECRET = "sk_parked_test";

let app: Hono;

beforeAll(async () => {
	await initDatabase();
	// initDatabase() already seeds a merchant from API_KEY with the same
	// hash, so this only adds a distinct row when the seed differs.
	await getDb().execute({
		sql: "INSERT OR IGNORE INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_parked", "parked", sha256Hash(API_KEY), "sec_parked"],
	});
	app = new Hono();
	app.route("/api", paymentRoutes);
});

afterAll(() => {
	getDb().close();
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("parked gateway visibility", () => {
	test("stays registered so existing webhooks and credentials keep resolving", () => {
		expect(getGatewayNames()).toContain("scalev");
		expect(getGateway("scalev")).toBeDefined();
		expect(PARKED_GATEWAYS.scalev).toBeTruthy();
	});

	test("is never reported as configured by /health, even with full credentials", () => {
		expect(getGatewayHealth().scalev?.configured).toBe(false);
	});

	test("is omitted from the selectable gateway list", () => {
		const names = getSelectableGateways().map((g) => g.gateway);
		expect(names).not.toContain("scalev");
		// The rest of the catalogue is unaffected.
		expect(names).toContain("midtrans");
		expect(names.length).toBe(getGatewayNames().length - 1);
	});

	test("methods lookup reports it disabled rather than available", () => {
		const info = getGatewayMethods("scalev");
		expect(info?.enabled).toBe(false);
	});
});

describe("parked gateway payment creation", () => {
	test("returns 422 GATEWAY_UNAVAILABLE with the operator message", async () => {
		const res = await app.request("/api/payments", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
			body: JSON.stringify({
				gateway: "scalev",
				amount: 99000,
				currency: "IDR",
				callback_url: "https://example.com/callback",
			}),
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as {
			success: boolean;
			error: { code: string; message: string };
		};
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("GATEWAY_UNAVAILABLE");
		// Must not read like a retryable upstream failure.
		expect(body.error.message).toContain("business plan");
	});

	test("leaves no order row behind", async () => {
		const rows = await getDb().execute({
			sql: "SELECT COUNT(*) AS n FROM orders WHERE gateway = 'scalev'",
		});
		expect(Number(rows.rows[0].n)).toBe(0);
	});
});
