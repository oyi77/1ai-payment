/**
 * Integration tests for POST /webhook/erc8183 — evaluator attestation flow.
 *
 * Exercises the escrow attestation webhook end to end against a fresh temp
 * SQLite database:
 * - a valid attestation signed by the configured evaluator marks the order
 *   success, records the webhook_events row, and forwards to the project
 * - an attestation signed by a stranger is rejected with 401 and the order
 *   stays pending
 *
 * The evaluator signs the canonical message
 * `JSON.stringify({ escrowId, evaluator, approved, notes })` exactly as
 * documented by the ERC-8183 gateway — the literal is replicated here so the
 * test stays independent of the implementation.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { resetConfigCache } from "../../src/config/env";
import type {
	CreateOrderParams,
	Order,
} from "../../src/services/order.service";

const TEST_DB = join(tmpdir(), `1pay-erc8183-webhook-${Date.now()}.db`);

// Evaluator account — the private key is only ever used inside this test.
const ercSigner = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);

const API_KEY = "test-key-erc8183";
const MERCHANT_ID = "merch_erc8183";
const TX_HASH = `0x${"aa".repeat(32)}`;

process.env.API_KEY = API_KEY;
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.ERC8183_EVALUATOR_ADDRESS = ercSigner.address;

resetConfigCache();

const originalFetch = globalThis.fetch;

let app: import("hono").Hono;
let createOrderFn: (params: CreateOrderParams) => Promise<Order>;

/**
 * Poll until `check` returns true or the timeout elapses. Used to observe the
 * fire-and-forget forward that the webhook triggers after returning 200.
 */
async function waitFor(
	check: () => boolean,
	timeoutMs = 2000,
	intervalMs = 10,
): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/**
 * The canonical message the evaluator signs for an attestation.
 * Must match src/gateways/erc8183/webhook.ts buildAttestationMessage exactly.
 */
function attestationMessage(
	escrowId: string,
	evaluator: string,
	approved: boolean,
): string {
	return JSON.stringify({
		escrowId,
		evaluator,
		approved,
		notes: null,
	});
}

beforeAll(async () => {
	const { initDatabase, getDb } = await import("../../src/config/database");
	const { webhookRoutes } = await import("../../src/routes/webhook");
	const { createOrder } = await import("../../src/services/order.service");
	const { sha256Hash } = await import("../../src/utils/crypto");
	const { Hono } = await import("hono");

	await initDatabase();
	const db = getDb();

	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active) VALUES (?, ?, ?, ?, 1)",
		// A distinct key string: the default merchant is seeded from env
		// API_KEY, so reusing it here would violate the api_key_hash UNIQUE.
		args: [MERCHANT_ID, "ERC8183", sha256Hash("erc8183-webhook-key"), "whsec_erc8183"],
	});

	createOrderFn = createOrder;
	app = new Hono();
	app.route("/webhook", webhookRoutes);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

async function createOrder(): Promise<Order> {
	return createOrderFn({
		project_id: MERCHANT_ID,
		merchant_id: MERCHANT_ID,
		callback_url: "https://cb.example.com/hook",
		gateway: "erc8183",
		amount: 100,
		currency: "USD",
	});
}

describe("POST /webhook/erc8183", () => {
	test("valid evaluator attestation marks the order success and forwards", async () => {
		const order = await createOrder();
		const message = attestationMessage(order.id, ercSigner.address, true);
		const signature = await ercSigner.signMessage({ message });

		let callbacks = 0;
		globalThis.fetch = (() => {
			callbacks++;
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const res = await app.request("/webhook/erc8183", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				escrow_id: order.id,
				evaluator: ercSigner.address,
				approved: true,
				status: "released",
				notes: null,
				tx_hash: TX_HASH,
				signature,
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		await waitFor(() => callbacks >= 1);

		const { getDb } = await import("../../src/config/database");
		const db = getDb();
		const orderRows = await db.execute({
			sql: "SELECT status, gateway_reference FROM orders WHERE id = ?",
			args: [order.id],
		});
		expect(orderRows.rows[0].status).toBe("success");
		expect(orderRows.rows[0].gateway_reference).toBe(TX_HASH);

		const eventRows = await db.execute({
			sql: "SELECT gateway, order_id, gateway_reference, status, signature_valid FROM webhook_events WHERE order_id = ?",
			args: [order.id],
		});
		expect(eventRows.rows.length).toBe(1);
		expect(eventRows.rows[0].gateway).toBe("erc8183");
		expect(eventRows.rows[0].status).toBe("success");
		expect(eventRows.rows[0].gateway_reference).toBe(TX_HASH);
		expect(eventRows.rows[0].signature_valid).toBe(1);
		expect(callbacks).toBe(1);
	});

	test("attestation signed by a stranger is rejected with 401", async () => {
		const order = await createOrder();
		// Stranger signs the SAME message, but the payload still claims the
		// configured evaluator — the recovered signer must match it.
		const message = attestationMessage(order.id, ercSigner.address, true);
		const signature = await stranger.signMessage({ message });

		let callbacks = 0;
		globalThis.fetch = (() => {
			callbacks++;
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const res = await app.request("/webhook/erc8183", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				escrow_id: order.id,
				evaluator: ercSigner.address,
				approved: true,
				status: "released",
				notes: null,
				tx_hash: `0x${"bb".repeat(32)}`,
				signature,
			}),
		});

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toBe("Invalid signature");
		expect(callbacks).toBe(0);

		const { getDb } = await import("../../src/config/database");
		const db = getDb();
		const orderRows = await db.execute({
			sql: "SELECT status FROM orders WHERE id = ?",
			args: [order.id],
		});
		expect(orderRows.rows[0].status).toBe("pending");
	});
});
