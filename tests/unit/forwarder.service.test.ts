/**
 * Unit tests for Forwarder Service — sending payment events to project callbacks.
 *
 * Uses temp SQLite database + overridden global fetch and setTimeout.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetConfigCache } from "../../src/config/env";
import type { NormalizedPaymentEvent } from "../../src/gateways/base";
import type {
	CreateOrderParams,
	Order,
} from "../../src/services/order.service";

const TEST_DB = join(tmpdir(), `1pay-forwarder-test-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-fwd";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

let forwardEvent: (
	event: NormalizedPaymentEvent,
	order: Order,
	webhookSecret: string,
) => Promise<{
	success: boolean;
	statusCode: number;
	attempts: number;
}>;
let getOrderById: (id: string) => Promise<Order | null>;
let createOrderObj: (params: CreateOrderParams) => Promise<Order>;

const originalFetch = globalThis.fetch;

async function listDeadLetter(): Promise<
	Array<{ order_id: string; error: string; attempts: number }>
> {
	const { getDb } = await import("../../src/config/database");
	const db = getDb();
	const result = await db.execute(
		"SELECT order_id, error, attempts FROM dead_letter_events ORDER BY created_at DESC",
	);
	return result.rows.map((r: Record<string, unknown>) => ({
		order_id: String(r.order_id ?? ""),
		error: String(r.error ?? ""),
		attempts: Number(r.attempts ?? 0),
	}));
}

beforeAll(async () => {
	const dbModule = await import("../../src/config/database");
	await dbModule.initDatabase();

	const fwd = await import("../../src/services/forwarder.service");
	forwardEvent = fwd.forwardEvent;

	const ord = await import("../../src/services/order.service");
	createOrderObj = ord.createOrder;
	getOrderById = ord.getOrderById;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {
		/* best-effort cleanup */
	}
});

function makeOrder(overrides: Partial<CreateOrderParams> = {}): Promise<Order> {
	return createOrderObj({
		project_id: "fwd_test",
		merchant_id: "merchant_fwd",
		callback_url: "https://example.com/callback",
		gateway: "midtrans",
		amount: 25000,
		currency: "IDR",
		...overrides,
	});
}

const baseEvent: NormalizedPaymentEvent = {
	gateway: "midtrans",
	order_id: "ord_001",
	gateway_reference: "trx_001",
	status: "success",
	amount: 25000,
	currency: "IDR",
	payment_method: "credit_card",
	paid_at: new Date().toISOString(),
	metadata: null,
};

/**
 * Run a callback with setTimeout replaced so delays execute instantly.
 * The original setTimeout is restored after the callback completes.
 */
async function withInstantTimers<T>(fn: () => Promise<T>): Promise<T> {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((
		fn: (...args: unknown[]) => void,
		_ms?: number,
	) => originalSetTimeout(fn, 0)) as unknown as typeof globalThis.setTimeout;
	try {
		return await fn();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
}

describe("forwardEvent with mocked fetch", () => {
	test("sends event and marks forwarded on 200", async () => {
		const order = await makeOrder();

		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.method).toBe("POST");
			const body = JSON.parse(init?.body as string);
			expect(body.event).toBe("payment.success");
			expect(body.gateway).toBe("midtrans");
			expect(body.order_id).toBe(order.id);
			expect(body.amount).toBe(25000);
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const result = await forwardEvent(baseEvent, order, "hook_secret");
		expect(result.success).toBe(true);
		expect(result.statusCode).toBe(200);
		expect(result.attempts).toBe(1);

		const updated = await getOrderById(order.id);
		expect(updated!.forward_attempts).toBe(1);
	});

	test("retries on 500 and writes dead letter", async () => {
		const order = await makeOrder({
			callback_url: "https://httpbin.org/status/500",
		});
		let callCount = 0;

		globalThis.fetch = (() => {
			callCount++;
			return Promise.resolve(
				new Response("Internal Server Error", { status: 500 }),
			);
		}) as unknown as typeof fetch;

		const result = await withInstantTimers(() =>
			forwardEvent(baseEvent, order, "secret"),
		);
		expect(result.success).toBe(false);
		expect(result.attempts).toBe(3);
		expect(callCount).toBe(3);

		const letters = await listDeadLetter();
		const match = letters.find((l) => l.order_id === order.id);
		expect(match).toBeDefined();
		expect(match!.attempts).toBe(3);
	});

	test("retries on network error and writes dead letter", async () => {
		const order = await makeOrder({
			callback_url: "https://nonexistent.example.com/fail",
		});
		let callCount = 0;

		globalThis.fetch = (() => {
			callCount++;
			return Promise.reject(new Error("ECONNREFUSED"));
		}) as unknown as typeof fetch;

		const result = await withInstantTimers(() =>
			forwardEvent(baseEvent, order, "secret"),
		);
		expect(result.success).toBe(false);
		expect(result.attempts).toBe(3);

		const letters = await listDeadLetter();
		const match = letters.find((l) => l.order_id === order.id);
		expect(match).toBeDefined();
		expect(match!.error).toContain("ECONNREFUSED");
	});

	test("succeeds on second retry after initial failure", async () => {
		const order = await makeOrder();
		let callCount = 0;

		globalThis.fetch = (() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve(
					new Response("Service Unavailable", { status: 503 }),
				);
			}
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const result = await withInstantTimers(() =>
			forwardEvent(baseEvent, order, "secret"),
		);
		expect(result.success).toBe(true);
		expect(result.statusCode).toBe(200);
		expect(result.attempts).toBe(2);
		expect(callCount).toBe(2);
	});

	test("includes project metadata in forwarded payload", async () => {
		const metadata = { product_id: "p_123", user_id: "u_456" };
		const order = await makeOrder({ metadata });

		globalThis.fetch = ((
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			const body = JSON.parse(init?.body as string);
			expect(body.metadata).toEqual(metadata);
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const result = await forwardEvent(baseEvent, order, "secret");
		expect(result.success).toBe(true);
	});

	test("includes signature and event headers", async () => {
		const order = await makeOrder();

		globalThis.fetch = ((
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			const headers = init?.headers as Record<string, string>;
			expect(headers["X-Payment-Signature"]).toBeTruthy();
			expect(headers["X-Payment-Event"]).toBe("payment.success");
			expect(headers["Content-Type"]).toBe("application/json");
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;

		const result = await forwardEvent(baseEvent, order, "hook_secret");
		expect(result.success).toBe(true);
	});
});
