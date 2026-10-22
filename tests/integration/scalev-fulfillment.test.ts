/**
 * Scalev webhook route — API-created order fulfillment.
 *
 * Regression pin for two defects found by replaying a REAL Scalev payload
 * (captured from webhook_events, order gp19d-JQcPnnC3r6G3FcG):
 *
 *   1. Scalev sends `status: "paid"` and no `items` array. The fulfillment
 *      gate only accepted our normalized "success", so every real Scalev
 *      payment was rejected before variant resolution.
 *   2. The variant lives in the merchant's order metadata, but the route
 *      handed handleNexusPayment the raw body only — so even past the status
 *      gate the product could never be identified.
 *
 * This test drives the actual route, which is the only place both bugs live.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { Hono } from "hono";
import { resetConfigCache } from "../../src/config/env";
import { getDb, initDatabase } from "../../src/config/database";
import { webhookRoutes } from "../../src/routes/webhook";
import { resetVariantMap } from "../../src/services/nexus-config";
import { encryptWebhookSecret } from "../../src/utils/crypto";

const TEST_DB = join(tmpdir(), `1pay-scalev-route-${Date.now()}.db`);
const MERCHANT_SECRET = "whsec_scalev_merchant_test";
const SCALEV_SECRET = "scalev_webhook_secret_test";

process.env.API_KEY = "test-api-key-scalevroute";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-scalevroute";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.SCALEV_WEBHOOK_SECRET = SCALEV_SECRET;
delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.NEXUS_TELEGRAM_CHANNEL_ID;
resetConfigCache();
resetVariantMap();

let app: Hono;
let db: Client;

const originalFetch = globalThis.fetch;

/** Verbatim production payload; only `id`/`notes` vary per test. */
const REAL_SCALEV_WEBHOOK = {
	id: "019fd841-73e0-705b-9ce9-a61b4ff90676",
	secret_slug: "e2e123456789",
	status: "paid",
	total_amount: 149000,
	currency: "IDR",
	payment_method: "qris",
	paid_at: "2026-08-06T18:07:00+07:00",
	created_at: "2026-08-06T18:06:36+07:00",
	notes: "1ai-payment:gp19d-JQcPnnC3r6G3FcG",
};

async function postScalev(body: unknown) {
	const raw = JSON.stringify(body);
	const signature = createHmac("sha256", SCALEV_SECRET)
		.update(raw)
		.digest("hex");
	return app.request("/webhook/scalev", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Scalev-Signature": signature,
			// The route rejects non-TLS webhooks; this marks the request as
			// having arrived over HTTPS.
			"X-Forwarded-Proto": "https",
		},
		body: raw,
	});
}

async function seedOrder(
	orderId: string,
	gatewayRef: string,
	metadata: Record<string, unknown>,
) {
	await db.execute({
		sql: `INSERT INTO orders (id, merchant_id, project_id, project_order_id, callback_url,
			gateway, gateway_reference, amount, currency, payment_method, status, metadata,
			created_at, updated_at)
			VALUES (?, 'merch_scalev', 'merch_scalev', ?, ?, 'scalev', ?, 149000, 'IDR', 'qris', 'pending', ?, datetime('now'), datetime('now'))`,
		args: [
			orderId,
			`proj-${orderId}`,
			"https://cb.example.com/scalev",
			gatewayRef,
			JSON.stringify(metadata),
		],
	});
}

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active, default_callback_url) VALUES (?, ?, ?, ?, 1, ?)",
		args: [
			"merch_scalev",
			"1ai-trade-cex",
			"hash_scalev",
			encryptWebhookSecret(MERCHANT_SECRET),
			"https://cb.example.com/scalev",
		],
	});

	app = new Hono();
	app.route("/webhook", webhookRoutes);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	db.close();
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("POST /webhook/scalev for an API-created order", () => {
	test("fulfills from order metadata even though Scalev sends no variant", async () => {
		// Block outbound forwards so the test never hits the network.
		globalThis.fetch = (async () =>
			new Response("ok", { status: 200 })) as unknown as typeof fetch;

		const orderId = `scv-route-${Date.now()}`;
		const gatewayRef = `019fd841-route-${Date.now()}`;
		await seedOrder(orderId, gatewayRef, { variant: "Bot Crypto" });

		const res = await postScalev({
			...REAL_SCALEV_WEBHOOK,
			id: gatewayRef,
			notes: `1ai-payment:${orderId}`,
		});
		expect(res.status).toBe(200);

		const subs = await db.execute({
			sql: "SELECT tier, scalev_order_id FROM nexus_subscriptions WHERE scalev_order_id = ?",
			args: [gatewayRef],
		});
		expect(subs.rows.length).toBe(1);
		expect(String(subs.rows[0].tier)).toBe("auto_bot");
	});

	test("without metadata the same payload cannot fulfill (no invented product)", async () => {
		globalThis.fetch = (async () =>
			new Response("ok", { status: 200 })) as unknown as typeof fetch;

		const orderId = `scv-route-nometa-${Date.now()}`;
		const gatewayRef = `019fd841-nometa-${Date.now()}`;
		await seedOrder(orderId, gatewayRef, {});

		const res = await postScalev({
			...REAL_SCALEV_WEBHOOK,
			id: gatewayRef,
			notes: `1ai-payment:${orderId}`,
		});
		expect(res.status).toBe(200);

		const subs = await db.execute({
			sql: "SELECT COUNT(*) AS n FROM nexus_subscriptions WHERE scalev_order_id = ?",
			args: [gatewayRef],
		});
		expect(Number(subs.rows[0].n)).toBe(0);
	});
});
