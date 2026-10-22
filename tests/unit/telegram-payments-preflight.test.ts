import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import { resetConfigCache } from "../../src/config/env";
import { getDb, initDatabase } from "../../src/config/database";
import { createInvoice } from "../../src/gateways/telegram-payments/payment";

const TEST_DB = join(tmpdir(), `1pay-tgpay-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-tgpay";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-tgpay";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.TELEGRAM_BOT_TOKEN = "123456:test-tgpay-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "whsec_tgpay";
delete process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN;
resetConfigCache();

const originalFetch = globalThis.fetch;

const params = {
	orderId: "pay_tg_1",
	amount: 1000,
	currency: "USD",
	callbackUrl: "https://cb.example.com/tg",
};

beforeAll(async () => {
	await initDatabase();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("createInvoice pre-flight", () => {
	test("throws locally instead of sending an empty provider_token upstream", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		expect(createInvoice(params)).rejects.toThrow(
			"TELEGRAM_PAYMENT_PROVIDER_TOKEN not configured",
		);
		await Bun.sleep(10);
		expect(called).toBe(false);
	});

	test("sends the provider token once it exists", async () => {
		process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN = "prov:live";
		resetConfigCache();
		const bodies: string[] = [];
		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			bodies.push(String(init?.body));
			return new Response(
				JSON.stringify({ ok: true, result: "https://t.me/$bot/invoice" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			const created = await createInvoice(params);
			expect(created.paymentUrl).toBe("https://t.me/$bot/invoice");
			expect(JSON.parse(bodies[0]).provider_token).toBe("prov:live");
		} finally {
			delete process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN;
			resetConfigCache();
		}
	});
});
