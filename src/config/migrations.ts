/**
 * Database migration system —
 * tracks applied DDL changes so every deploy runs only pending migrations.
 *
 * Usage:
 *   1. Add a new entry to `MIGRATIONS` with the next version number.
 *   2. The SQL in `run` is applied once; the version is recorded in `_migrations`.
 *   3. On startup `runMigrations()` is called from `database.ts`.
 *
 * NEVER edit or re-order already-deployed migrations. Append only.
 */

import { type Client } from '@libsql/client';
import { logger } from '../utils/logger';

interface Migration {
  version: string;    // e.g. '001', '002'
  name: string;       // short description
  run: (db: Client) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: '001',
    name: 'Initial schema seed',
    run: async (db: Client) => {
      // All tables already use CREATE TABLE IF NOT EXISTS.
      // This migration exists to mark the baseline so future
      // migrations know v001 has been applied.
      //
      // Future DDL changes go in version 002, 003, etc.
      // Example:
      //   await db.execute("ALTER TABLE orders ADD COLUMN new_col TEXT");
    },
  },
  {
    version: '002',
    name: 'Nexus tables for 1ai-product delivery',
    run: async (db: Client) => {
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS nexus_customers (
          id TEXT PRIMARY KEY,
          email TEXT,
          name TEXT,
          telegram_username TEXT,
          whatsapp TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS nexus_subscriptions (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES nexus_customers(id),
          tier TEXT NOT NULL,
          variant TEXT NOT NULL,
          scalev_order_id TEXT,
          status TEXT DEFAULT 'active',
          telegram_invite_link TEXT,
          telegram_chat_id TEXT,
          expires_at TEXT,
          reminder_sent_at TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_nexus_subs_customer ON nexus_subscriptions(customer_id);
        CREATE INDEX IF NOT EXISTS idx_nexus_subs_status ON nexus_subscriptions(status);
        CREATE INDEX IF NOT EXISTS idx_nexus_subs_scalev ON nexus_subscriptions(scalev_order_id);
      `);
    },
  },
];

export async function runMigrations(db: Client): Promise<void> {
  // Ensure the tracking table exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Fetch versions already applied
  const result = await db.execute('SELECT version FROM _migrations ORDER BY version');
  const applied = new Set(result.rows.map((r) => String(r.version)));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;

    logger.info(`Running migration ${m.version}: ${m.name}`);
    await m.run(db);

    await db.execute({
      sql: 'INSERT INTO _migrations (version, name) VALUES (?, ?)',
      args: [m.version, m.name],
    });

    logger.info(`Migration ${m.version} applied`);
  }
}
