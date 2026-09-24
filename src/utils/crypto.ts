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
	// Reject non-printable/empty inputs first (timingSafeEqual throws on
	// mismatched buffer lengths, so normalize to a constant-time compare).
	if (typeof a !== "string" || typeof b !== "string") return false;
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) return false;
	return crypto.timingSafeEqual(bufA, bufB);
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

// Webhook-secret storage (Sweep154): merchants.webhook_secret is encrypted
// at rest with the same AES-256-GCM envelope as gateway credentials — a DB
// or backup-file read must never yield a usable signing secret.
export function encryptWebhookSecret(secret: string): string {
	return encrypt(secret);
}

/**
 * Decrypt a stored webhook secret. Returns null when the row is missing OR
 * undecryptable (wrong key, corrupt/legacy-plaintext value). Callers treat
 * null as "no usable secret" (skip forward, loud warn) — never fall back
 * to the raw stored value, which would defeat the encryption.
 */
export function decryptWebhookSecret(stored: unknown): string | null {
	if (typeof stored !== "string" || stored.length === 0) return null;
	try {
		return decrypt(stored);
	} catch {
		return null;
	}
}

// PAN guard (Sweep155): the saved-methods vault must never hold raw card
// numbers — storing PAN drags the whole DB into PCI-DSS scope. Gateway
// tokens are opaque references (tok_...), never 13–19 digit Luhn-passing
// runs. Scan every free-text vault field at the API boundary and reject.
function luhnPasses(digits: string): boolean {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

/**
 * True when text contains a PAN-like run: 13–19 digits (spaces/dashes
 * tolerated inside the run) that passes Luhn. Short runs (masked tails
 * like "4242"), phone numbers under 13 digits, and alphanumeric tokens
 * never match.
 */
export function containsPanLike(text: unknown): boolean {
	if (typeof text !== "string") return false;
	// Join digit groups split only by spaces/dashes (how PANs are typed).
	const runs = text.replace(/[^\d \-]/g, "|").split("|");
	for (const run of runs) {
		const digits = run.replace(/[\s\-]/g, "");
		if (digits.length < 13 || digits.length > 19) continue;
		if (!/^\d+$/.test(digits)) continue;
		if (luhnPasses(digits)) return true;
	}
	return false;
}
