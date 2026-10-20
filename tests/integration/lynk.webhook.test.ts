/**
 * Integration test for the direct Lynk.id checkout forwarding path.
 *
 * Regression pin: the unknown-order lynk branch forwards a synthetic order to
 * the enabled merchant. Its merchant lookup previously passed `{ sql }` with
 * no `args` to libsql — which throws at runtime ("Expected arguments") — so
 * every real Lynk sale silently failed to forward. The query is now passed as
 * a plain string. This test drives the webhook and asserts the forward fires.
 *
 * No wall-clock sleeps: the capture fetch resolves a deferred the moment the
 * forwarder calls it, so the assertion is bound to the real event.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = join(tmpdir(), `1pay-lynk-wh-${Date.now()}.db`);
const MERCHANT_SECRET = "whsec_lynk_merchant_test";
const LYNK_KEY = "lynk_merchant_key_test";

process.env.API_KEY = "test-api-key-lynkwh";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-lynkwh";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.LYNK_MERCHANT_KEY = LYNK_KEY;

let app: import("hono").Hono;

interface Captured {
	url: string;
	body: string;
}

const originalFetch = globalThis.fetch;

/**
 * Fetch stub that records the forward and resolves `firstCall` on invocation.
 */
function captureForward(store: Captured[]): {
	fetch: typeof fetch;
	firstCall: Promise<void>;
} {
	const { promise, resolve } = Promise.withResolvers<void>();
	const fetchImpl = ((url: unknown, init?: RequestInit) => {
		store.push({ url: String(url), body: String(init?.body ?? "") });
		resolve();
		return Promise.resolve(new Response("ok", { status: 200 }));
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, firstCall: promise };
}

beforeAll(async () => {
	const { initDatabase, getDb } = await import("../../src/config/database");
	const { Hono } = await import("hono");
	const { encrypt, encryptWebhookSecret } = await import("../../src/utils/crypto");
	const { webhookRoutes } = await import("../../src/routes/webhook");

	await initDatabase();
	const db = getDb();

	// Merchant with lynk enabled and a decryptable callback secret.
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active, default_callback_url) VALUES (?, ?, ?, ?, 1, ?)",
		args: [
			"merch_lynk",
			"1ai-trade-cex",
			"hash_lynk",
			encryptWebhookSecret(MERCHANT_SECRET),
			"https://cb.example.com/lynk",
		],
	});
	await db.execute({
		sql: "INSERT INTO merchant_gateways (merchant_id, gateway, enabled, credentials) VALUES (?, 'lynk', 1, ?)",
		args: ["merch_lynk", encrypt(JSON.stringify({ merchantKey: LYNK_KEY }))],
	});

	app = new Hono();
	app.route("/webhook", webhookRoutes);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe("POST /webhook/lynk (direct checkout forward)", () => {
	test("signed success for an unknown order forwards to the enabled merchant", async () => {
		const captures: Captured[] = [];
		const { fetch: stub, firstCall } = captureForward(captures);
		globalThis.fetch = stub;

		const body = JSON.stringify({
			order_number: "LYNK-DIRECT-1",
			status: "paid",
			amount: 254000,
			customer_name: "Budi",
			customer_email: "budi@example.com",
		});
		const signature = createHmac("sha256", LYNK_KEY).update(body).digest("hex");

		const res = await app.request("/webhook/lynk", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-signature": signature,
			},
			body,
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		// Await the actual forward, not a guessed duration.
		await firstCall;

		expect(captures.length).toBe(1);
		expect(captures[0].url).toBe("https://cb.example.com/lynk");
		const forwarded = JSON.parse(captures[0].body) as Record<string, unknown>;
		expect(forwarded.gateway).toBe("lynk");
		expect(forwarded.status).toBe("success");
		expect(forwarded.amount).toBe(254000);
	});

	test("unsigned lynk callback is rejected and schedules no forward", async () => {
		const captures: Captured[] = [];
		const { fetch: stub } = captureForward(captures);
		globalThis.fetch = stub;

		const res = await app.request("/webhook/lynk", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ order_number: "LYNK-DIRECT-2", status: "paid" }),
		});

		// The 401 path returns before any forward is scheduled — no wait needed.
		expect(res.status).toBe(401);
		expect(captures.length).toBe(0);
	});
});
