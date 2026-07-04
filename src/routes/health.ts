/**
 * Health route — service health check.
 *
 * No authentication required.
 */

import { Hono } from 'hono';
import { getDb } from '../config/database';
import { getGatewayHealth } from '../services/gateway.service';

export const healthRoutes = new Hono();

healthRoutes.get('/health', async (c) => {
  let databaseOk = true;
  try {
    const db = getDb();
    await db.execute('SELECT 1');
  } catch {
    databaseOk = false;
  }

  const gateways = getGatewayHealth();
  const gatewayStatus: Record<string, string> = {};
  for (const [name, status] of Object.entries(gateways)) {
    gatewayStatus[name] = status.configured ? 'configured' : 'missing_key';
  }

  return c.json({
    status: databaseOk ? 'ok' : 'degraded',
    version: '0.2.0',
    uptime: process.uptime(),
    database: databaseOk ? 'ok' : 'error',
    gateways: gatewayStatus,
  });
});
