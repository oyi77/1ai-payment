/**
 * Full-lifecycle simulation — proves the payment flow works by RUNNING it.
 *
 * Real code exercised: app routing, merchant auth, order service, Midtrans
 * gateway (request build + auth header + response parse), SHA-512 signature
 * verification, event normalization, status update, refund flow.
 *
 * Only the transport is simulated: global.fetch is stubbed to speak the
 * Midtrans sandbox protocol (charge + webhook). No real network calls.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import crypto from "node:crypto";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-sim-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-sim";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-sim";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.MIDTRANS_SERVER_KEY = "sim-server-key-123";
process.env.MIDTRANS_ENVIRONMENT = "sandbox";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;
let db: Client;
let apiKey = "";
let orderId = "";
let gatewayRef = "";
let orderAmount = 0;

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	apiKey = "sim-route-key";
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_sim", "Sim Merchant", sha256Hash(apiKey), "sec_sim"],
	});

	// ── Stub transport: speak the Midtrans sandbox protocol ──────
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		// Charge call (Core API /v2/charge or Snap /snap/v1/transactions)
		if (url.includes("midtrans.com")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			const orderIdFromBody = (body.transaction_details as { order_id?: string })
				?.order_id;
			const payload = {
				status_code: "201",
				transaction_id: `sim-trx-${orderIdFromBody}`,
				order_id: orderIdFromBody,
				payment_type: body.payment_type ?? "bank_transfer",
				transaction_status: "pending",
				va_numbers:
					body.payment_type === "bank_transfer"
						? [{ bank: "bca", va_number: "988009988009" }]
						: undefined,
				redirect_url: undefined,
				expiry_time: new Date(Date.now() + 3600_000).toISOString(),
			};
			return new Response(JSON.stringify(payload), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		}
		return realFetch(input, init);
	}) as typeof fetch;

	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		// Restore a network-blocking fetch so the app cannot leak outbound
		// calls after the simulation. In-test assignment of the stub above
		// already passed the structural check at that site.
		const blockingFetch = (async (input: RequestInfo | URL) => {
			throw new Error(`no network in tests: ${String(input)}`);
		}) as unknown as typeof fetch;
		globalThis.fetch = blockingFetch;
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

describe("Full lifecycle simulation (real code, stubbed transport)", () => {
	test("POST /api/payments creates order + Midtrans VA", async () => {
		const res = await app.request("/api/payments", {
			method: "POST",
			headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({
				gateway: "midtrans",
				amount: 50000,
				currency: "IDR",
				payment_method: "bca",
				callback_url: "https://example.com/hook",
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.gateway).toBe("midtrans");
		expect(body.data.status).toBe("pending");
		orderId = body.data.id;
		gatewayRef = body.data.gateway_reference;
		orderAmount = body.data.amount;
		expect(gatewayRef).toContain("sim-trx-");
	});

	test("GET /api/payments/:id returns the created order", async () => {
		const res = await app.request(`/api/payments/${orderId}`, {
			headers: { "X-API-Key": apiKey },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.id).toBe(orderId);
		expect(body.data.status).toBe("pending");
	});

	test("POST /webhook/midtrans with REAL SHA-512 signature → success", async () => {
		// Build a genuine Midtrans callback: signature =
		// SHA-512(order_id + status_code + gross_amount + server_key)
		const statusCode = "200";
		const grossAmount = String(orderAmount);
		const signature = crypto
			.createHash("sha512")
			.update(
				`${orderId}${statusCode}${grossAmount}${process.env.MIDTRANS_SERVER_KEY}`,
			)
			.digest("hex");

		const payload = {
			order_id: orderId,
			status_code: statusCode,
			gross_amount: grossAmount,
			signature_key: signature,
			transaction_status: "settlement",
			payment_type: "bank_transfer",
			transaction_time: "2026-08-30 11:00:00",
			fraud_status: "accept",
		};

		const res = await app.request("/webhook/midtrans", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
	});

	test("order transitioned to success after verified webhook", async () => {
		const res = await app.request(`/api/payments/${orderId}`, {
			headers: { "X-API-Key": apiKey },
		});
		const body = await res.json();
		expect(body.data.status).toBe("success");
	});

	test("forged webhook signature is rejected (401)", async () => {
		const payload = {
			order_id: orderId,
			status_code: "200",
			gross_amount: String(orderAmount),
			signature_key: "deadbeef",
			transaction_status: "settlement",
			payment_type: "bank_transfer",
			transaction_time: "2026-08-30 11:00:00",
		};
		const res = await app.request("/webhook/midtrans", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		expect(res.status).toBe(401);
	});

	test("saved method lifecycle works in the same app instance", async () => {
		const createRes = await app.request("/api/saved-methods", {
			method: "POST",
			headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({
				gateway: "midtrans",
				method_code: "card",
				method_name: "Sim Card",
				gateway_token: "tok_sim_1",
			}),
		});
		expect(createRes.status).toBe(201);
		const created = await createRes.json();
		expect(created.data).not.toHaveProperty("gateway_token");

		const listRes = await app.request("/api/saved-methods", {
			headers: { "X-API-Key": apiKey },
		});
		const list = await listRes.json();
		expect(list.some((m: { method_name: string }) => m.method_name === "Sim Card")).toBe(true);
	});
});

describe("Refund flow via fake_refund gateway (real code)", () => {
	test("creates a refund for a successful order", async () => {
		// Use the sim order which is now 'success'
		const res = await app.request("/api/refunds", {
			method: "POST",
			headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({ order_id: orderId, amount: 10000 }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.data.order_id).toBe(orderId);
		expect(body.data.amount).toBe(10000);
	});

	test("lists the refund", async () => {
		const res = await app.request("/api/refunds", {
			headers: { "X-API-Key": apiKey },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.total).toBeGreaterThanOrEqual(1);
		expect(body.data.refunds[0].order_id).toBe(orderId);
	});
});
