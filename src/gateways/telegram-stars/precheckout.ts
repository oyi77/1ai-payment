/**
 * Telegram Stars pre-checkout approval.
 *
 * Telegram sends a `pre_checkout_query` update when the buyer presses Pay and
 * requires `answerPreCheckoutQuery` within 10 seconds — otherwise the payment
 * is cancelled and the buyer sees a failure. Before this module existed the
 * gateway only *normalized* the update (status "pending") and never answered,
 * so every real Stars payment died at this step regardless of credentials.
 *
 * Approval policy: approve only when the invoice payload names an order we
 * actually created and the amount matches what we asked for. Everything else
 * is rejected with a human-readable reason, which Telegram shows to the buyer.
 */
import { getConfig, resolveGatewayConfig } from "../../config/env";
import { getOrderById } from "../../services/order.service";
import { logger, upstreamPreview } from "../../utils/logger";

const TELEGRAM_API = "https://api.telegram.org";
const ANSWER_TIMEOUT_MS = 8_000;

interface PreCheckoutQuery {
	id?: string;
	currency?: string;
	total_amount?: number;
	invoice_payload?: string;
}

export interface PreCheckoutDecision {
	ok: boolean;
	reason?: string;
	orderId?: string;
	merchantId?: string;
}

/** Extract the pre-checkout query from an update, if present. */
export function getPreCheckoutQuery(
	body: unknown,
): PreCheckoutQuery | undefined {
	const update = body as { pre_checkout_query?: PreCheckoutQuery } | null;
	return update?.pre_checkout_query;
}

/**
 * Decide whether a pre-checkout query may proceed.
 *
 * Fails closed: an unparseable payload, an unknown order, or an amount
 * mismatch all reject. Approving blindly would let a buyer pay for one order
 * and have the webhook resolve to nothing.
 */
export async function evaluatePreCheckout(
	query: PreCheckoutQuery,
): Promise<PreCheckoutDecision> {
	if (!query.id) return { ok: false, reason: "Malformed payment query." };

	let payload: { order_id?: unknown };
	try {
		payload = JSON.parse(query.invoice_payload || "{}");
	} catch {
		return { ok: false, reason: "Malformed invoice payload." };
	}

	const orderId =
		typeof payload.order_id === "string" ? payload.order_id : undefined;
	if (!orderId) return { ok: false, reason: "Invoice is missing an order." };

	const order = await getOrderById(orderId);
	if (!order) {
		return { ok: false, reason: "Order not found or already expired." };
	}

	// The invoice payload is attacker-controlled: any order id can be named.
	// Approving a non-Stars order here would let the buyer pay while the
	// subsequent successful_payment resolves against a gateway that never
	// asked for the charge.
	if (order.gateway !== "telegram_stars") {
		logger.warn("Telegram Stars pre-checkout for foreign gateway order", {
			order_id: orderId,
			order_gateway: order.gateway,
		});
		return { ok: false, reason: "This invoice is not payable here." };
	}

	// XTR is the only currency Telegram allows for digital goods.
	if (query.currency !== "XTR") {
		return { ok: false, reason: "Unsupported currency for this order." };
	}

	// Amounts are integers in the currency's smallest unit; Stars are whole.
	if (Number(query.total_amount) !== Number(order.amount)) {
		logger.warn("Telegram Stars pre-checkout amount mismatch", {
			order_id: orderId,
			expected: order.amount,
			received: query.total_amount,
		});
		return { ok: false, reason: "Payment amount does not match the order." };
	}

	if (order.status !== "pending") {
		return { ok: false, reason: "This order is no longer payable." };
	}

	return { ok: true, orderId, merchantId: order.merchant_id };
}

/**
 * Answer Telegram's pre-checkout query.
 *
 * Must complete well inside Telegram's 10s window; the request itself is
 * capped at 8s so a slow Bot API cannot turn into a silent cancellation.
 * Returns false when the answer could not be delivered (no token, network
 * error, non-2xx) so the caller can log it as a real failure.
 */
export async function answerPreCheckoutQuery(
	queryId: string,
	decision: PreCheckoutDecision,
	merchantId?: string,
): Promise<boolean> {
	const base = getConfig();
	// Telegram is a platform-credential gateway: resolveGatewayConfig merges a
	// merchant override when one exists and yields the platform identity
	// otherwise, so the resolved token is always the one that issued the
	// invoice. Only a completely absent token is a failure.
	let botToken = base.TELEGRAM_BOT_TOKEN;
	if (merchantId) {
		try {
			const resolved = (await resolveGatewayConfig(
				"telegram_stars",
				merchantId,
			)) as { botToken?: string };
			// resolveGatewayConfig already falls back to platform config, so an
			// empty value here means misconfiguration, not a missing override.
			if (!resolved.botToken) {
				logger.error(
					"Telegram Stars: gateway config resolved without a bot token",
					{ merchant_id: merchantId },
				);
				return false;
			}
			botToken = resolved.botToken;
		} catch (err: unknown) {
			logger.error("Telegram Stars: merchant gateway config unresolved", {
				merchant_id: merchantId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}
	if (!botToken) {
		logger.error("Telegram Stars: cannot answer pre-checkout, no bot token");
		return false;
	}

	const payload: Record<string, unknown> = {
		pre_checkout_query_id: queryId,
		ok: decision.ok,
	};
	if (!decision.ok && decision.reason) {
		payload.error_message = decision.reason.slice(0, 200);
	}

	try {
		const res = await fetch(
			`${TELEGRAM_API}/bot${botToken}/answerPreCheckoutQuery`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			logger.error("Telegram Stars: answerPreCheckoutQuery rejected", {
				status: res.status,
				error: upstreamPreview(text),
			});
			return false;
		}
		return true;
	} catch (err: unknown) {
		logger.error("Telegram Stars: answerPreCheckoutQuery failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/**
 * Handle a pre-checkout update end to end. Returns true when the query was
 * answered (approved or explicitly rejected), false when delivery failed.
 */
export async function handlePreCheckout(
	body: unknown,
	merchantId?: string,
): Promise<boolean> {
	const query = getPreCheckoutQuery(body);
	if (!query?.id) return false;

	const decision = await evaluatePreCheckout(query);
	logger.info("Telegram Stars pre-checkout", {
		order_id: decision.orderId ?? null,
		approved: decision.ok,
		reason: decision.reason ?? null,
	});
	// Answer as the bot that owns the order; the caller cannot know it, so the
	// decision carries it and an explicit argument still wins when supplied.
	return answerPreCheckoutQuery(
		query.id,
		decision,
		merchantId ?? decision.merchantId,
	);
}
