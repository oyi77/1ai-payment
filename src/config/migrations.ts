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
