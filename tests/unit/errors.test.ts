/**
 * Unit tests for Error classes — pure constructors, no DB needed.
 */

import { describe, expect, test } from "bun:test";
import {
	PaymentError,
	SignatureError,
	OrderNotFoundError,
	DuplicateOrderError,
	GatewayError,
	ForwardError,
} from "../../src/utils/errors";

describe("PaymentError", () => {
	test("sets message, code, and statusCode", () => {
		const err = new PaymentError("bad request", "BAD_REQUEST", 400);
		expect(err.message).toBe("bad request");
		expect(err.code).toBe("BAD_REQUEST");
		expect(err.statusCode).toBe(400);
		expect(err.name).toBe("PaymentError");
	});

	test("defaults to statusCode 400", () => {
		const err = new PaymentError("msg", "CODE");
		expect(err.statusCode).toBe(400);
	});

	test("is instance of Error", () => {
		expect(new PaymentError("msg", "CODE")).toBeInstanceOf(Error);
	});
});

describe("SignatureError", () => {
	test("sets message, code 401, and name", () => {
		const err = new SignatureError("midtrans");
		expect(err.message).toBe("Invalid signature from midtrans");
		expect(err.code).toBe("INVALID_SIGNATURE");
		expect(err.statusCode).toBe(401);
		expect(err.name).toBe("SignatureError");
	});

	test("is instance of PaymentError", () => {
		expect(new SignatureError("xendit")).toBeInstanceOf(PaymentError);
	});
});

describe("OrderNotFoundError", () => {
	test("sets message with order id, code 404", () => {
		const err = new OrderNotFoundError("ord_123");
		expect(err.message).toBe("Order not found: ord_123");
		expect(err.code).toBe("ORDER_NOT_FOUND");
		expect(err.statusCode).toBe(404);
		expect(err.name).toBe("OrderNotFoundError");
	});

	test("is instance of PaymentError", () => {
		expect(new OrderNotFoundError("x")).toBeInstanceOf(PaymentError);
	});
});

describe("DuplicateOrderError", () => {
	test("sets message, code 409", () => {
		const err = new DuplicateOrderError("ord_dup");
		expect(err.message).toBe("Duplicate order: ord_dup");
		expect(err.code).toBe("DUPLICATE_ORDER");
		expect(err.statusCode).toBe(409);
		expect(err.name).toBe("DuplicateOrderError");
	});
});

describe("GatewayError", () => {
	test("sets message with gateway and details, code 502", () => {
		const err = new GatewayError("midtrans", "timeout");
		expect(err.message).toBe("Gateway midtrans error: timeout");
		expect(err.code).toBe("GATEWAY_ERROR");
		expect(err.statusCode).toBe(502);
		expect(err.name).toBe("GatewayError");
	});

	test("is instance of PaymentError", () => {
		expect(new GatewayError("g", "err")).toBeInstanceOf(PaymentError);
	});
});

describe("ForwardError", () => {
	test("sets message, statusCode, and attempts", () => {
		const err = new ForwardError("HTTP 500", 500, 3);
		expect(err.message).toBe("HTTP 500");
		expect(err.statusCode).toBe(500);
		expect(err.attempts).toBe(3);
		expect(err.name).toBe("ForwardError");
	});

	test("is instance of Error, not PaymentError", () => {
		const err = new ForwardError("fail", 502, 1);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(PaymentError);
	});
});
