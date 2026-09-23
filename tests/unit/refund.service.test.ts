/**
 * Unit tests for Refund Service — CRUD, validation, merchant ownership.
 *
 * Needs DB setup with an order + gateways that may or may not support refunds.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-refund-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-refund";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY = "f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { createOrder } from "../../src/services/order.service";
import {
	createRefund,
	getRefundById,
	listRefunds,
} from "../../src/services/refund.service";

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	// Insert a test merchant (needed for order creation)
	await db.execute({
		sql: "INSERT OR REPLACE INTO merchants (id, name, api_key_hash, webhook_secret, active) VALUES (?, ?, ?, ?, ?)",
		args: ["merch_refund", "Refund Test Merchant", "hash_refund", "whsec_refund", 1],
	});
});

afterAll(() => {
	db.close();
});

// Create a successful order for refund tests
async function createSuccessOrder(overrides: {
	projectId?: string;
	amount?: number;
} = {}): Promise<string> {
	const order = await createOrder({
		project_id: overrides.projectId ?? "merch_refund",
		callback_url: "https://example.com/callback",
		gateway: "midtrans",
		amount: overrides.amount ?? 50000,
		currency: "IDR",
		idempotency_key: `refund-test-${Date.now()}-${Math.random()}`,
	});
	// Update status to success
	await db.execute({
		sql: "UPDATE orders SET status = 'success' WHERE id = ?",
		args: [order.id],
	});
	return order.id;
}

describe("createRefund", () => {
	test("creates a pending refund for a successful order", async () => {
		const orderId = await createSuccessOrder();
		const refund = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund",
			amount: 25000,
			reason: "Customer request",
		});

		expect(refund).toBeDefined();
		expect(refund.id).toBeTruthy();
		expect(typeof refund.id).toBe("string");
		expect(refund.order_id).toBe(orderId);
		expect(refund.merchant_id).toBe("merch_refund");
		expect(refund.amount).toBe(25000);
		expect(refund.status).toBe("pending");
		expect(refund.reason).toBe("Customer request");
	});

	test("defaults to full refund amount when amount not specified", async () => {
		const orderId = await createSuccessOrder({ amount: 75000 });
		const refund = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund",
		});

		expect(refund.amount).toBe(75000);
	});

	test("throws for order belonging to another merchant", async () => {
		const orderId = await createSuccessOrder({ projectId: "other_merchant" });
		await expect(
			createRefund({
				order_id: orderId,
				merchant_id: "merch_refund",
			}),
		).rejects.toThrow(/does not belong/i);
	});

	test("throws when refund amount exceeds order amount", async () => {
		const orderId = await createSuccessOrder({ amount: 10000 });
		await expect(
			createRefund({
				order_id: orderId,
				merchant_id: "merch_refund",
				amount: 20000,
			}),
		).rejects.toThrow(/exceed/i);
	});

	test("throws when cumulative refunds would exceed order amount", async () => {
		const orderId = await createSuccessOrder({ amount: 10000 });
		await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund",
			amount: 6000,
		});
		await expect(
			createRefund({
				order_id: orderId,
				merchant_id: "merch_refund",
				amount: 6000,
			}),
		).rejects.toThrow(/exceed/i);
	});

	test("leaves order success when full refund is not gateway-confirmed", async () => {
		const orderId = await createSuccessOrder({ amount: 50000 });
		const refund = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund",
			amount: 50000,
		});

		// Midtrans has no refundPayment support, so the refund stays pending and
		// the order must NOT be flipped to "refunded" until the gateway confirms.
		expect(refund.status).toBe("pending");

		const result = await db.execute({
			sql: "SELECT status FROM orders WHERE id = ?",
			args: [orderId],
		});
		const status = (result.rows[0] as Record<string, unknown>).status;
		expect(status).toBe("success");
	});

	test("parallel distinct keys over total: at least one fails closed, non-failed total never exceeds", async () => {
		const orderId = await createSuccessOrder({ amount: 10000 });
		const mk = (suffix: string) => ({
			order_id: orderId,
			merchant_id: "merch_refund",
			amount: 6000,
			idempotency_key: `refund-cumrace-${Date.now()}-${suffix}-${Math.random()}`,
		});
		const [a, b] = await Promise.allSettled([
			createRefund(mk("a")),
			createRefund(mk("b")),
		]);
		const rejected = [a, b].filter((r) => r.status === "rejected");
		expect(rejected.length).toBeGreaterThanOrEqual(1);
		const rows = await db.execute({
			sql: "SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE order_id = ? AND status != 'failed'",
			args: [orderId],
		});
		expect(Number((rows.rows[0] as Record<string, unknown>).total)).toBeLessThanOrEqual(10000);
	});

	test("parallel same key: single row, both callers get the winner (atomic backstop)", async () => {
		const orderId = await createSuccessOrder({ amount: 40000 });
		const key = `refund-race-${Date.now()}-${Math.random()}`;
		const params = {
			order_id: orderId,
			merchant_id: "merch_refund",
			amount: 10000,
			idempotency_key: key,
		};
		const [a, b] = await Promise.all([createRefund(params), createRefund(params)]);
		expect(a.id).toBe(b.id);
		const rows = await db.execute({
			sql: "SELECT COUNT(*) AS n FROM refunds WHERE merchant_id = ? AND idempotency_key = ?",
			args: ["merch_refund", key],
		});
		expect(Number((rows.rows[0] as Record<string, unknown>).n)).toBe(1);
	});
});

describe("getRefundById", () => {
	test("returns null for non-existent refund", async () => {
		const result = await getRefundById("ref_nonexistent");
		expect(result).toBeNull();
	});

	test("returns refund for existing id", async () => {
		const orderId = await createSuccessOrder();
		const created = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund",
		});
		const found = await getRefundById(created.id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe(created.id);
		expect(found!.status).toBe("pending");
	});
});

describe("listRefunds", () => {
	test("lists refunds for a merchant", async () => {
		const orderId = await createSuccessOrder();
		await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund",
			amount: 30000,
		});
		await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund",
			amount: 20000,
		});

		const { refunds, total } = await listRefunds("merch_refund");
		expect(total).toBeGreaterThanOrEqual(2);
		expect(refunds.length).toBeGreaterThanOrEqual(2);
	});
});
