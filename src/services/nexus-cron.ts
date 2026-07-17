/**
 * Nexus Cron — periodic maintenance for subscriptions.
 *
 * Runs every 6 hours:
 *   1. Send expiry reminders (48h before expiry)
 *   2. Revoke access for expired subscriptions (set status → 'expired')
 *   3. Clean up stale invite links
 *
 * @todo Implement Telegram DM sending for reminders.
 *       Currently logs actions only — needs customer contact channel.
 */

import { getDb } from "../config/database";
import { getConfig } from "../config/env";
import { logger } from "../utils/logger";
import { revokeTelegramInviteLink } from "./nexus-fulfillment";

const SIX_HOURS_MS = 6 * 60 * 60_000;

let cronHandle: Timer | null = null;

export function startNexusCron(): void {
	if (cronHandle) return; // already running

	logger.info("Nexus cron: starting (interval=6h)");
	runNexusMaintenance(); // run once on startup too
	cronHandle = setInterval(runNexusMaintenance, SIX_HOURS_MS);
}

export function stopNexusCron(): void {
	if (cronHandle) {
		clearInterval(cronHandle);
		cronHandle = null;
		logger.info("Nexus cron: stopped");
	}
}

async function runNexusMaintenance(): Promise<void> {
	try {
		await handleExpiredSubscriptions();
		await sendExpiryReminders();
	} catch (err: unknown) {
		logger.error("Nexus cron: maintenance run failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Mark subscriptions past expires_at as 'expired'.
 * Optionally revoke the Telegram invite link if bot token is configured.
 */
async function handleExpiredSubscriptions(): Promise<void> {
	const db = getDb();
	const config = getConfig();
	const now = new Date().toISOString().replace("T", " ").slice(0, 19);

	const result = await db.execute({
		sql: `SELECT id, telegram_chat_id FROM nexus_subscriptions
          WHERE status = 'active' AND expires_at < ?`,
		args: [now],
	});

	if (result.rows.length === 0) return;

	logger.info(`Nexus cron: expiring ${result.rows.length} subscription(s)`);

	for (const row of result.rows) {
		const subId = String(row.id);

		// Revoke invite if we have bot config
		const botToken =
			config.NEXUS_TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
		if (botToken) {
			await revokeTelegramInviteLink(botToken, String(row.telegram_chat_id));
		}

		await db.execute({
			sql: `UPDATE nexus_subscriptions SET status = 'expired', updated_at = ? WHERE id = ?`,
			args: [now, subId],
		});

		logger.info("Nexus cron: expired subscription", { subId });
	}
}

/**
 * Send reminder 48h before expiry.
 * Currently logs only — @todo send via Telegram DM when we have the customer's chat_id.
 */
async function sendExpiryReminders(): Promise<void> {
	const db = getDb();
	const now = Date.now();
	const expiryThreshold = new Date(now + 48 * 60 * 60_000)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);

	const result = await db.execute({
		sql: `SELECT ns.id, ns.tier, ns.expires_at, nc.name, nc.email
          FROM nexus_subscriptions ns
          JOIN nexus_customers nc ON nc.id = ns.customer_id
          WHERE ns.status = 'active'
            AND ns.expires_at BETWEEN ? AND ?
            AND ns.reminder_sent_at IS NULL`,
		args: [
			new Date(now).toISOString().replace("T", " ").slice(0, 19),
			expiryThreshold,
		],
	});

	if (result.rows.length === 0) return;

	for (const row of result.rows) {
		const subId = String(row.id);
		const customerName = String(row.name ?? "");
		const tier = String(row.tier);
		const expiresAt = String(row.expires_at);

		logger.info("Nexus cron: expiry reminder due", {
			subId,
			customerName,
			tier,
			expiresAt,
		});

		// @todo send actual Telegram DM or email

		await db.execute({
			sql: "UPDATE nexus_subscriptions SET reminder_sent_at = ? WHERE id = ?",
			args: [new Date(now).toISOString().replace("T", " ").slice(0, 19), subId],
		});
	}
}
