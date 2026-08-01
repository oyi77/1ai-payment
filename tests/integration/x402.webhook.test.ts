/**
 * Integration tests for POST /webhook/x402 — on-chain USDC verification.
 *
 * Exercises the x402 webhook end to end against a fresh temp SQLite database
 * and a mocked chain RPC layer:
 * - a receipt showing a USDC Transfer to the configured merchant wallet for
 *   at least the declared amount marks the order success, records the
 *   webhook_events row, and forwards to the project
 * - a transfer landing in a non-merchant wallet is rejected with 401 and the
 *   order stays pending
 *
 * The RPC mock serves eth_getTransactionReceipt (echoing the requested tx
 * hash so every test stays isolated from the 5-minute verification cache)
 * and answers eth_chainId defensively. The Transfer log is built exactly as
 * viem decodes it: topics = [topic0, pad32(from), pad32(to)], data = the
 * 32-byte uint256 value.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../src/config/env";
import type {
	CreateOrderParams,
	Order,
} from "../../src/services/order.service";

const TEST_DB = join(tmpdir(), `1pay-x402-webhook-${Date.now()}.db`);

const API_KEY = "test-key-x402";
const MERCHANT_ID = "merch_x402";
const MERCHANT_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const USDC_ADDRESS = `0x${"cd".repeat(20)}`;
const SENDER = `0x${"ab".repeat(20)}`;
// Distinct tx hashes per test — the verification cache is keyed by tx hash,
// so reusing one would let the negative test wrongly pass.
const TX_HASH_SUCCESS = `0x${"aa".repeat(32)}`;
const TX_HASH_REJECTED = `0x${"bb".repeat(32)}`;
const TRANSFER_TOPIC =
	"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

process.env.API_KEY = API_KEY;
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.X402_WALLET_ADDRESS = MERCHANT_WALLET;
process.env.X402_USDC_ADDRESS = USDC_ADDRESS;
process.env.X402_RPC_URL = "https://mock-rpc.invalid";
process.env.X402_NETWORK = "eip155:8453";

resetConfigCache();

const originalFetch = globalThis.fetch;

let app: import("hono").Hono;
let createOrderFn: (params: CreateOrderParams) => Promise<Order>;

/** Pad an address hex to a 32-byte ERC-20 indexed-topic slot. */
function pad32(hex: string): string {
	return `0x${hex.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** Encode a uint256 as a 32-byte hex string (the Transfer `data` field). */
function toUintHex(value: bigint): string {
	return `0x${value.toString(16).padStart(64, "0")}`;
}

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
 * Build a fetch mock that answers the mock RPC for eth_getTransactionReceipt
 * (echoing the requested hash, with a single USDC Transfer to `transferTo`
 * of `declaredAmount` wei) and counts project callback deliveries.
 */
function makeRpcFetch(
	transferTo: string,
	declaredAmount = 1000000n,
): { mockFetch: typeof fetch; callbackCount: () => number } {
	let callbacks = 0;
	const mockFetch = ((url, init) => {
		if (String(url).includes("mock-rpc.invalid")) {
			const payload = JSON.parse(String(init?.body ?? "{}")) as {
				id: number;
				method: string;
				params: unknown[];
			};

			if (payload.method === "eth_getTransactionReceipt") {
				const requestedHash = String(payload.params[0]);
				const receipt = {
					transactionHash: requestedHash,
					transactionIndex: "0x0",
					blockHash: `0x${"11".repeat(32)}`,
					blockNumber: "0x10",
					from: SENDER,
					to: USDC_ADDRESS,
					cumulativeGasUsed: "0x5208",
					gasUsed: "0x5208",
					contractAddress: null,
					logs: [
						{
							address: USDC_ADDRESS,
							topics: [TRANSFER_TOPIC, pad32(SENDER), pad32(transferTo)],
							data: toUintHex(declaredAmount),
							blockHash: `0x${"11".repeat(32)}`,
							blockNumber: "0x10",
							logIndex: "0x0",
							removed: false,
							transactionHash: requestedHash,
							transactionIndex: "0x0",
						},
					],
					logsBloom: `0x${"00".repeat(256)}`,
					status: "0x1",
					effectiveGasPrice: "0x3b9aca00",
					type: "0x2",
				};
				return Promise.resolve(
					new Response(
						JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: receipt }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			if (payload.method === "eth_chainId") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: payload.id,
							result: "0x2105", // 8453 = base
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			return Promise.resolve(
				new Response(
					JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: null }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		}

		// Project callback URL
		callbacks++;
		return Promise.resolve(new Response("ok", { status: 200 }));
	}) as unknown as typeof fetch;

	return { mockFetch, callbackCount: () => callbacks };
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
		// Distinct key string — the default merchant is seeded from env
		// API_KEY, so reusing it would violate the api_key_hash UNIQUE.
		args: [MERCHANT_ID, "X402", sha256Hash("x402-webhook-key"), "whsec_x402"],
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
		gateway: "x402",
		amount: 1,
		currency: "USD",
	});
}

describe("POST /webhook/x402", () => {
	test("verified USDC transfer marks the order success and forwards", async () => {
		const order = await createOrder();
		const { mockFetch, callbackCount } = makeRpcFetch(MERCHANT_WALLET, 1000000n);
		globalThis.fetch = mockFetch;

		const res = await app.request("/webhook/x402", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				order_id: order.id,
				tx_hash: TX_HASH_SUCCESS,
				network: "eip155:8453",
				asset: USDC_ADDRESS,
				amount: "1000000",
				payer: SENDER,
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		await waitFor(() => callbackCount() >= 1);

		const { getDb } = await import("../../src/config/database");
		const db = getDb();
		const orderRows = await db.execute({
			sql: "SELECT status, gateway_reference FROM orders WHERE id = ?",
			args: [order.id],
		});
		expect(orderRows.rows[0].status).toBe("success");
		expect(orderRows.rows[0].gateway_reference).toBe(TX_HASH_SUCCESS);

		const eventRows = await db.execute({
			sql: "SELECT gateway, order_id, gateway_reference, status, signature_valid FROM webhook_events WHERE order_id = ?",
			args: [order.id],
		});
		expect(eventRows.rows.length).toBe(1);
		expect(eventRows.rows[0].gateway).toBe("x402");
		expect(eventRows.rows[0].status).toBe("success");
		expect(eventRows.rows[0].gateway_reference).toBe(TX_HASH_SUCCESS);
		expect(eventRows.rows[0].signature_valid).toBe(1);
		expect(callbackCount()).toBe(1);
	});

	test("transfer to a non-merchant wallet is rejected with 401", async () => {
		const order = await createOrder();
		const wrongWallet = `0x${"ef".repeat(20)}`;
		const { mockFetch, callbackCount } = makeRpcFetch(wrongWallet, 1000000n);
		globalThis.fetch = mockFetch;

		const res = await app.request("/webhook/x402", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				order_id: order.id,
				tx_hash: TX_HASH_REJECTED,
				network: "eip155:8453",
				asset: USDC_ADDRESS,
				amount: "1000000",
				payer: SENDER,
			}),
		});

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toBe("Invalid signature");
		expect(callbackCount()).toBe(0);

		const { getDb } = await import("../../src/config/database");
		const db = getDb();
		const orderRows = await db.execute({
			sql: "SELECT status FROM orders WHERE id = ?",
			args: [order.id],
		});
		expect(orderRows.rows[0].status).toBe("pending");
	});
});
