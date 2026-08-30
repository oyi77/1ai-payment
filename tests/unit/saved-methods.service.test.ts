/**
 * Unit tests for Saved Methods Service — CRUD + idempotency + isolation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-sm-test-${Date.now()}.db`);

// Set env BEFORE imports
process.env.API_KEY = "test-api-key-sm";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

// Reset config cache so test-mode re-read applies
resetConfigCache();

import type { CreateSavedMethodInput, SavedMethod } from "../../src/services/saved-methods.service";
import { initDatabase } from "../../src/config/database";

let createSavedMethod: (merchantId: string, input: CreateSavedMethodInput) => Promise<SavedMethod>;
let listSavedMethods: (merchantId: string) => Promise<SavedMethod[]>;
let getSavedMethodById: (merchantId: string, id: string) => Promise<SavedMethod | null>;
let deleteSavedMethod: (merchantId: string, id: string) => Promise<number>;
let findByUniqueKey: (
	merchantId: string,
	gateway: string,
	gatewayToken: string,
) => Promise<SavedMethod | null>;

beforeAll(async () => {
	await initDatabase(TEST_DB);

	// Lazy import after DB init
	const mod = await import("../../src/services/saved-methods.service");
	createSavedMethod = mod.createSavedMethod;
	listSavedMethods = mod.listSavedMethods;
	getSavedMethodById = mod.getSavedMethodById;
	deleteSavedMethod = mod.deleteSavedMethod;
	findByUniqueKey = mod.findByUniqueKey;
});

afterAll(() => {
	try {
		rmSync(TEST_DB);
	} catch {}
});

const baseInput: CreateSavedMethodInput = {
	gateway: "midtrans",
	method_code: "card",
	method_name: "BCA Visa",
	gateway_token: "tok_abc123",
	masked_identifier: "•••• 4242",
	expires_at: "2027-07-06T10:00:00.000Z",
};

describe("listSavedMethods", () => {
	test("returns empty array for new merchant", async () => {
		const methods = await listSavedMethods("merch_new");
		expect(methods).toEqual([]);
	});
});

describe("createSavedMethod", () => {
	test("creates a saved method and returns full object (gateway_token included internally)", async () => {
		const method = await createSavedMethod("merch_A", baseInput);
		expect(method.id).toBeString();
		expect(method.merchant_id).toBe("merch_A");
		expect(method.gateway).toBe("midtrans");
		expect(method.method_code).toBe("card");
		expect(method.method_name).toBe("BCA Visa");
		expect(method.gateway_token).toBe("tok_abc123"); // internal service returns full object
		expect(method.masked_identifier).toBe("•••• 4242");
		expect(method.expires_at).toBe("2027-07-06T10:00:00.000Z");
		expect(method.created_at).toBeString();
	});

	test("idempotent: same merchant+gateway+token returns existing row", async () => {
		const first = await createSavedMethod("merch_B", baseInput);
		const second = await createSavedMethod("merch_B", baseInput);
		expect(second.id).toBe(first.id);
		expect(second.created_at).toBe(first.created_at);
	});

	test("different merchant with same gateway+token creates separate row", async () => {
		const m1 = await createSavedMethod("merch_C1", baseInput);
		const m2 = await createSavedMethod("merch_C2", baseInput);
		expect(m2.id).not.toBe(m1.id);
		expect(m2.merchant_id).toBe("merch_C2");
	});

	test("different gateway_token creates new row even for same merchant+gateway", async () => {
		const m1 = await createSavedMethod("merch_D", baseInput);
		const m2 = await createSavedMethod("merch_D", {
			...baseInput,
			gateway_token: "tok_different",
			method_name: "Mandiri Debit",
		});
		expect(m2.id).not.toBe(m1.id);
		expect(m2.method_name).toBe("Mandiri Debit");
	});

	test("optional fields can be omitted", async () => {
		const minimal: CreateSavedMethodInput = {
			gateway: "tripay",
			method_code: "ewallet",
			method_name: "GoPay",
			gateway_token: "tok_minimal",
		};
		const method = await createSavedMethod("merch_E", minimal);
		expect(method.masked_identifier).toBeNull();
		expect(method.expires_at).toBeNull();
	});
});

describe("getSavedMethodById", () => {
	test("returns method by id for owning merchant", async () => {
		const created = await createSavedMethod("merch_F", baseInput);
		const found = await getSavedMethodById("merch_F", created.id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe(created.id);
	});

	test("returns null for non-existent id", async () => {
		const found = await getSavedMethodById("merch_F", "nonexistent");
		expect(found).toBeNull();
	});

	test("returns null for other merchant's method (isolation)", async () => {
		const created = await createSavedMethod("merch_G1", baseInput);
		const found = await getSavedMethodById("merch_G2", created.id);
		expect(found).toBeNull();
	});
});

describe("findByUniqueKey", () => {
	test("finds existing by unique key", async () => {
		const created = await createSavedMethod("merch_H", baseInput);
		const found = await findByUniqueKey("merch_H", "midtrans", "tok_abc123");
		expect(found).not.toBeNull();
		expect(found!.id).toBe(created.id);
	});

	test("returns null for non-existent", async () => {
		const found = await findByUniqueKey("merch_H", "midtrans", "tok_nope");
		expect(found).toBeNull();
	});
});

describe("deleteSavedMethod", () => {
	test("deletes own method and returns 1", async () => {
		const created = await createSavedMethod("merch_I", baseInput);
		const deleted = await deleteSavedMethod("merch_I", created.id);
		expect(deleted).toBe(1);
		const found = await getSavedMethodById("merch_I", created.id);
		expect(found).toBeNull();
	});

	test("returns 0 for non-existent id", async () => {
		const deleted = await deleteSavedMethod("merch_I", "nonexistent");
		expect(deleted).toBe(0);
	});

	test("returns 0 when trying to delete other merchant's method (isolation)", async () => {
		const created = await createSavedMethod("merch_J1", baseInput);
		const deleted = await deleteSavedMethod("merch_J2", created.id);
		expect(deleted).toBe(0);
		// Original should still exist
		const found = await getSavedMethodById("merch_J1", created.id);
		expect(found).not.toBeNull();
	});
});

describe("listSavedMethods returns all methods", () => {
	test("returns all methods for merchant", async () => {
		await createSavedMethod("merch_K", { ...baseInput, gateway_token: "tok_1", method_name: "First" });
		await createSavedMethod("merch_K", { ...baseInput, gateway_token: "tok_2", method_name: "Second" });
		await createSavedMethod("merch_K", { ...baseInput, gateway_token: "tok_3", method_name: "Third" });
		const methods = await listSavedMethods("merch_K");
		expect(methods.length).toBe(3);
		// Just verify all three are present
		const names = methods.map(m => m.method_name).sort();
		expect(names).toEqual(["First", "Second", "Third"]);
	});
});