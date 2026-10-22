/**
 * Unit tests for the Lynk.id gateway implementation.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { LynkGateway } from "../../src/gateways/lynk";
import { ValidationError } from "../../src/utils/errors";

const TEST_KEY = "AELYdtghXcjR7TJ9_Bb6SJ7PhyHARuNq";

beforeAll(() => {
	process.env.LYNK_MERCHANT_KEY = TEST_KEY;
});

const gateway = new LynkGateway();

describe("LynkGateway.normalizeEvent", () => {
	test("maps real Lynk camelCase payload (grandTotal) to normalized event", () => {
		const payload = {
			data: {
				message_action: "SUCCESS",
				message_data: {
					refId: "LYNK-1792314-ABC",
					customer: {
						name: "Budi Santoso",
						email: "budi@example.com",
						phone: "628123456789",
					},
					items: [{ title: "Lifetime VIP", qty: 1, price: 254000 }],
					totals: {
						totalPrice: 254000,
						grandTotal: "254,000",
					},
					custom_fields: [
						{ label: "Telegram Chat ID", value: "356063384" },
					],
				},
			},
		};

		const event = gateway.normalizeEvent(payload);
		expect(event.gateway).toBe("lynk");
		expect(event.status).toBe("success");
		expect(event.order_id).toBe("LYNK-1792314-ABC");
		expect(event.amount).toBe(254000);
		expect(event.currency).toBe("IDR");
		expect(event.metadata?.chat_id).toBe("356063384");
		expect(event.metadata?.customer_name).toBe("Budi Santoso");
		expect(event.metadata?.customer_email).toBe("budi@example.com");
	});

	test("accepts legacy snake_case totals spellings", () => {
		const payload = {
			data: {
				message_data: {
					ref_id: "LYNK-LEGACY-1",
					totals: { grand_total: "72,000" },
				},
			},
		};

		const event = gateway.normalizeEvent(payload);
		expect(event.order_id).toBe("LYNK-LEGACY-1");
		expect(event.amount).toBe(72000);
	});

	test("reports 0 for a success payload that carries no amount", () => {
		const payload = {
			data: {
				message_action: "SUCCESS",
				message_data: { refId: "LYNK-NO-AMOUNT" },
			},
		};

		const event = gateway.normalizeEvent(payload);
		expect(event.status).toBe("success");
		expect(event.order_id).toBe("LYNK-NO-AMOUNT");
		expect(event.amount).toBe(0);
	});

	test("reports 0 for an unparseable amount instead of a guessed nominal", () => {
		const payload = {
			data: {
				message_data: {
					refId: "LYNK-BAD-AMOUNT",
					totals: { grandTotal: "not-a-number" },
				},
			},
		};

		expect(gateway.normalizeEvent(payload).amount).toBe(0);
	});

	test("maps flat payload to normalized event", () => {
		const payload = {
			order_number: "ORD-998877",
			status: "paid",
			total: 254000,
			customer_name: "John Doe",
			customer_email: "john@example.com",
			metadata: { chat_id: "8964729873" },
		};

		const event = gateway.normalizeEvent(payload);
		expect(event.status).toBe("success");
		expect(event.order_id).toBe("ORD-998877");
		expect(event.amount).toBe(254000);
		expect(event.metadata?.chat_id).toBe("8964729873");
	});

	test("strips leading @ from username if entered as chat_id", () => {
		const payload = {
			order_number: "ORD-123",
			status: "paid",
			metadata: { chat_id: "@user123" },
		};

		const event = gateway.normalizeEvent(payload);
		expect(event.metadata?.chat_id).toBe("user123");
	});
});

describe("LynkGateway.verifySignature", () => {
	test("accepts X-Merchant-Key direct header match", async () => {
		const body = { status: "paid", order_id: "123" };
		const valid = await gateway.verifySignature(body, {
			"x-merchant-key": TEST_KEY,
		});
		expect(valid).toBe(true);
	});

	test("accepts Authorization Bearer header", async () => {
		const body = { status: "paid", order_id: "123" };
		const valid = await gateway.verifySignature(body, {
			authorization: `Bearer ${TEST_KEY}`,
		});
		expect(valid).toBe(true);
	});

	test("accepts valid HMAC-SHA256 signature in X-Signature header", async () => {
		const rawBody = JSON.stringify({ status: "paid", order_id: "123" });
		const expectedHmac = crypto
			.createHmac("sha256", TEST_KEY)
			.update(rawBody)
			.digest("hex");

		const valid = await gateway.verifySignatureRaw(rawBody, {
			"x-signature": expectedHmac,
		});
		expect(valid).toBe(true);
	});

	test("rejects invalid signature header", async () => {
		const rawBody = JSON.stringify({ status: "paid", order_id: "123" });
		const valid = await gateway.verifySignatureRaw(rawBody, {
			"x-signature": "invalid_sig",
		});
		expect(valid).toBe(false);
	});

	test("rejects when no signature or key provided", async () => {
		const rawBody = JSON.stringify({ status: "paid", order_id: "123" });
		const valid = await gateway.verifySignatureRaw(rawBody, {});
		expect(valid).toBe(false);
	});
});

describe("LynkGateway.createPayment", () => {
	test("returns valid payment checkout URL", async () => {
		const res = await gateway.createPayment({
			orderId: "ord_lynk_test",
			amount: 254000,
			currency: "IDR",
		});
		expect(res.paymentUrl).toContain("lynk.id");
		expect(res.gatewayReference).toBe("ord_lynk_test");
	});

	test("rejects invalid payment method", async () => {
		const err = await gateway
			.createPayment({
				orderId: "ord_1",
				amount: 254000,
				currency: "IDR",
				paymentMethod: "invalid/chars!!",
			})
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err).toBeInstanceOf(ValidationError);
	});
});
