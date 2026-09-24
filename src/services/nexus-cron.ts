/**
 * Nexus Cron — periodic maintenance for subscriptions.
 *
 * Runs every 6 hours:
 *   1. Send expiry reminders (48h before expiry)
 *   2. Revoke access for expired subscriptions (set status → 'expired')
 *   3. Clean up stale invite links
 *
 * Sends expiry-reminder DMs when NEXUS_TELEGRAM_BOT_TOKEN/TELEGRAM_BOT_TOKEN
 * is set and the subscription row carries a telegram_chat_id; otherwise
 * logs only (safe no-token fallback).
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
		// Backup failures must never fail maintenance (own try/catch + warn).
		try {
			const { backupDatabase } = await import("../config/database");
			await backupDatabase();
		} catch (backupErr: unknown) {
			logger.warn("Nexus cron: database backup failed", {
				error:
					backupErr instanceof Error ? backupErr.message : String(backupErr),
			});
		}
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
/**
 * Send a Telegram DM via Bot API. Throws on API failure so callers can
 * fall back (log-only). Same fire-safe pattern as revokeTelegramInviteLink.
 */
async function sendTelegramMessage(
	botToken: string,
	chatId: string,
	text: string,
): Promise<void> {
	const res = await fetch(
		`https://api.telegram.org/bot${botToken}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (!res.ok) {
		throw new Error(`Telegram sendMessage ${res.status}: ${await res.text()}`);
	}
}

export async function handleExpiredSubscriptions(): Promise<void> {
	const db = getDb();
	const config = getConfig();
	const now = new Date().toISOString().replace("T", " ").slice(0, 19);

	const result = await db.execute({
		sql: `SELECT id, telegram_chat_id, telegram_invite_link FROM nexus_subscriptions
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
		if (botToken && row.telegram_invite_link && row.telegram_chat_id) {
			await revokeTelegramInviteLink(
				botToken,
				String(row.telegram_chat_id),
				String(row.telegram_invite_link),
			);
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
 * Sends a real Telegram DM when the subscription row has a telegram_chat_id
 * AND a bot token is configured; otherwise falls back to log-only.
 */
export async function sendExpiryReminders(): Promise<void> {
	const db = getDb();
	const config = getConfig();
	const botToken = config.NEXUS_TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;
	const now = Date.now();
	const expiryThreshold = new Date(now + 48 * 60 * 60_000)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);

	const result = await db.execute({
		sql: `SELECT ns.id, ns.tier, ns.expires_at, ns.telegram_chat_id, nc.name, nc.email
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
		const chatId = String(row.telegram_chat_id ?? "");

		if (botToken && chatId) {
			try {
				const publicBase = getConfig().PUBLIC_BASE_URL.replace(/\/$/, "");
				await sendTelegramMessage(
					botToken,
					chatId,
					`Halo ${customerName}! Langganan ${tier} kamu berakhir ${expiresAt}. Perpanjang di ${publicBase} agar akses tidak terputus.`,
				);
				logger.info("Nexus cron: expiry reminder DM sent", {
					subId,
					tier,
				});
			} catch (err: unknown) {
				logger.warn("Nexus cron: reminder DM failed, falling back to log", {
					subId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		} else {
			logger.info("Nexus cron: expiry reminder due", {
				subId,
				tier,
				expiresAt,
			});
		}

		await db.execute({
			sql: "UPDATE nexus_subscriptions SET reminder_sent_at = ? WHERE id = ?",
			args: [new Date(now).toISOString().replace("T", " ").slice(0, 19), subId],
		});
	}
}
