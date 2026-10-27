/**
 * Unit tests for PollerService — background polling and settlement.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-poller-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

process.env.API_KEY = "test-api-key-poller";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-poller";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

import { initDatabase } from "../../src/config/database";
import { registerGateway, resetGatewayRegistry, getGateway, getGatewayNames } from "../../src/gateways/index";
import type { FeedGateway, MerchantTransaction, PaymentGateway, CreatePaymentResult, RefundResult, PaymentMethod } from "../../src/gateways/base";
import { createOrder, getOrderById } from "../../src/services/order.service";
import { tickPoller, startPoller, stopPoller, PollerService } from "../../src/services/poller.service";

class FakeFeedGateway implements FeedGateway {
	name = "fake_feed";
	transactionsToReturn: MerchantTransaction[] = [];
	shouldThrow = false;
	fetchCalls = 0;

	async createPayment(): Promise<CreatePaymentResult> {
		return {
			payment_url: "https://example.com/pay",
			gateway_reference: "ref_123",
			expires_at: new Date(Date.now() + 3600_000).toISOString(),
		};
	}

	async verifyWebhook(): Promise<any> {
		return null;
	}

	async getPaymentMethods(): Promise<PaymentMethod[]> {
		return [];
	}

	async refundPayment(): Promise<RefundResult> {
		return { success: true, refund_id: "rf_123" };
	}

	async fetchRecentTransactions(): Promise<MerchantTransaction[]> {
		this.fetchCalls++;
		if (this.shouldThrow) {
			throw new Error("Simulated feed failure");
		}
		return this.transactionsToReturn;
	}
}

beforeEach(async () => {
	await initDatabase();
	const { getDb } = await import("../../src/config/database");
	await getDb().execute("DELETE FROM orders WHERE gateway IN ('fake_feed','fake_feed_err')");
	resetGatewayRegistry();
	stopPoller();
	delete process.env.POLLER_INTERVAL_MS;
	delete process.env.POLLER_CLOCK_SKEW_MS;
});

describe("PollerService", () => {
	beforeEach(async () => {
		await initDatabase();
		resetGatewayRegistry();
		stopPoller();
		delete process.env.POLLER_INTERVAL_MS;
		delete process.env.POLLER_CLOCK_SKEW_MS;
	});

	afterEach(async () => {
		stopPoller();
		resetGatewayRegistry();
		// no closeDatabase in this module
	});

	test("matches transaction to pending order and settles it", async () => {
		const fake = new FakeFeedGateway();
		registerGateway("fake_feed", fake);

		const order = await createOrder({
			project_id: "proj_test",
			merchant_id: "merch_default",
			gateway: "fake_feed",
			amount: 15000,
			unique_amount: 15002,
			currency: "IDR",
			callback_url: "https://example.com/callback",
		});

		expect(order.status).toBe("pending");

		fake.transactionsToReturn = [
			{
				transaction_id: "tx_12345",
				amount: 15002,
				status: "success",
				created_at: new Date().toISOString(),
			},
		];

		const result = await tickPoller();
		expect(result.polled).toBe(1);
		expect(result.settled).toBe(1);

		const updated = await getOrderById(order.id);
		expect(updated).not.toBeNull();
		expect(updated?.status).toBe("success");
		expect(updated?.gateway_reference).toBe("tx_12345");
		expect(updated?.last_polled_at).not.toBeNull();
	});

	test("isolates feed errors when fetchRecentTransactions throws", async () => {
		const failing = new FakeFeedGateway();
		failing.shouldThrow = true;
		registerGateway("fake_feed", failing);

		const order = await createOrder({
			project_id: "proj_test",
			merchant_id: "merch_default",
			gateway: "fake_feed",
			amount: 20000,
			currency: "IDR",
			callback_url: "https://example.com/callback",
		});

		const result = await tickPoller();
		expect(result.polled).toBe(0);
		expect(result.settled).toBe(0);

		const updated = await getOrderById(order.id);
		expect(updated?.status).toBe("pending");
	});

	test("skips fetchRecentTransactions when no pending orders exist", async () => {
		const fake = new FakeFeedGateway();
		registerGateway("fake_feed", fake);

		const result = await tickPoller();
		expect(result.polled).toBe(0);
		expect(result.settled).toBe(0);
		expect(fake.fetchCalls).toBe(0);
	});

	test("startPoller and stopPoller manage timer lifecycle cleanly", () => {
		const service = new PollerService();
		service.startPoller();
		service.stopPoller();
		// Idempotent stop
		service.stopPoller();
	});
});
