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
