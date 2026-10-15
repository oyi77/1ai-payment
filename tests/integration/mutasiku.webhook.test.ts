/**
 * Integration tests for POST /webhook/mutasiku — bank-mutation fanout.
 *
 * Exercises the mutation path end to end against a fresh temp SQLite DB:
 * - a signed Mutasiku webhook for a merchant with the aggregator enabled
 *   returns 200 and forwards to that merchant's callback URL
 * - an unsigned webhook is rejected with 401 and nothing is forwarded
 * - a merchant without the aggregator enabled receives no forward
 *
 * Env-before-config ordering: dynamic imports in beforeAll run after the
 * module-scope env assignments, so getConfig() inside lazily-evaluated
 * gateway methods picks up the test secrets. Static imports would eagerly
 * initialize the config singleton before env is assigned.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const TEST_DB = join(tmpdir(), `1pay-mutasiku-wh-${Date.now()}.db`);
const P2P_SECRET = "whsec_merchant_mutasi_test";
const MUTASI_SECRET = "whsec_mutasiku_upstream_test";

process.env.API_KEY = "test-api-key-mutasiwh";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-mutasiwh";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.MOOTA_WEBHOOK_SECRET = MUTASI_SECRET;

let app: import("hono").Hono;

interface CallbackCapture {
	url: string;
	headers: Record<string, string>;
	body: string;
}

function makeCallbackFetch(store: CallbackCapture[]): typeof fetch {
	return ((url: unknown, init?: RequestInit) => {
		store.push({
			url: String(url),
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(
					([k, v]) => [k.toLowerCase(), String(v)],
				),
			),
			body: String(init?.body ?? ""),
		});
		return Promise.resolve(new Response("ok", { status: 200 }));
	}) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

function signMutasiku(body: unknown): string {
	const compact = JSON.stringify(body, Object.keys(body as object).sort());
	return createHmac("sha256", MUTASI_SECRET).update(compact).digest("hex");
}

async function merchantDeliveryCount(merchantId: string): Promise<number> {
	const { getDb } = await import("../../src/config/database");
	const r = await getDb().execute({
		sql: "SELECT COUNT(*) AS n FROM mutation_deliveries WHERE merchant_id = ?",
		args: [merchantId],
	});
	return Number((r.rows[0] as Record<string, unknown>).n);
}

beforeAll(async () => {
	const { initDatabase, getDb } = await import("../../src/config/database");
	const { Hono } = await import("hono");
	const { sha256Hash, encryptWebhookSecret, encrypt } = await import(
		"../../src/utils/crypto"
	);
	const { webhookRoutes } = await import("../../src/routes/webhook");

	await initDatabase();
	const db = getDb();

	// MP2P-style merchant: aggregator enabled, callback + secret configured
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active, default_callback_url) VALUES (?, ?, ?, ?, 1, ?)",
		args: [
			"merch_mutasi",
			"MP2P Mutasi",
			sha256Hash("mutasi-key"),
			encryptWebhookSecret(P2P_SECRET),
			"https://cb.example.com/mutasi",
		],
	});
	await db.execute({
		sql: "INSERT INTO merchant_gateways (merchant_id, gateway, enabled, credentials) VALUES (?, 'mutasiku', 1, ?)",
		args: ["merch_mutasi", encrypt(JSON.stringify({ apiKey: "mut-api", webhookSecret: MUTASI_SECRET }))],
	});

	// A merchant that never enabled the aggregator — must not receive fanout
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active, default_callback_url) VALUES (?, ?, ?, ?, 1, ?)",
		args: [
			"merch_other",
			"Other",
			sha256Hash("other-key"),
			encryptWebhookSecret("whsec_other"),
			"https://cb.example.com/other",
		],
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

describe("POST /webhook/mutasiku (mutation fanout)", () => {
	test("signed mutation forwards to the enabled merchant with its own secret", async () => {
		const captures: CallbackCapture[] = [];
		globalThis.fetch = makeCallbackFetch(captures);

		const mutation = {
			id: "mut-e2e-1",
			nominal: 150000,
			jenis: "kredit",
			keterangan: "TRSF MP2P-ABC123",
			senderName: "Pembeli",
			bank: "BCA",
			rekening: "0580771556",
			tanggal: "2026-01-15",
		};
		const res = await app.request("/webhook/mutasiku", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-webhook-signature": signMutasiku(mutation),
			},
			body: JSON.stringify(mutation),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		// Exactly one forward: to merch_mutasi, not to merch_other
		expect(captures.length).toBe(1);
		expect(captures[0].url).toBe("https://cb.example.com/mutasi");
		const fwd = JSON.parse(captures[0].body);
		expect(fwd.gateway).toBe("mutasiku");
		expect(fwd.reference).toBe("mut-e2e-1");
		expect(fwd.amount).toBe(150000);
		expect(fwd.direction).toBe("CR");
		// Per-merchant signing: verifiable with the merchant's own secret
		const expected = createHmac("sha256", P2P_SECRET)
			.update(captures[0].body)
			.digest("hex");
		expect(captures[0].headers["x-mutation-signature"]).toBe(expected);

		// Delivery row persisted for audit/replay
		expect(await merchantDeliveryCount("merch_mutasi")).toBe(1);
		expect(await merchantDeliveryCount("merch_other")).toBe(0);
	});

	test("unsigned webhook is rejected, nothing forwarded", async () => {
		const captures: CallbackCapture[] = [];
		globalThis.fetch = makeCallbackFetch(captures);

		const mutation = { id: "mut-e2e-2", nominal: 5000, jenis: "kredit" };
		const res = await app.request("/webhook/mutasiku", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(mutation),
		});
		expect(res.status).toBe(401);
		expect(captures.length).toBe(0);
	});
});
