/**
 * Admin routes — merchant management.
 *
 * - GET /api/admin/merchants — list all merchants
 *
 * All routes protected by adminAuthMiddleware (X-Admin-Key header).
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { getDb } from '../config/database';
import { adminAuthMiddleware } from '../middleware/admin-auth';
import { logger } from '../utils/logger';

export const adminRoutes = new OpenAPIHono();

// Apply admin auth to all admin routes
adminRoutes.use('*', adminAuthMiddleware());

adminRoutes.get('/admin/merchants', async (c) => {
  const db = getDb();

  try {
    const result = await db.execute(
      'SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants ORDER BY created_at DESC'
    );

    const merchants = result.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      default_callback_url: row.default_callback_url as string | null,
      active: Boolean(row.active),
      plan: row.plan as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));

    return c.json({ success: true, data: { merchants } });
  } catch (err) {
    logger.error('Failed to list merchants', { error: err });
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list merchants' } }, 500);
  }
});
