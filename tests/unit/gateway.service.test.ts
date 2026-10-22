/**
 * Unit tests for Gateway Service — registry lookup, health, methods listing.
 *
 * Pure logic — no database needed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	getGateway,
	getGatewayHealth,
	getGatewayMethods,
	getAvailableGateways,
	getGatewayNames,
} from "../../src/services/gateway.service";
import { resetConfigCache } from "../../src/config/env";

beforeAll(() => {
	// Ensure config is fresh — test-mode getConfig() already re-reads each call.
});

describe("getGatewayHealth", () => {
	test("returns status for every registered gateway", () => {
		const names = getGatewayNames();
		const health = getGatewayHealth();

		for (const name of names) {
			expect(health[name]).toBeDefined();
			expect(typeof health[name].name).toBe("string");
			expect(typeof health[name].configured).toBe("boolean");
		}

		expect(Object.keys(health).length).toBe(names.length);
	});

	test("configured status depends on env", () => {
		const health = getGatewayHealth();
		for (const name of Object.keys(health)) {
			// All gateway configs are optional in env, so this just validates the shape.
			expect(health[name]).toHaveProperty("name", name);
		}
	});

	test("aggregators require a webhook secret to count as configured", () => {
		// An API key alone cannot verify a callback: reporting the aggregator
		// as enabled would advertise a gateway whose webhooks all fail closed.
		const prevKey = process.env.MUTASIKU_API_KEY;
		const prevSecret = process.env.MUTASIKU_WEBHOOK_SECRET;
		process.env.MUTASIKU_API_KEY = "mut-api-key";
		delete process.env.MUTASIKU_WEBHOOK_SECRET;
		expect(getGatewayHealth().mutasiku.configured).toBe(false);
		process.env.MUTASIKU_WEBHOOK_SECRET = "mut-webhook-secret";
		expect(getGatewayHealth().mutasiku.configured).toBe(true);
		// Restore so sibling test files sharing this process see pristine env.
		if (prevKey === undefined) delete process.env.MUTASIKU_API_KEY;
		else process.env.MUTASIKU_API_KEY = prevKey;
		if (prevSecret === undefined) delete process.env.MUTASIKU_WEBHOOK_SECRET;
		else process.env.MUTASIKU_WEBHOOK_SECRET = prevSecret;
	});
});

describe("getAvailableGateways", () => {
	test("returns info for each gateway with methods", () => {
		const gateways = getAvailableGateways();
		const names = getGatewayNames();

		expect(gateways.length).toBe(names.length);

		for (const g of gateways) {
			expect(g.gateway).toBeTruthy();
			expect(typeof g.enabled).toBe("boolean");
			expect(Array.isArray(g.currencies)).toBe(true);
			expect(Array.isArray(g.methods)).toBe(true);
		}
	});

	test("each gateway has at least one payment method", () => {
		const gateways = getAvailableGateways();
		for (const g of gateways) {
			expect(g.methods.length).toBeGreaterThanOrEqual(1);
		}
	});

	test("midtrans has IDR in currencies", () => {
		const gateways = getAvailableGateways();
		const midtrans = gateways.find((g) => g.gateway === "midtrans");
		expect(midtrans).toBeDefined();
		expect(midtrans?.currencies).toContain("IDR");
	});
});

describe("getGatewayMethods", () => {
	test("returns info for a known gateway", () => {
		const info = getGatewayMethods("midtrans");
		expect(info).toBeDefined();
		expect(info!.gateway).toBe("midtrans");
		expect(info!.currencies.length).toBeGreaterThan(0);
		expect(info!.methods.length).toBeGreaterThan(0);
	});

	test("returns undefined for unknown gateway", () => {
		const info = getGatewayMethods("nonexistent_gateway");
		expect(info).toBeUndefined();
	});

	test("methods contain PaymentMethod with code and name", () => {
		const info = getGatewayMethods("nowpayments");
		expect(info).toBeDefined();
		for (const method of info!.methods) {
			expect(typeof method.code).toBe("string");
			expect(typeof method.name).toBe("string");
		}
	});
});

describe("re-exports", () => {
	test("getGatewayNames and getGateway are re-exported", () => {
		expect(typeof getGatewayNames).toBe("function");
		expect(typeof getGateway).toBe("function");
	});
});

describe("telegram gateways require what they actually use", () => {
	const saved = {
		bot: process.env.TELEGRAM_BOT_TOKEN,
		secret: process.env.TELEGRAM_WEBHOOK_SECRET,
		provider: process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN,
	};

	afterAll(() => {
		for (const [key, value] of Object.entries({
			TELEGRAM_BOT_TOKEN: saved.bot,
			TELEGRAM_WEBHOOK_SECRET: saved.secret,
			TELEGRAM_PAYMENT_PROVIDER_TOKEN: saved.provider,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetConfigCache();
	});

	test("telegram_stars is ready with a bot token + webhook secret", () => {
		process.env.TELEGRAM_BOT_TOKEN = "bot:stars";
		process.env.TELEGRAM_WEBHOOK_SECRET = "whsec_stars";
		delete process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN;
		resetConfigCache();
		const health = getGatewayHealth();
		expect(health.telegram_stars.configured).toBe(true);
		// Fiat invoices cannot work without a provider token.
		expect(health.telegram_payments.configured).toBe(false);
	});

	test("telegram_payments needs a provider token, not just a bot", () => {
		process.env.TELEGRAM_BOT_TOKEN = "bot:pay";
		process.env.TELEGRAM_WEBHOOK_SECRET = "whsec_pay";
		process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN = "prov:token";
		resetConfigCache();
		expect(getGatewayHealth().telegram_payments.configured).toBe(true);
	});
});
