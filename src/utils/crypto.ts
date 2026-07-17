/**
 * Crypto utilities — timing-safe comparison, signature generation.
 */

import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getConfig } from "../config/env";

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
export function timingSafeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Generate HMAC-SHA256 signature for forwarded events.
 */
export function signPayload(payload: string, secret: string): string {
	return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Generate unique order ID (UUID v4).
 */
export function generateOrderId(): string {
	return nanoid(21);
}

/**
 * Generate unique event ID.
 */
export function generateEventId(): string {
	return nanoid(21);
}

/**
 * SHA-256 hash (hex) — used for API key storage.
 */
export function sha256Hash(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Generate merchant ID.
 */
export function generateMerchantId(): string {
	return `merch_${nanoid(16)}`;
}

/**
 * Generate API key (raw — store hash, return key once).
 */
export function generateApiKey(): string {
	return `1pay_${crypto.randomBytes(32).toString("hex")}`;
}

/**
 * Generate webhook secret.
 */
export function generateWebhookSecret(): string {
	return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

// AES-256-GCM encryption for merchant gateway credentials
const ENC_ALGORITHM = "aes-256-gcm";
const ENC_KEY_LENGTH = 32;
const ENC_IV_LENGTH = 16;
const ENC_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
	const key = getConfig().ENCRYPTION_KEY;
	if (key.length !== 64 || !/^[0-9a-f]{64}$/i.test(key)) {
		throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
	}
	return Buffer.from(key, "hex");
}

export function encrypt(plaintext: string): string {
	const key = getEncryptionKey();
	const iv = crypto.randomBytes(ENC_IV_LENGTH);
	const cipher = crypto.createCipheriv(ENC_ALGORITHM, key, iv);
	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(ciphertext: string): string {
	const key = getEncryptionKey();
	const buf = Buffer.from(ciphertext, "base64");
	const iv = buf.subarray(0, ENC_IV_LENGTH);
	const tag = buf.subarray(ENC_IV_LENGTH, ENC_IV_LENGTH + ENC_TAG_LENGTH);
	const encrypted = buf.subarray(ENC_IV_LENGTH + ENC_TAG_LENGTH);
	const decipher = crypto.createDecipheriv(ENC_ALGORITHM, key, iv);
	decipher.setAuthTag(tag);
	return decipher.update(encrypted) + decipher.final("utf8");
}
