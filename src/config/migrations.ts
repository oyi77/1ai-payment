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

import type { Client } from "@libsql/client";
import { logger } from "../utils/logger";

interface Migration {
	version: string; // e.g. '001', '002'
	name: string; // short description
	run: (db: Client) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
	{
		version: "001",
		name: "Initial schema seed",
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
		version: "002",
		name: "Nexus tables for 1ai-product delivery",
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
	{
		version: "003",
		name: "Forward status, dead-letter replay, refund dedup",
		run: async (db: Client) => {
			// orders.forward_status — last forward HTTP status.
			// markForwarded no longer overwrites the payment status.
			try {
				await db.execute(
					"ALTER TABLE orders ADD COLUMN forward_status INTEGER",
				);
			} catch {
				// column already exists
			}

			// dead_letter_events.replayed_at — set when a dead letter is re-forwarded.
			try {
				await db.execute(
					"ALTER TABLE dead_letter_events ADD COLUMN replayed_at TEXT",
				);
			} catch {
				// column already exists
			}

			// Refund dedup — prevent a duplicate gateway refund for the same order.
			await db.execute(
				"CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_order_gateway_ref ON refunds(order_id, gateway_refund_id) WHERE gateway_refund_id IS NOT NULL",
			);
		},
	},
	{
		version: "004",
		name: "Atomic dedupe for unknown-order webhook events",
		run: async (db: Client) => {
			// Webhooks for orders not in the DB store order_id = NULL, so the
			// idx_webhook_events_dedup index (WHERE order_id IS NOT NULL) cannot
			// dedupe them. They store gateway_reference = the raw reference or a
			// fingerprint (JSON of event fields incl. status), so this partial
			// unique index makes the SELECT-then-INSERT guard atomic: identical
			// duplicate callbacks collide, while pending vs success still both
			// insert (different status values).
			await db.execute(
				"DELETE FROM webhook_events WHERE order_id IS NULL AND id NOT IN (SELECT MIN(id) FROM webhook_events WHERE order_id IS NULL GROUP BY gateway, gateway_reference, status)",
			);
			await db.execute(
				"CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_unknown_dedup ON webhook_events(gateway, gateway_reference, status) WHERE order_id IS NULL",
			);
		},
	},
	{
		version: "005",
		name: "Add idempotency_key to refunds table",
		run: async (db: Client) => {
			// refunds.idempotency_key backs the createRefund dedupe guard
			// (getRefundByIdempotencyKey) but was missing from the 001 schema.
			await db.execute("ALTER TABLE refunds ADD COLUMN idempotency_key TEXT");
			await db.execute(
				"CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idempotency ON refunds(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL",
			);
		},
	},
	{
		version: "006",
		name: "Add saved_payment_methods table",
		run: async (db: Client) => {
			// saved_payment_methods backs the merchant-scoped vault of reusable
			// gateway tokens (saved cards / e-wallets) so customers can pay
			// without re-entering details. UNIQUE(merchant_id, gateway, token)
			// makes createSavedMethod idempotent per merchant.
			// NOTE: multi-statement SQL MUST use executeMultiple — libsql execute()
			// runs only the first statement, which silently skipped the UNIQUE
			// index below (idempotency race) until this fix.
			await db.executeMultiple(`
				CREATE TABLE IF NOT EXISTS saved_payment_methods (
					id TEXT PRIMARY KEY,
					merchant_id TEXT NOT NULL,
					gateway TEXT NOT NULL,
					method_code TEXT NOT NULL,
					method_name TEXT NOT NULL,
					gateway_token TEXT NOT NULL,
					masked_identifier TEXT,
					expires_at TEXT,
					created_at TEXT DEFAULT (datetime('now'))
				);
				CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_methods_unique
					ON saved_payment_methods(merchant_id, gateway, gateway_token);
				CREATE INDEX IF NOT EXISTS idx_saved_methods_merchant
					ON saved_payment_methods(merchant_id);
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
	const result = await db.execute(
		"SELECT version FROM _migrations ORDER BY version",
	);
	const applied = new Set(result.rows.map((r) => String(r.version)));

	for (const m of MIGRATIONS) {
		if (applied.has(m.version)) continue;

		logger.info(`Running migration ${m.version}: ${m.name}`);
		await m.run(db);

		await db.execute({
			sql: "INSERT INTO _migrations (version, name) VALUES (?, ?)",
			args: [m.version, m.name],
		});

		logger.info(`Migration ${m.version} applied`);
	}
}
