/**
 * API key authentication middleware.
 *
 * Looks up API key hash in merchants table first.
 * Falls back to env API_KEY for backward compatibility.
 * Sets merchantId and merchantName on context for downstream use.
 *
 * Webhook endpoints use signature verification instead.
 */

import type { Context, Next } from 'hono';
import { getConfig } from '../config/env';
import { getDb } from '../config/database';
import { sha256Hash } from '../utils/crypto';

export async function authMiddleware(c: Context, next: Next) {
  const apiKey = c.req.header('X-API-Key');
  const adminKey = c.req.header('X-Admin-Key');

  // Skip merchant auth if admin key is present — admin routes have their own auth.
  if (!apiKey && adminKey) {
    await next();
    return;
  }

  if (!apiKey) {
    return c.json({ success: false as const, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' } }, 401);
  }

  // Try merchants table first
  const db = getDb();
  const keyHash = sha256Hash(apiKey);
  const result = await db.execute({
    sql: 'SELECT id, name, plan, active FROM merchants WHERE api_key_hash = ?',
    args: [keyHash],
  });

  if (result.rows.length > 0) {
    const merchant = result.rows[0];
    if (!merchant.active) {
      return c.json({ success: false as const, error: { code: 'MERCHANT_DISABLED', message: 'Merchant account is disabled' } }, 403);
    }
    c.set('merchantId', merchant.id as string);
    c.set('merchantName', merchant.name as string);
    c.set('merchantPlan', (merchant.plan as string) ?? 'free');
    await next();
    return;
  }

  // Fallback: env API_KEY (backward compatibility for existing consumers)
  const config = getConfig();
  if (apiKey === config.API_KEY) {
    c.set('merchantId', 'merch_default');
    c.set('merchantName', 'Default');
    c.set('merchantPlan', 'free');
    await next();
    return;
  }

  return c.json({ success: false as const, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' } }, 401);
}
