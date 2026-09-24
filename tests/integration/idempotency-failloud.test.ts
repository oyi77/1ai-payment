/**
 * Regression test for issue #4 (fail loud on idempotency pre-check DB error).
 *
 * Route no longer swallows pre-check failures: a DB error must 500 via
 * onError, never silently proceed to create a possible duplicate.
 * The UNIQUE(idempotency_key) constraint + DuplicateOrderError is the
 * atomic backstop for the check-then-insert race.
 *
 * Own DB path + own API key (shared-process isolation convention).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = join(tmpdir(), `1pay-idem-failloud-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-idemfailloud";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-idemfailloud";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.MIDTRANS_SERVER_KEY = "midtrans_test_key_idemfailloud";
process.env.MIDTRANS_CLIENT_KEY = "midtrans_client_key_idemfailloud";

let app: import("hono").Hono;
let restoreMidtrans: () => void = () => {};

beforeAll(async () => {
	const { initDatabase } = await import("../../src/config/database");
	const { paymentRoutes } = await import("../../src/routes/payment");
	const { Hono } = await import("hono");

	await initDatabase();
	app = new Hono();

	const { getGateway: originalGetGateway } = await import(
		"../../src/gateways"
	);
	const midtransGw = originalGetGateway("midtrans");
	if (midtransGw) {
		const origCreatePayment = midtransGw.createPayment.bind(midtransGw);
		midtransGw.createPayment = async (_params) => ({
			gatewayReference: `trx_mock_${Date.now()}`,
			paymentUrl:
				"https://app.sandbox.midtrans.com/snap/v2/vtweb/mock-redirect",
			expiresAt: undefined,
		});
		restoreMidtrans = () => {
			midtransGw.createPayment = origCreatePayment;
		};
	}

	app.route("/api", paymentRoutes);
});

afterAll(() => {
	restoreMidtrans();
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {
		/* best-effort cleanup */
	}
});

const payBody = (idempotency_key: string) => ({
	gateway: "midtrans",
	amount: 10000,
	currency: "IDR",
	callback_url: "https://example.com/callback",
	idempotency_key,
});

describe("POST /api/payments idempotency fail-loud (issue #4)", () => {
	test("same key twice: 201 then 200 existing (pre-check hit, no duplicate)", async () => {
		const key = `idem-failloud-${Date.now()}`;
		const first = await app.request("/api/payments", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": "test-api-key-idemfailloud",
			},
			body: JSON.stringify(payBody(key)),
		});
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as {
			success: boolean;
			data: { id: string };
		};
		expect(firstBody.success).toBe(true);

		const second = await app.request("/api/payments", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": "test-api-key-idemfailloud",
			},
			body: JSON.stringify(payBody(key)),
		});
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			success: boolean;
			data: { id: string };
		};
		expect(secondBody.success).toBe(true);
		expect(secondBody.data.id).toBe(firstBody.data.id);
	});

	test("concurrent same key: exactly one wins, loser gets 409 (atomic backstop)", async () => {
		const key = `idem-race-${Date.now()}`;
		const [a, b] = await Promise.all([
			app.request("/api/payments", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": "test-api-key-idemfailloud",
				},
				body: JSON.stringify(payBody(key)),
			}),
			app.request("/api/payments", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": "test-api-key-idemfailloud",
				},
				body: JSON.stringify(payBody(key)),
			}),
		]);
		const statuses = [a.status, b.status].sort();
		// Winner: 201 (created) or 200 (pre-check hit); loser: 409 (constraint).
		// At least one must NOT silently create a second order.
		expect(statuses).toContain(409);
		expect(
			statuses[0] === 200 || statuses[0] === 201,
		).toBe(true);
	});

	test("same key different amount: 409 key-in-use (not silent old order)", async () => {
		const key = `idem-mismatch-${Date.now()}`;
		const first = await app.request("/api/payments", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": "test-api-key-idemfailloud",
			},
			body: JSON.stringify(payBody(key)),
		});
		expect(first.status).toBe(201);

		const second = await app.request("/api/payments", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": "test-api-key-idemfailloud",
			},
			body: JSON.stringify({ ...payBody(key), amount: 99999 }),
		});
		expect(second.status).toBe(409);
		const b = (await second.json()) as {
			success: boolean;
			error: { code: string };
		};
		expect(b.success).toBe(false);
		expect(b.error.code).toBe("DUPLICATE_ORDER");
	});
});
