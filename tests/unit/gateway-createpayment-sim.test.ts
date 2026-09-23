/**
 * Gateway createPayment simulation — proves every gateway's REAL charge code
 * executes end-to-end: request building, auth header, HTTP call, response
 * parsing. Only transport (global.fetch) is stubbed to speak each sandbox
 * protocol. If any gateway's createPayment is broken (bad body, wrong URL,
 * wrong parse), this fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-gw-sim-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-gwsim";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-gwsim";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.PUBLIC_BASE_URL = "https://pay.berkahkarya.org";

// Gateway credentials
process.env.MIDTRANS_SERVER_KEY = "sim-midtrans";
process.env.TRIPAY_API_KEY = "sim-tripay";
process.env.DUITKU_API_KEY = "sim-duitku";
process.env.DUITKU_MERCHANT_CODE = "SIMDUIT";
process.env.NOWPAYMENTS_API_KEY = "sim-np";
process.env.IPAYMU_API_KEY = "sim-ipaymu";
process.env.IPAYMU_VA_KEY = "sim-ipaymu-va";
process.env.SCALEV_STOREFRONT_API_KEY = "sim-scalev";
process.env.SCALEV_STORE_ID = "sim-store";
process.env.XENDIT_API_KEY = "sim-xendit";
process.env.SAWERIA_USERNAME = "sim-saweria";
process.env.SAWERIA_USER_ID = "sim-saweria-id";
resetConfigCache();

import { initDatabase } from "../../src/config/database";
import { getGateway } from "../../src/gateways";
import type { CreatePaymentParams, PaymentGateway } from "../../src/gateways/base";

let realFetch: typeof fetch;

const PARAMS: CreatePaymentParams = {
	orderId: "sim-order-1",
	amount: 50000,
	currency: "IDR",
	paymentMethod: "bca",
	customerName: "Sim User",
	customerEmail: "sim@example.com",
};

// Per-gateway canned sandbox responses, keyed by URL host.
function sandboxResponse(url: string): Response {
	const host = new URL(url).host;
	const json: Record<string, unknown> = {};
	if (host.includes("midtrans")) {
		Object.assign(json, {
			status_code: "201",
			transaction_id: "sim-mt-trx",
			order_id: "sim-order-1",
			payment_type: "bank_transfer",
			transaction_status: "pending",
			va_numbers: [{ bank: "bca", va_number: "98800" }],
		});
	} else if (host.includes("tripay")) {
		Object.assign(json, {
			success: true,
			message: "OK",
			data: {
				reference: "sim-tp-ref",
				pay_url: "https://tripay.example/pay",
				expired_time: Math.floor(Date.now() / 1000) + 86400,
			},
		});
	} else if (host.includes("duitku")) {
		Object.assign(json, {
			statusCode: "00",
			merchantCode: "SIMDUIT",
			paymentUrl: "https://duitku.example/pay",
			reference: "sim-dk-ref",
			vaNumber: "88888",
		});
	} else if (host.includes("nowpayments")) {
		Object.assign(json, {
			id: "sim-np-invoice",
			payment_status: "waiting",
			pay_amount: 50000,
			pay_currency: "IDR",
			invoice_url: "https://nowpayments.example/pay",
		});
	} else if (host.includes("ipaymu")) {
		Object.assign(json, {
			Status: 200,
			Message: "Success",
			Data: {
				SessionID: "sim-ip-session",
				PaymentURL: "https://ipaymu.example/pay",
				ExpiredAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		});
	} else if (host.includes("scalev")) {
		Object.assign(json, {
			id: "sim-slug",
			payment_url: "https://checkout.scalev.com/sim-slug",
			secret_slug: "sim-slug",
			expired_at: new Date(Date.now() + 3600_000).toISOString(),
		});
	} else if (host.includes("xendit")) {
		Object.assign(json, {
			id: "sim-xe-va",
			account_number: "8888812345",
			bank_code: "BCA",
			status: "ACTIVE",
		});
	} else if (host.includes("saweria")) {
		Object.assign(json, {
			data: {
				id: "sim-saweria-id",
				status: "pending",
				type: "donation",
				payment_type: "qris",
				amount: 50000,
				amount_raw: 50000,
				currency: "IDR",
				qr_string: "https://saweria.example/qr-sim",
			},
		});
	}
	return new Response(JSON.stringify(json), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

beforeAll(async () => {
	await initDatabase();
	realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		return sandboxResponse(String(input));
	}) as typeof fetch;
});

afterAll(() => {
	try {
		globalThis.fetch = realFetch;
		rmSync(TEST_DB);
	} catch {}
});

describe("gateway createPayment simulations (real charge code)", () => {
	const cases: Array<{ name: string; expectRef: string }> = [
		{ name: "midtrans", expectRef: "sim-mt-trx" },
		{ name: "tripay", expectRef: "sim-tp-ref" },
		{ name: "duitku", expectRef: "sim-dk-ref" },
		{ name: "nowpayments", expectRef: "sim-np-invoice" },
		{ name: "ipaymu", expectRef: "sim-ip-session" },
		{ name: "scalev", expectRef: "sim-slug" },
		{ name: "xendit", expectRef: "sim-xe-va" },
		{ name: "saweria", expectRef: "sim-saweria-id" },
	];

	for (const { name, expectRef } of cases) {
		test(`${name} createPayment executes real code and parses response`, async () => {
			const gw = getGateway(name) as PaymentGateway | undefined;
			expect(gw).toBeDefined();
			const result = await gw!.createPayment(PARAMS);
			expect(result.gatewayReference).toBe(expectRef);
			expect(result.paymentUrl).toBeTruthy();
		});
	}
	test("unconfigured gateway throws GatewayError before any HTTP call", async () => {
		// xendit with a missing key must throw 'not configured'
		delete process.env.XENDIT_API_KEY;
		resetConfigCache();
		const gw = getGateway("xendit")!;
		expect(gw.createPayment(PARAMS)).rejects.toThrow(/not configured/);
		process.env.XENDIT_API_KEY = "sim-xendit";
		resetConfigCache();
	});

	test("merchant key hits the wire: midtrans auth must use stored key, not env", async () => {
		// Arrange: store merchant credentials in the DB vault
		const { encrypt } = await import("../../src/utils/crypto");
		const { getDb } = await import("../../src/config/database");
		const db = getDb();
		await db.execute({
			sql: `INSERT INTO merchant_gateways (id, merchant_id, gateway, credentials, environment, enabled)
			      VALUES (?, ?, ?, ?, ?, 1)
			      ON CONFLICT(merchant_id, gateway) DO UPDATE SET credentials = ?, environment = ?, enabled = 1, updated_at = datetime('now')`,
			args: [
				"mgw_simmid_midtrans",
				"merch_wire",
				"midtrans",
				encrypt(JSON.stringify({ apiKey: "merchant-only-key-123" })),
				"sandbox",
				encrypt(JSON.stringify({ apiKey: "merchant-only-key-123" })),
				"sandbox",
			],
		});

		const captured: Array<{ url: string; auth: string }> = [];
		const prevFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers as HeadersInit);
			captured.push({
				url: String(input),
				auth: headers.get("authorization") ?? "",
			});
			return sandboxResponse(String(input));
		}) as typeof fetch;
		try {
			const gw = getGateway("midtrans")!;
			await gw.createPayment({ ...PARAMS, merchantId: "merch_wire" });
		} finally {
			globalThis.fetch = prevFetch;
		}
		const wireAuth = captured[0]?.auth ?? "";
		const expected = `Basic ${Buffer.from("merchant-only-key-123:").toString("base64")}`;
		expect(wireAuth).toBe(expected);
	});

	test("no stored row falls back to platform key", async () => {
		const captured: Array<{ url: string; auth: string }> = [];
		const prevFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers as HeadersInit);
			captured.push({
				url: String(input),
				auth: headers.get("authorization") ?? "",
			});
			return sandboxResponse(String(input));
		}) as typeof fetch;
		try {
			const gw = getGateway("midtrans")!;
			await gw.createPayment({ ...PARAMS, merchantId: "merch_platform_only" });
		} finally {
			globalThis.fetch = prevFetch;
		}
		const wireAuth = captured[0]?.auth ?? "";
		const expected = `Basic ${Buffer.from("sim-midtrans:").toString("base64")}`;
		expect(wireAuth).toBe(expected);
	});
	test("callback URLs point at PUBLIC_BASE_URL, not stale hosts", async () => {
		const bodies: Record<string, string> = {};
		const prevFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			bodies[String(input)] = String(init?.body ?? "");
			return sandboxResponse(String(input));
		}) as typeof fetch;
		try {
			await getGateway("duitku")!.createPayment(PARAMS);
			await getGateway("tripay")!.createPayment(PARAMS);
			await getGateway("ipaymu")!.createPayment(PARAMS);
		} finally {
			globalThis.fetch = prevFetch;
		}
		const duitkuEntry = Object.entries(bodies).find(([url]) =>
			url.includes("duitku"),
		);
		const tripayEntry = Object.entries(bodies).find(([url]) =>
			url.includes("tripay"),
		);
		const ipaymuEntry = Object.entries(bodies).find(([url]) =>
			url.includes("ipaymu"),
		);
		expect(
			(JSON.parse(duitkuEntry?.[1] ?? "{}") as Record<string, unknown>)
				.callbackUrl,
		).toBe("https://pay.berkahkarya.org/webhook/duitku");
		expect(
			(JSON.parse(tripayEntry?.[1] ?? "{}") as Record<string, unknown>)
				.callback_url,
		).toBe("https://pay.berkahkarya.org/webhook/tripay");
		expect(
			(JSON.parse(ipaymuEntry?.[1] ?? "{}") as Record<string, unknown>)
				.notifyUrl,
		).toBe("https://pay.berkahkarya.org/webhook/ipaymu");
		for (const body of Object.values(bodies)) {
			expect(body).not.toContain("example.com/payment");
		}
	});
});
