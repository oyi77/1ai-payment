/**
 * Nexus Fulfillment —
 * converts a confirmed Scalev payment into a Telegram invite delivery.
 *
 * Flow:
 *   1. Extract variant name from raw webhook payload
 *   2. Look up product config → get tier, duration
 *   3. Upsert customer record
 *   4. Create subscription with expires_at
 *   5. Generate Telegram chat invite link
 *   6. Send invite link to the chat (or log for manual follow-up)
 *   7. Store invite link + chat_id in subscription row
 *
 * @todo
 *   - Confirm Scalev webhook payload structure with 1 real test order.
 *   - Wire actual TelegramBot API call to DM the customer.
 */

import { getDb } from "../config/database";
import { getConfig } from "../config/env";
import { generateEventId } from "../utils/crypto";
import { logger } from "../utils/logger";
import { extractVariantFromPayload, getProductByVariant } from "./nexus-config";

const TELEGRAM_API = "https://api.telegram.org";

export interface FulfillmentResult {
	success: boolean;
	customerId?: string;
	subscriptionId?: string;
	inviteLink?: string;
	error?: string;
}

/**
 * Main entry: called from webhook route when a Scalev payment
 * arrives with no matching order (direct checkout).
 */
export async function handleNexusPayment(
	gatewayName: string,
	body: Record<string, unknown>,
	customerEmail: string | undefined,
	customerName: string | undefined,
): Promise<FulfillmentResult> {
	if (gatewayName !== "scalev") {
		return { success: false, error: "Not a Scalev payment" };
	}

	const variant = extractVariantFromPayload(body);
	if (!variant) {
		logger.warn(
			"Nexus: cannot extract variant from payload — log raw for debugging",
		);
		return { success: false, error: "Unknown variant" };
	}

	const product = getProductByVariant(variant);
	if (!product) {
		logger.warn(
			`Nexus: no product config for variant "${variant}" — add to NEXUS_VARIANT_MAP env`,
		);
		return { success: false, error: `Unrecognized variant: ${variant}` };
	}

	logger.info("Nexus: processing payment", {
		variant,
		tier: product.tier,
		durationDays: product.durationDays,
		email: customerEmail,
		name: customerName,
	});

	try {
		return await fulfillOrder(product, customerEmail, customerName);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Nexus: fulfillment failed", { error: msg });
		return { success: false, error: msg };
	}
}

async function fulfillOrder(
	product: { tier: string; label: string; durationDays: number },
	customerEmail: string | undefined,
	customerName: string | undefined,
): Promise<FulfillmentResult> {
	const db = getDb();
	const config = getConfig();

	// 1. Upsert customer
	const customerId = generateEventId();
	const now = new Date().toISOString().replace("T", " ").slice(0, 19); // SQLite ISO

	// Try to find existing customer by email
	let dbCustomerId: string;
	if (customerEmail) {
		const existing = await db.execute({
			sql: "SELECT id FROM nexus_customers WHERE email = ?",
			args: [customerEmail],
		});
		if (existing.rows.length > 0) {
			dbCustomerId = String(existing.rows[0].id);
			await db.execute({
				sql: "UPDATE nexus_customers SET name = ?, updated_at = ? WHERE id = ?",
				args: [customerName ?? null, now, dbCustomerId],
			});
		} else {
			dbCustomerId = customerId;
			await db.execute({
				sql: `INSERT INTO nexus_customers (id, email, name, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
				args: [dbCustomerId, customerEmail, customerName ?? null, now, now],
			});
		}
	} else {
		// No email — create anonymous customer
		dbCustomerId = customerId;
		await db.execute({
			sql: `INSERT INTO nexus_customers (id, name, created_at, updated_at)
            VALUES (?, ?, ?, ?)`,
			args: [dbCustomerId, customerName ?? "Anonymous", now, now],
		});
	}

	// 2. Calculate expiration
	const expiresAt = new Date(Date.now() + product.durationDays * 86400_000)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);

	// 3. Create subscription
	const subId = generateEventId();
	const channelId = config.NEXUS_TELEGRAM_CHANNEL_ID;
	const botToken = config.NEXUS_TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN;

	// 4. Generate Telegram invite link
	let inviteLink: string | undefined;
	if (channelId && botToken) {
		inviteLink = await generateTelegramInviteLink(botToken, channelId);
	}

	await db.execute({
		sql: `INSERT INTO nexus_subscriptions
          (id, customer_id, tier, variant, status, telegram_invite_link, telegram_chat_id, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
		args: [
			subId,
			dbCustomerId,
			product.tier,
			product.label,
			inviteLink ?? null,
			channelId || null,
			expiresAt,
			now,
			now,
		],
	});

	logger.info("Nexus: subscription created", {
		subId,
		customerId: dbCustomerId,
		tier: product.tier,
		expiresAt,
		inviteLink: inviteLink ? "created" : "none",
	});

	// 5. @todo send invite link to customer via Telegram DM
	//    Need customer's telegram_username or chat_id from checkout flow.
	//    For now, invite link is stored — admin can share manually.

	return {
		success: true,
		customerId: dbCustomerId,
		subscriptionId: subId,
		inviteLink,
	};
}

/**
 * Create a Telegram chat invite link using the Bot API.
 * Uses createChatInviteLink with a 1-day expiration by default.
 */
async function generateTelegramInviteLink(
	botToken: string,
	chatId: string,
): Promise<string | undefined> {
	try {
		const url = `${TELEGRAM_API}/bot${botToken}/createChatInviteLink`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: chatId,
				member_limit: 1,
				expire_date: Math.floor(Date.now() / 1000) + 86400, // 24h
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			logger.error("Nexus: Telegram API error", {
				status: res.status,
				body: text,
			});
			return undefined;
		}

		const data = (await res.json()) as {
			ok: boolean;
			result?: { invite_link: string };
			description?: string;
		};
		if (!data.ok) {
			logger.error("Nexus: Telegram API returned error", {
				description: data.description,
			});
			return undefined;
		}

		return data.result?.invite_link;
	} catch (err: unknown) {
		logger.error("Nexus: Telegram API request failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

/**
 * Helper to revoke a Telegram invite link.
 */
export async function revokeTelegramInviteLink(
	botToken: string,
	chatId: string,
): Promise<void> {
	try {
		const url = `${TELEGRAM_API}/bot${botToken}/revokeChatInviteLink`;
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId }),
		});
	} catch (err: unknown) {
		logger.warn("Nexus: failed to revoke invite link", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
