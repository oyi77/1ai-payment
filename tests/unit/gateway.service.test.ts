/**
 * Unit tests for Gateway Service — registry lookup, health, methods listing.
 *
 * Pure logic — no database needed.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
	getGateway,
	getGatewayHealth,
	getGatewayMethods,
	getAvailableGateways,
	getGatewayNames,
} from "../../src/services/gateway.service";

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
