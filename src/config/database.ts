/**
 * Database configuration — LibSQL/SQLite for order registry.
 */

import { createClient, type Client } from '@libsql/client';
import { getConfig } from './env';
import { logger } from '../utils/logger';
import { sha256Hash, generateWebhookSecret } from '../utils/crypto';

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
    CREATE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(idempotency_key);

    -- Per-merchant idempotency (Step 1.6)
    -- merchant_id column added for multi-tenant scoping
    -- Existing orders get merchant_id = project_id via migration
    ALTER TABLE orders ADD COLUMN merchant_id TEXT;
    UPDATE orders SET merchant_id = project_id WHERE merchant_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_orders_merchant_idempotency ON orders(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

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
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      webhook_secret TEXT NOT NULL,
      default_callback_url TEXT,
      active INTEGER DEFAULT 1,
      plan TEXT DEFAULT 'free',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_merchants_api_key ON merchants(api_key_hash);
  `);

  // Seed default merchant from env API_KEY if no merchants exist
  const config2 = getConfig();
  const existing = await db.execute('SELECT COUNT(*) as count FROM merchants');
  if ((existing.rows[0]?.count ?? 0) === 0) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO merchants (id, name, api_key_hash, webhook_secret, active)
            VALUES ('merch_default', 'Default', ?, ?, 1)`,
      args: [sha256Hash(config2.API_KEY), generateWebhookSecret()],
    });
    logger.info('Default merchant seeded from env API_KEY');
  }

  logger.info('Database initialized');

}