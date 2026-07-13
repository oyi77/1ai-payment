/**
 * Database configuration — LibSQL/SQLite for order registry.
 */

import { createClient, type Client } from '@libsql/client';
import { getConfig } from './env';
import { logger } from '../utils/logger';
import { runMigrations } from './migrations';
import { sha256Hash, generateWebhookSecret } from '../utils/crypto';

let db: Client | null = null;

export function getDb(): Client {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export async function initDatabase(): Promise<void> {
  const config = getConfig();
  db = createClient({ url: `file:${config.DATABASE_PATH}` });

  // Core tables (safe to run every boot)
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

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      gateway TEXT NOT NULL,
      order_id TEXT,
      gateway_reference TEXT,
      status TEXT,
      raw_payload TEXT,
      headers TEXT,
      signature_valid INTEGER DEFAULT 0,
      forwarded INTEGER DEFAULT 0,
      forward_status INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_gateway ON webhook_events(gateway);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_dedup
      ON webhook_events(order_id, gateway, status)
      WHERE order_id IS NOT NULL;

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

    CREATE TABLE IF NOT EXISTS merchant_gateways (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      gateway TEXT NOT NULL,
      credentials TEXT NOT NULL,
      environment TEXT DEFAULT 'sandbox',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(merchant_id, gateway)
    );

    CREATE INDEX IF NOT EXISTS idx_merchant_gateways_merchant ON merchant_gateways(merchant_id);

    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      gateway TEXT NOT NULL,
      gateway_refund_id TEXT,
      status TEXT DEFAULT 'pending',
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
    CREATE INDEX IF NOT EXISTS idx_refunds_merchant ON refunds(merchant_id);
  `);
  // Dead letter queue for failed forward events
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS dead_letter_events (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      gateway TEXT NOT NULL,
      event_data TEXT NOT NULL,
      error TEXT,
      attempts INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dead_letter_order ON dead_letter_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_dead_letter_created ON dead_letter_events(created_at);
  `);

  // Idempotent column additions (ALTER TABLE doesn't support IF NOT EXISTS)
  for (const col of ['merchant_id TEXT', 'fee INTEGER DEFAULT 0', 'net INTEGER DEFAULT 0']) {
    try {
      await db.execute(`ALTER TABLE orders ADD COLUMN ${col}`);
    } catch { /* column already exists */ }
  }

  // Backfill webhook_events columns for existing databases
  for (const col of ['raw_payload TEXT', 'headers TEXT']) {
    try {
      await db.execute(`ALTER TABLE webhook_events ADD COLUMN ${col}`);
    } catch { /* column already exists */ }
  }

  // Backfill merchant_id for existing orders
  await db.execute("UPDATE orders SET merchant_id = project_id WHERE merchant_id IS NULL");

  // Per-merchant idempotency index (requires merchant_id column to exist)
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_orders_merchant_idempotency ON orders(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL'
  );

  // Seed default merchant from env API_KEY if no merchants exist
  const existing = await db.execute('SELECT COUNT(*) as count FROM merchants');
  if ((existing.rows[0]?.count ?? 0) === 0) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO merchants (id, name, api_key_hash, webhook_secret, active)
            VALUES ('merch_default', 'Default', ?, ?, 1)`,
      args: [sha256Hash(config.API_KEY), generateWebhookSecret()],
    });
    logger.info('Default merchant seeded from env API_KEY');
  }

  // Run pending schema migrations
  await runMigrations(db);
  logger.info('Database initialized');
}
