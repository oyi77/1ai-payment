/**
 * Unit tests for saved-method schemas + savedMethodToResponse (security strip).
 */
import { describe, expect, test } from "bun:test";
import {
	createSavedMethodBodySchema,
	savedPaymentMethodSchema,
	savedMethodToResponse,
	savedMethodsListSchema,
	updateSavedMethodBodySchema,
	savedMethodIdParamsSchema,
} from "../../src/schemas";

describe("createSavedMethodBodySchema", () => {
	test("accepts valid body", () => {
		const r = createSavedMethodBodySchema.safeParse({
			gateway: "midtrans",
			method_code: "card",
			method_name: "BCA Visa",
			gateway_token: "tok_abc",
		});
		expect(r.success).toBe(true);
	});

	test("accepts optional masked_identifier and expires_at", () => {
		const r = createSavedMethodBodySchema.safeParse({
			gateway: "tripay",
			method_code: "ewallet",
			method_name: "GoPay",
			gateway_token: "tok_xyz",
			masked_identifier: "•••• 1234",
			expires_at: "2027-07-06T10:00:00.000Z",
		});
		expect(r.success).toBe(true);
	});

	test("rejects unknown gateway", () => {
		const r = createSavedMethodBodySchema.safeParse({
			gateway: "not-a-gateway",
			method_code: "card",
			method_name: "X",
			gateway_token: "tok",
		});
		expect(r.success).toBe(false);
	});

	test("rejects empty gateway_token", () => {
		const r = createSavedMethodBodySchema.safeParse({
			gateway: "midtrans",
			method_code: "card",
			method_name: "X",
			gateway_token: "",
		});
		expect(r.success).toBe(false);
	});

	test("rejects missing required fields", () => {
		const r = createSavedMethodBodySchema.safeParse({ gateway: "midtrans" });
		expect(r.success).toBe(false);
	});
});

describe("updateSavedMethodBodySchema", () => {
	test("accepts partial update (single field)", () => {
		const r = updateSavedMethodBodySchema.safeParse({ method_name: "New Name" });
		expect(r.success).toBe(true);
	});

	test("accepts empty body (no-op update)", () => {
		const r = updateSavedMethodBodySchema.safeParse({});
		expect(r.success).toBe(true);
	});

	test("accepts null to clear fields", () => {
		const r = updateSavedMethodBodySchema.safeParse({
			masked_identifier: null,
			expires_at: null,
		});
		expect(r.success).toBe(true);
	});

	test("rejects empty method_name when provided", () => {
		const r = updateSavedMethodBodySchema.safeParse({ method_name: "" });
		expect(r.success).toBe(false);
	});
});

describe("savedPaymentMethodSchema (response)", () => {
	test("response schema has NO gateway_token key (security)", () => {
		const shape = savedPaymentMethodSchema.shape;
		expect(shape).not.toHaveProperty("gateway_token");
	});

	test("accepts a full response object", () => {
		const r = savedPaymentMethodSchema.safeParse({
			id: "sm_1",
			merchant_id: "merch_1",
			gateway: "midtrans",
			method_code: "card",
			method_name: "BCA Visa",
			masked_identifier: "•••• 4242",
			expires_at: null,
			created_at: "2026-08-30T00:00:00.000Z",
		});
		expect(r.success).toBe(true);
	});
});

describe("savedMethodsListSchema", () => {
	test("accepts array of saved methods", () => {
		const r = savedMethodsListSchema.safeParse([
			{
				id: "sm_1",
				merchant_id: "merch_1",
				gateway: "midtrans",
				method_code: "card",
				method_name: "A",
				masked_identifier: null,
				expires_at: null,
				created_at: "2026-08-30T00:00:00.000Z",
			},
		]);
		expect(r.success).toBe(true);
	});

	test("rejects non-array", () => {
		const r = savedMethodsListSchema.safeParse({});
		expect(r.success).toBe(false);
	});
});

describe("savedMethodIdParamsSchema", () => {
	test("accepts methodId", () => {
		const r = savedMethodIdParamsSchema.safeParse({ methodId: "sm_1" });
		expect(r.success).toBe(true);
	});

	test("rejects missing methodId", () => {
		const r = savedMethodIdParamsSchema.safeParse({});
		expect(r.success).toBe(false);
	});
});

describe("savedMethodToResponse (security strip)", () => {
	const method = {
		id: "sm_1",
		merchant_id: "merch_1",
		gateway: "midtrans",
		method_code: "card",
		method_name: "BCA Visa",
		gateway_token: "tok_super_secret",
		masked_identifier: "•••• 4242",
		expires_at: "2027-07-06T10:00:00.000Z",
		created_at: "2026-08-30T00:00:00.000Z",
	};

	test("strips gateway_token from response", () => {
		const out = savedMethodToResponse(method);
		expect(out).not.toHaveProperty("gateway_token");
	});

	test("preserves all safe fields", () => {
		const out = savedMethodToResponse(method);
		expect(out).toEqual({
			id: "sm_1",
			merchant_id: "merch_1",
			gateway: "midtrans",
			method_code: "card",
			method_name: "BCA Visa",
			masked_identifier: "•••• 4242",
			expires_at: "2027-07-06T10:00:00.000Z",
			created_at: "2026-08-30T00:00:00.000Z",
		});
	});

	test("output validates against response schema", () => {
		const out = savedMethodToResponse(method);
		const r = savedPaymentMethodSchema.safeParse(out);
		expect(r.success).toBe(true);
	});
});
