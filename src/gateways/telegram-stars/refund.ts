/**
 * Telegram Stars refunds.
 *
 * `refundStarPayment` identifies the purchase by the
 * `telegram_payment_charge_id` Telegram returned on successful_payment — the
 * value normalizeEvent stores as gateway_reference, so no schema change is
 * needed. The Bot API refunds the full charge only; there is no amount
 * parameter, which is why a partial request is rejected here instead of being
 * silently rounded to full.
 */
import { getDb } from "../../config/database";
import { getConfig, resolveGatewayConfig } from "../../config/env";
import { GatewayError } from "../../utils/errors";
import { logger, upstreamPreview } from "../../utils/logger";
import type { RefundResult } from "../base";

const TELEGRAM_API = "https://api.telegram.org";

/**
 * Recover the payer's Telegram user id for a charge.
 *
 * Captured into order metadata by normalizeEvent at payment time. Returns
 * undefined when the order predates that capture or the row is gone — the
 * caller then refuses the refund rather than sending a request Telegram will
 * reject.
 */
export async function getTelegramUserIdForCharge(
	gatewayRef: string,
): Promise<number | undefined> {
	try {
		const res = await getDb().execute({
			sql: "SELECT metadata FROM orders WHERE gateway = 'telegram_stars' AND gateway_reference = ? LIMIT 1",
			args: [gatewayRef],
		});
		if (res.rows.length === 0) return undefined;
		const raw = (res.rows[0] as Record<string, unknown>).metadata;
		if (typeof raw !== "string" || !raw) return undefined;
		const meta = JSON.parse(raw) as { telegram_user_id?: unknown };
		const id = Number(meta.telegram_user_id);
		return Number.isFinite(id) && id > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export async function refundStarsPayment(
	gatewayRef: string,
	amount: number,
	merchantId?: string,
	telegramUserId?: number,
): Promise<RefundResult> {
	if (!gatewayRef) {
		throw new GatewayError(
			"telegram_stars",
			"Refund requires a telegram_payment_charge_id",
		);
	}
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new GatewayError("telegram_stars", "Refund amount must be positive");
	}
	// Telegram identifies the payer, not just the charge. Without this the
	// refund is rejected upstream, so fail loudly before spending a request.
	if (!telegramUserId) {
		throw new GatewayError(
			"telegram_stars",
			"Refund requires the payer's telegram user_id (missing from order metadata)",
		);
	}

	const base = getConfig();
	let botToken = base.TELEGRAM_BOT_TOKEN;
	if (merchantId) {
		try {
			const resolved = (await resolveGatewayConfig(
				"telegram_stars",
				merchantId,
			)) as { botToken?: string };
			botToken = resolved.botToken || botToken;
		} catch {
			// Platform token remains the fallback.
		}
	}
	if (!botToken) {
		throw new GatewayError(
			"telegram_stars",
			"TELEGRAM_BOT_TOKEN not configured",
		);
	}

	try {
		const res = await fetch(
			`${TELEGRAM_API}/bot${botToken}/refundStarPayment`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					user_id: telegramUserId,
					telegram_payment_charge_id: gatewayRef,
				}),
				signal: AbortSignal.timeout(15_000),
			},
		);

		if (!res.ok) {
			const text = await res.text();
			logger.error("Telegram Stars refund rejected", {
				status: res.status,
				error: upstreamPreview(text),
			});
			throw new GatewayError(
				"telegram_stars",
				`Refund failed: ${res.status} ${upstreamPreview(text)}`,
			);
		}
	} catch (err: unknown) {
		if (err instanceof GatewayError) throw err;
		logger.error("Telegram Stars refund failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		throw new GatewayError("telegram_stars", "Refund request failed");
	}

	return { gatewayRefundId: `refund_${gatewayRef}`, status: "success" };
}
