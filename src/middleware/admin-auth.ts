/**
 * Admin authentication middleware.
 *
 * Validates X-Admin-Key header against configured ADMIN_API_KEY.
 * Applied to /api/admin/* routes.
 */

import type { Context, Next } from 'hono';
import { getConfig } from '../config/env';
import { timingSafeCompare } from '../utils/crypto';

export function adminAuthMiddleware() {
  return async (c: Context, next: Next) => {
    const config = getConfig();
    const adminKey = c.req.header('X-Admin-Key');

    if (!adminKey || !timingSafeCompare(adminKey, config.ADMIN_API_KEY)) {
      return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid admin key' } }, 401);
    }

    await next();
  };
}
