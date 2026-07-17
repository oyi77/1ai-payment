/**
 * Unit tests for Crypto utilities — pure functions, no DB needed.
 *
 * Covers: timingSafeCompare, signPayload, generateOrderId, generateEventId,
 * sha256Hash, generateMerchantId, generateApiKey, generateWebhookSecret,
 * encrypt, decrypt.
 */

import { describe, expect, test } from "bun:test";
import { resetConfigCache } from "../../src/config/env";

// ENCRYPTION_KEY is required by encrypt/decrypt (64-char hex)
process.env.ENCRYPTION_KEY = "f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.NODE_ENV = "test";
resetConfigCache();

import {
	generateOrderId,
	generateEventId,
	sha256Hash,
	timingSafeCompare,
	signPayload,
	encrypt,
	decrypt,
	generateApiKey,
	generateWebhookSecret,
	generateMerchantId,
} from "../../src/utils/crypto";

describe("generateOrderId", () => {
	test("returns a string of length 21", () => {
		const id = generateOrderId();
		expect(id).toHaveLength(21);
	});

	test("generates unique values", () => {
		const a = generateOrderId();
		const b = generateOrderId();
		expect(a).not.toBe(b);
	});
});

describe("generateEventId", () => {
	test("returns a string of length 21", () => {
		const id = generateEventId();
		expect(id).toHaveLength(21);
	});
});

describe("sha256Hash", () => {
	test("produces deterministic hex output", () => {
		const h1 = sha256Hash("hello");
		const h2 = sha256Hash("hello");
		expect(h1).toBe(h2);
		expect(h1).toHaveLength(64);
		expect(h1).toMatch(/^[0-9a-f]{64}$/);
	});

	test("different inputs produce different hashes", () => {
		const a = sha256Hash("abc");
		const b = sha256Hash("xyz");
		expect(a).not.toBe(b);
	});
});

describe("timingSafeCompare", () => {
	test("returns true for equal strings", () => {
		expect(timingSafeCompare("abc", "abc")).toBe(true);
	});

	test("returns false for unequal strings", () => {
		expect(timingSafeCompare("abc", "xyz")).toBe(false);
	});

	test("returns false when lengths differ", () => {
		expect(timingSafeCompare("short", "longer")).toBe(false);
	});

	test("empty strings are equal", () => {
		expect(timingSafeCompare("", "")).toBe(true);
	});
});

describe("signPayload", () => {
	test("returns HMAC-SHA256 hex signature", () => {
		const sig = signPayload('{"key":"value"}', "mysecret");
		expect(sig).toMatch(/^[0-9a-f]{64}$/);
	});

	test("same input produces same signature", () => {
		const a = signPayload("data", "key1");
		const b = signPayload("data", "key1");
		expect(a).toBe(b);
	});

	test("different keys produce different signatures", () => {
		const a = signPayload("data", "key1");
		const b = signPayload("data", "key2");
		expect(a).not.toBe(b);
	});
});

describe("generateMerchantId", () => {
	test("starts with merch_", () => {
		const id = generateMerchantId();
		expect(id).toMatch(/^merch_/);
	});

	test("has reasonable length", () => {
		const id = generateMerchantId();
		expect(id.length).toBeGreaterThan(18);
	});
});

describe("generateApiKey", () => {
	test("starts with 1pay_", () => {
		const key = generateApiKey();
		expect(key).toMatch(/^1pay_/);
	});

	test("is reasonably long (hex part is 64 chars)", () => {
		const key = generateApiKey();
		expect(key.length).toBeGreaterThan(60);
	});

	test("generates unique keys", () => {
		const a = generateApiKey();
		const b = generateApiKey();
		expect(a).not.toBe(b);
	});
});

describe("generateWebhookSecret", () => {
	test("starts with whsec_", () => {
		const secret = generateWebhookSecret();
		expect(secret).toMatch(/^whsec_/);
	});
});

describe("encrypt / decrypt", () => {
	test("round-trip: encrypt then decrypt returns original", () => {
		const original = '{"api_key":"sk_test_123"}';
		const encrypted = encrypt(original);
		expect(encrypted).toBeTruthy();
		expect(encrypted).not.toBe(original);
		const decrypted = decrypt(encrypted);
		expect(decrypted).toBe(original);
	});

	test("produces different ciphertexts for same plaintext (random IV)", () => {
		const plain = "same-data";
		const a = encrypt(plain);
		const b = encrypt(plain);
		expect(a).not.toBe(b);
	});

	test("decrypt returns original for empty string", () => {
		const encrypted = encrypt("");
		const decrypted = decrypt(encrypted);
		expect(decrypted).toBe("");
	});

	test("thrown on invalid ciphertext", () => {
		expect(() => decrypt("invalid-base64!!!")).toThrow();
	});
});
