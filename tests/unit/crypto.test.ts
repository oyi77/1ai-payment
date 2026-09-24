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
	containsPanLike,
	decryptWebhookSecret,
	decrypt,
	encrypt,
	encryptWebhookSecret,
	generateApiKey,
	generateEventId,
	generateMerchantId,
	generateOrderId,
	generateWebhookSecret,
	sha256Hash,
	signPayload,
	timingSafeCompare,
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

describe("webhook-secret storage (Sweep154)", () => {
	test("stored value never contains the plaintext secret", () => {
		const secret = generateWebhookSecret();
		const stored = encryptWebhookSecret(secret);
		expect(stored).not.toContain(secret);
		expect(stored).not.toMatch(/^whsec_/);
		expect(decryptWebhookSecret(stored)).toBe(secret);
	});

	test("legacy plaintext rows decrypt to null (never used raw)", () => {
		expect(decryptWebhookSecret("whsec_legacy_plaintext")).toBeNull();
	});

	test("missing/empty rows decrypt to null", () => {
		expect(decryptWebhookSecret(null)).toBeNull();
		expect(decryptWebhookSecret(undefined)).toBeNull();
		expect(decryptWebhookSecret("")).toBeNull();
	});

	test("wrong-key ciphertext decrypts to null (no throw)", () => {
		expect(decryptWebhookSecret("aGVsbG8td29ybGQ=")).toBeNull();
	});
});

describe("containsPanLike (Sweep155 vault guard)", () => {
	test("flags textbook PANs (Visa/Mastercard test numbers)", () => {
		expect(containsPanLike("4111111111111111")).toBe(true);
		expect(containsPanLike("5500005555555559")).toBe(true);
	});

	test("flags PANs with spaces/dashes", () => {
		expect(containsPanLike("4111 1111 1111 1111")).toBe(true);
		expect(containsPanLike("5500-0055-5555-5559")).toBe(true);
	});

	test("flags PAN embedded in surrounding text", () => {
		expect(containsPanLike("my card 4111111111111111 here")).toBe(true);
	});

	test("ignores opaque tokens, names, masked tails", () => {
		expect(containsPanLike("tok_secure_abc")).toBe(false);
		expect(containsPanLike("BCA Visa")).toBe(false);
		expect(containsPanLike("•••• 4242")).toBe(false);
		expect(containsPanLike("tok_abc123")).toBe(false);
	});

	test("ignores digit runs outside 13–19 (VA-length, phones)", () => {
		expect(containsPanLike("123456789012")).toBe(false);
		expect(containsPanLike("081234567890")).toBe(false);
		expect(containsPanLike("12345678901234567890")).toBe(false);
	});

	test("ignores numeric-lookalikes that fail Luhn", () => {
		expect(containsPanLike("1234567890123456")).toBe(false);
	});

	test("non-strings never match", () => {
		expect(containsPanLike(null)).toBe(false);
		expect(containsPanLike(undefined)).toBe(false);
		expect(containsPanLike(4242)).toBe(false);
	});
});
