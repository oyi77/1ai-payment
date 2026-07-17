/**
 * Unit tests for Order Service — CRUD operations.
 *
 * Uses temp SQLite database per run. Dynamic imports because DATABASE_PATH
 * must be set before initDatabase is called.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-order-test-${Date.now()}.db`);

// Set env BEFORE imports
process.env.API_KEY = "test-api-key-order";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

// Reset config cache so test-mode re-read applies
resetConfigCache();

import type {
	CreateOrderParams,
	Order,
} from "../../src/services/order.service";


let initDatabase: (path?: string) => Promise<void>;
let createOrder: (params: CreateOrderParams) => Promise<Order>;
let getOrderById: (id: string) => Promise<Order | null>;
let getOrderByProjectOrder: (
	projectId: string,
	projectOrderId: string,
) => Promise<Order | null>;
let getOrderByIdempotencyKey: (
	key: string,
	merchantId?: string,
) => Promise<Order | null>;
let updateOrderStatus: (
	id: string,
	status: string,
	gatewayReference?: string,
	paymentUrl?: string,
	paymentMethod?: string,
) => Promise<void>;
let markForwarded: (
	id: string,
	statusCode?: number,
	attempts?: number,
) => Promise<void>;
let listOrders: (params: {
	project_id?: string;
	merchant_id?: string;
	gateway?: string;
	status?: string;
	from?: string;
	to?: string;
	limit?: number;
	offset?: number;
}) => Promise<{ orders: Order[]; total: number }>;

beforeAll(async () => {
	// Init DB tables
	const dbModule = await import("../../src/config/database");
	initDatabase = dbModule.initDatabase;
	await initDatabase();

	// Import service functions using dynamic import to get fresh references
	// after db is initialized.
	const svc = await import("../../src/services/order.service");
	createOrder = svc.createOrder;
	getOrderById = svc.getOrderById;
	getOrderByProjectOrder = svc.getOrderByProjectOrder;
	getOrderByIdempotencyKey = svc.getOrderByIdempotencyKey;
	updateOrderStatus = svc.updateOrderStatus;
	markForwarded = svc.markForwarded;
	listOrders = svc.listOrders;
});

afterAll(() => {
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {
		/* best-effort cleanup */
	}
});

const baseOrder: CreateOrderParams = {
	project_id: "proj_test",
	merchant_id: "merchant_test",
	callback_url: "https://example.com/callback",
	gateway: "midtrans",
	amount: 50000,
	currency: "IDR",
};

// Helper to create an order and return its id
async function createTestOrder(
	overrides: Partial<CreateOrderParams> = {},
): Promise<Order> {
	return createOrder({ ...baseOrder, ...overrides });
}

describe("createOrder", () => {
	test("creates an order with minimal params", async () => {
		const order = await createTestOrder();
		expect(order.id).toBeTruthy();
		expect(order.project_id).toBe("proj_test");
		expect(order.gateway).toBe("midtrans");
		expect(order.amount).toBe(50000);
		expect(order.currency).toBe("IDR");
		expect(order.status).toBe("pending");
	});

	test("creates order with merchant_id defaulting to project_id", async () => {
		const order = await createTestOrder({ merchant_id: undefined });
		expect(order.merchant_id).toBe("proj_test");
	});

	test("creates order with metadata", async () => {
		const metadata = { escrow_addr: "0xabc", product_id: "p1" };
		const order = await createTestOrder({ metadata });
		expect(order.metadata).toEqual(metadata);
	});

	test("creates order with idempotency key", async () => {
		const key = "idem-test-001";
		const order = await createTestOrder({ idempotency_key: key });
		expect(order.idempotency_key).toBe(key);
	});

	test("rejects duplicate idempotency key", async () => {
		const key = "idem-test-dupe";
		await createTestOrder({ idempotency_key: key });
		await expect(
			createTestOrder({ idempotency_key: key }),
		).rejects.toThrow("Duplicate order");
	});

	test("creates order with project_order_id", async () => {
		const order = await createTestOrder({ project_order_id: "po_001" });
		expect(order.project_order_id).toBe("po_001");
	});

	test("creates order with default currency IDR", async () => {
		const order = await createTestOrder({ currency: undefined });
		expect(order.currency).toBe("IDR");
	});
});

describe("getOrderById", () => {
	test("returns order by id", async () => {
		const created = await createTestOrder();
		const found = await getOrderById(created.id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe(created.id);
		expect(found!.amount).toBe(created.amount);
	});

	test("returns null for unknown id", async () => {
		const found = await getOrderById("nonexistent-id");
		expect(found).toBeNull();
	});
});

describe("getOrderByProjectOrder", () => {
	test("returns order by project + project_order_id", async () => {
		await createTestOrder({ project_order_id: "po_lookup" });
		const found = await getOrderByProjectOrder("proj_test", "po_lookup");
		expect(found).not.toBeNull();
		expect(found!.project_order_id).toBe("po_lookup");
	});

	test("returns null when no match", async () => {
		const found = await getOrderByProjectOrder("proj_test", "no-such-po");
		expect(found).toBeNull();
	});

	test("returns null with wrong project", async () => {
		await createTestOrder({ project_order_id: "po_wrongproj" });
		const found = await getOrderByProjectOrder(
			"different_project",
			"po_wrongproj",
		);
		expect(found).toBeNull();
	});
});

describe("getOrderByIdempotencyKey", () => {
	test("finds order by idempotency key without merchant filter", async () => {
		const key = "idem-lookup-1";
		await createTestOrder({ idempotency_key: key });
		const found = await getOrderByIdempotencyKey(key);
		expect(found).not.toBeNull();
		expect(found!.idempotency_key).toBe(key);
	});

	test("finds order by idempotency key with matching merchant", async () => {
		const key = "idem-lookup-2";
		await createTestOrder({
			idempotency_key: key,
			merchant_id: "merchant_a",
		});
		const found = await getOrderByIdempotencyKey(key, "merchant_a");
		expect(found).not.toBeNull();
	});

	test("returns null when merchant_id does not match", async () => {
		const key = "idem-lookup-3";
		await createTestOrder({
			idempotency_key: key,
			merchant_id: "merchant_a",
		});
		const found = await getOrderByIdempotencyKey(key, "merchant_b");
		expect(found).toBeNull();
	});

	test("returns null for unknown key", async () => {
		const found = await getOrderByIdempotencyKey("nonexistent-key");
		expect(found).toBeNull();
	});
});

describe("updateOrderStatus", () => {
	test("updates status", async () => {
		const order = await createTestOrder();
		await updateOrderStatus(order.id, "success");

		const updated = await getOrderById(order.id);
		expect(updated!.status).toBe("success");
	});

	test("updates with gateway reference and payment URL", async () => {
		const order = await createTestOrder();
		await updateOrderStatus(
			order.id,
			"success",
			"gw_ref_001",
			"https://pay.example.com/123",
			"credit_card",
		);

		const updated = await getOrderById(order.id);
		expect(updated!.gateway_reference).toBe("gw_ref_001");
		expect(updated!.payment_url).toBe("https://pay.example.com/123");
		expect(updated!.payment_method).toBe("credit_card");
	});

	test("does not throw for nonexistent order id", async () => {
		await expect(
			updateOrderStatus("fake-id", "success"),
		).resolves.toBeUndefined();
	});
});

describe("markForwarded", () => {
	test("marks order as forwarded", async () => {
		const order = await createTestOrder();
		await markForwarded(order.id, 200, 1);

		const updated = await getOrderById(order.id);
		expect(updated!.forward_attempts).toBe(1);
	});

	test("increments forward attempts on re-forward", async () => {
		const order = await createTestOrder();
		await markForwarded(order.id, 200, 1);
		await markForwarded(order.id, 200, 2);

		const updated = await getOrderById(order.id);
		expect(updated!.forward_attempts).toBe(2);
	});
});

describe("listOrders", () => {
	test("returns all orders with total count", async () => {
		const result = await listOrders({});
		expect(Array.isArray(result.orders)).toBe(true);
		expect(typeof result.total).toBe("number");
		expect(result.orders.length).toBeLessThanOrEqual(result.total);
	});

	test("returns orders sorted by created_at DESC", async () => {
		const o1 = await createTestOrder({ project_id: "list_sort_test" });
		const o2 = await createTestOrder({ project_id: "list_sort_test" });

		const result = await listOrders({ project_id: "list_sort_test" });
		expect(result.orders.length).toBeGreaterThanOrEqual(2);

		const createdTimes = result.orders.map((o) =>
			new Date(o.created_at).getTime(),
		);
		for (let i = 1; i < createdTimes.length; i++) {
			expect(createdTimes[i - 1]).toBeGreaterThanOrEqual(createdTimes[i]);
		}
	});

	test("filters by status", async () => {
		const order = await createTestOrder({ project_id: "list_status_test" });
		await updateOrderStatus(order.id, "settlement");

		const settled = await listOrders({
			project_id: "list_status_test",
			status: "settlement",
		});

		expect(settled.total).toBeGreaterThanOrEqual(1);
	});

	test("filters by gateway", async () => {
		await createTestOrder({
			project_id: "list_gw_test",
			gateway: "tripay",
		});

		const result = await listOrders({
			project_id: "list_gw_test",
			gateway: "tripay",
		});
		expect(result.total).toBeGreaterThanOrEqual(1);
		for (const order of result.orders) {
			expect(order.gateway).toBe("tripay");
		}
	});

	test("filters by date range", async () => {
		const order = await createTestOrder({ project_id: "list_date_test" });

		// SQLite stores as YYYY-MM-DD HH:MM:SS — convert ISO format to match
		const fmt = (d: Date) =>
			d.toISOString().replace("T", " ").replace(/\.\d{3}Z/, "");
		const from = fmt(
			new Date(new Date(order.created_at).getTime() - 60_000),
		);
		const to = fmt(
			new Date(new Date(order.created_at).getTime() + 60_000),
		);

		const result = await listOrders({
			project_id: "list_date_test",
			from,
			to,
		});
		expect(result.total).toBeGreaterThanOrEqual(1);
	});

	test("respects limit and offset", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const order = await createTestOrder({ project_id: "list_page_test" });
			ids.push(order.id);
		}

		const page1 = await listOrders({
			project_id: "list_page_test",
			limit: 2,
			offset: 0,
		});
		const page2 = await listOrders({
			project_id: "list_page_test",
			limit: 2,
			offset: 2,
		});

		expect(page1.orders.length).toBe(2);
		expect(page2.orders.length).toBe(2);

		// Pages should be disjoint
		if (page1.orders[0] && page2.orders[0]) {
			expect(page1.orders[0].id).not.toBe(page2.orders[0].id);
		}
	});

	test("filters by merchant_id when specified", async () => {
		await createTestOrder({
			project_id: "proj_merchant",
			merchant_id: "merchant_list",
		});

		const result = await listOrders({ merchant_id: "merchant_list" });
		expect(result.total).toBeGreaterThanOrEqual(1);
		for (const order of result.orders) {
			expect(order.merchant_id).toBe("merchant_list");
		}
	});

	test("empty result for non-matching filter", async () => {
		const result = await listOrders({ gateway: "nonexistent_gateway" });
		expect(result.orders).toHaveLength(0);
		expect(result.total).toBe(0);
	});
});
