/**
 * Crypto utilities — timing-safe comparison, signature generation.
 */

import crypto from 'crypto';
import { nanoid } from 'nanoid';

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
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
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
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Generate merchant ID.
 */
export function generateMerchantId(): string {
  return 'merch_' + nanoid(16);
}

/**
 * Generate API key (raw — store hash, return key once).
 */
export function generateApiKey(): string {
  return '1pay_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Generate webhook secret.
 */
export function generateWebhookSecret(): string {
  return 'whsec_' + crypto.randomBytes(32).toString('hex');
}
