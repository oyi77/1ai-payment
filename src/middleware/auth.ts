/**
 * API key authentication middleware.
 *
 * Webhook endpoints use signature verification instead.
 * API endpoints require X-API-Key header.
 */

import type { Context, Next } from 'hono';
import { getConfig } from '../config/env';

export async function authMiddleware(c: Context, next: Next) {
  const apiKey = c.req.header('X-API-Key');
  const config = getConfig();

  if (!apiKey || apiKey !== config.API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
}
