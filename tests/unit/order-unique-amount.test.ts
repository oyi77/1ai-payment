/**
 * Unit tests for order unique_amount and polling tracking helpers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-unique-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-unique";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-unique";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

import type { CreateOrderParams, Order } from "../../src/services/order.service";

let initDatabase: (path?: string) => Promise<void>;
let createOrder: (params: CreateOrderParams) => Promise<Order>;
let getActivePendingUniqueAmounts: (gateway: string) => Promise<Set<number>>;
let getPendingOrderByUniqueAmount: (
	gateway: string,
	uniqueAmount: number,
) => Promise<Order | null>;
let updateOrderPolled: (id: string) => Promise<void>;
let getOrderById: (id: string) => Promise<Order | null>;

beforeAll(async () => {
	const dbModule = await import("../../src/config/database");
	initDatabase = dbModule.initDatabase;
	await initDatabase();

	const svc = await import("../../src/services/order.service");
	createOrder = svc.createOrder;
	getActivePendingUniqueAmounts = svc.getActivePendingUniqueAmounts;
	getPendingOrderByUniqueAmount = svc.getPendingOrderByUniqueAmount;
	updateOrderPolled = svc.updateOrderPolled;
	getOrderById = svc.getOrderById;
});

afterAll(() => {
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
		if (existsSync(`${TEST_DB}-wal`)) unlinkSync(`${TEST_DB}-wal`);
		if (existsSync(`${TEST_DB}-shm`)) unlinkSync(`${TEST_DB}-shm`);
	} catch {
		// Ignore cleanup errors
	}
});

describe("Order Service - unique_amount & polling tracking", () => {
	test("createOrder preserves unique_amount", async () => {
		const order = await createOrder({
			project_id: "proj_test",
			callback_url: "https://example.com/webhook",
			gateway: "shopee",
			amount: 50000,
			unique_amount: 50012,
		});

		expect(order.amount).toBe(50000);
		expect(order.unique_amount).toBe(50012);
		expect(order.last_polled_at).toBeNull();

		const retrieved = await getOrderById(order.id);
		expect(retrieved?.unique_amount).toBe(50012);
	});

	test("getActivePendingUniqueAmounts returns set of active amounts for gateway", async () => {
		await createOrder({
			project_id: "proj_test",
			callback_url: "https://example.com/webhook",
			gateway: "shopee",
			amount: 25000,
			unique_amount: 25001,
		});
		await createOrder({
			project_id: "proj_test",
			callback_url: "https://example.com/webhook",
			gateway: "shopee",
			amount: 25000,
			unique_amount: 25002,
		});

		const amounts = await getActivePendingUniqueAmounts("shopee");
		expect(amounts.has(25001)).toBe(true);
		expect(amounts.has(25002)).toBe(true);
		expect(amounts.has(99999)).toBe(false);
	});

	test("getPendingOrderByUniqueAmount retrieves correct pending order", async () => {
		const order = await createOrder({
			project_id: "proj_test",
			callback_url: "https://example.com/webhook",
			gateway: "gopay",
			amount: 75000,
			unique_amount: 75005,
		});

		const match = await getPendingOrderByUniqueAmount("gopay", 75005);
		expect(match).not.toBeNull();
		expect(match?.id).toBe(order.id);

		const noMatch = await getPendingOrderByUniqueAmount("gopay", 75099);
		expect(noMatch).toBeNull();
	});

	test("updateOrderPolled updates last_polled_at", async () => {
		const order = await createOrder({
			project_id: "proj_test",
			callback_url: "https://example.com/webhook",
			gateway: "shopee",
			amount: 10000,
		});

		expect(order.last_polled_at).toBeNull();
		await updateOrderPolled(order.id);

		const updated = await getOrderById(order.id);
		expect(updated?.last_polled_at).not.toBeNull();
	});
});
