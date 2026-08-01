/**
 * Unit tests for the gateway-confirmed refund path in createRefund.
 *
 * Uses a fake gateway injected through the registry seam (registerGateway)
 * to exercise the three outcomes of gateway.refundPayment:
 * - success → refund success + order flipped to refunded (full refund)
 * - REFUND_NOT_SUPPORTED → refund stays pending, order untouched
 * - generic error → refund failed, order untouched
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@libsql/client";
import { resetConfigCache } from "../../src/config/env";
import { registerGateway, resetGatewayRegistry } from "../../src/gateways";
import type { PaymentGateway, RefundResult } from "../../src/gateways";
import { createOrder } from "../../src/services/order.service";
import { createRefund } from "../../src/services/refund.service";
import { GatewayError } from "../../src/utils/errors";

const TEST_DB = join(tmpdir(), `1pay-refund-gateway-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-refund-gw";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY = "f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";

let db: Client;

function fakeRefundGateway(
	refundPayment?: (ref: string, amount: number) => Promise<RefundResult>,
): PaymentGateway {
	return {
		name: "fake_refund",
		createPayment: async () => ({
			gatewayReference: "gw_create",
			paymentUrl: "https://pay.example.com",
		}),
		getPaymentMethods: () => [],
		verifySignature: () => false,
		normalizeEvent: () => ({
			gateway: "fake_refund",
			order_id: "",
			gateway_reference: "",
			status: "success",
			amount: 0,
			currency: "IDR",
			payment_method: "",
			paid_at: null,
			metadata: null,
		}),
		refundPayment,
	};
}

beforeAll(async () => {
	await initDatabase();
	db = getDb();

	await db.execute({
		sql: "INSERT OR REPLACE INTO merchants (id, name, api_key_hash, webhook_secret, active) VALUES (?, ?, ?, ?, ?)",
		args: ["merch_refund_gw", "Refund GW Test Merchant", "hash_refund_gw", "whsec_refund_gw", 1],
	});
});

afterEach(() => {
	resetGatewayRegistry();
});

afterAll(() => {
	resetGatewayRegistry();
	db.close();
});

// Create a successful, gateway-confirmed order for refund tests
async function createConfirmedOrder(amount = 50000): Promise<string> {
	const order = await createOrder({
		project_id: "merch_refund_gw",
		callback_url: "https://example.com/callback",
		gateway: "fake_refund",
		amount,
		currency: "IDR",
		idempotency_key: `refund-gw-test-${Date.now()}-${Math.random()}`,
	});
	await db.execute({
		sql: "UPDATE orders SET status = 'success', gateway_reference = 'gw_trx_1' WHERE id = ?",
		args: [order.id],
	});
	return order.id;
}

async function orderStatus(orderId: string): Promise<string> {
	const result = await db.execute({
		sql: "SELECT status FROM orders WHERE id = ?",
		args: [orderId],
	});
	return (result.rows[0] as Record<string, unknown>).status as string;
}

describe("createRefund with gateway confirmation", () => {
	test("marks refund success and flips order to refunded on full refund", async () => {
		const orderId = await createConfirmedOrder(50000);
		const calls: Array<[string, number]> = [];
		registerGateway(
			"fake_refund",
			fakeRefundGateway(async (ref, amount) => {
				calls.push([ref, amount]);
				return { gatewayRefundId: "gw_ref_1", status: "success" };
			}),
		);

		const refund = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund_gw",
			amount: 50000,
		});

		expect(refund.status).toBe("success");
		expect(refund.gateway_refund_id).toBe("gw_ref_1");
		expect(calls).toEqual([["gw_trx_1", 50000]]);
		expect(await orderStatus(orderId)).toBe("refunded");
	});

	test("keeps order success on partial refund even when gateway confirms", async () => {
		const orderId = await createConfirmedOrder(50000);
		registerGateway(
			"fake_refund",
			fakeRefundGateway(async () => ({
				gatewayRefundId: "gw_ref_2",
				status: "success",
			})),
		);

		const refund = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund_gw",
			amount: 25000,
		});

		expect(refund.status).toBe("success");
		expect(await orderStatus(orderId)).toBe("success");
	});

	test("keeps refund pending and order success on REFUND_NOT_SUPPORTED", async () => {
		const orderId = await createConfirmedOrder(50000);
		registerGateway(
			"fake_refund",
			fakeRefundGateway(async () => {
				throw new GatewayError("fake_refund", "REFUND_NOT_SUPPORTED");
			}),
		);

		const refund = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund_gw",
			amount: 50000,
		});

		expect(refund.status).toBe("pending");
		expect(refund.gateway_refund_id).toBeNull();
		expect(await orderStatus(orderId)).toBe("success");
	});

	test("marks refund failed and keeps order success on gateway error", async () => {
		const orderId = await createConfirmedOrder(50000);
		registerGateway(
			"fake_refund",
			fakeRefundGateway(async () => {
				throw new Error("gateway timeout");
			}),
		);

		const refund = await createRefund({
			order_id: orderId,
			merchant_id: "merch_refund_gw",
			amount: 50000,
		});

		expect(refund.status).toBe("failed");
		expect(refund.gateway_refund_id).toBeNull();
		expect(await orderStatus(orderId)).toBe("success");
	});
});
