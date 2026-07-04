/**
 * Database configuration — LibSQL/SQLite for order registry.
 */

import { createClient, type Client } from '@libsql/client';
import { getConfig } from './env';
import { logger } from '../utils/logger';

let db: Client | null = null;

export function getDb(): Client {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export async function initDatabase(): Promise<void> {
  const config = getConfig();
  db = createClient({ url: `file:${config.DATABASE_PATH}` });

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_order_id TEXT,
      callback_url TEXT NOT NULL,
      gateway TEXT NOT NULL,
      gateway_reference TEXT,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'IDR',
      payment_method TEXT,
      payment_url TEXT,
      status TEXT DEFAULT 'pending',
      metadata TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      forwarded_at TEXT,
      forward_attempts INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_gateway ON orders(gateway);
    CREATE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(idempotency_key);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      gateway TEXT NOT NULL,
      order_id TEXT,
      gateway_reference TEXT,
      status TEXT,
      signature_valid INTEGER DEFAULT 0,
      forwarded INTEGER DEFAULT 0,
      forward_status INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_gateway ON webhook_events(gateway);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at);
  `);

  logger.info('Database initialized');
}
