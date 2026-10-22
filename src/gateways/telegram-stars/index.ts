/**
 * Telegram Stars Gateway
 *
 * Telegram Stars is Telegram's built-in digital currency for in-app purchases.
 * Users can buy Stars within Telegram and use them to pay for digital goods/services.
 *
 * Flow:
 * 1. Bot creates invoice link via Telegram Bot API
 * 2. User pays with Stars in Telegram
 * 3. Telegram sends update to bot via webhook
 * 4. Bot verifies and processes payment
 *
 * API: https://core.telegram.org/bots/api#payments
 *
 * @module telegram-stars
 */

import type {
	CreatePaymentParams,
	CreatePaymentResult,
	GatewayVerifyOpts,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
	RefundResult,
} from "../base";

import { createInvoice, getPaymentMethods } from "./payment";
import { getTelegramUserIdForCharge, refundStarsPayment } from "./refund";
import { extractStatus, normalizeEvent, verifySignature } from "./webhook";

export class TelegramStarsGateway implements PaymentGateway {
	readonly name = "telegram_stars";

	/**
	 * Create a Telegram Stars invoice link
	 */
	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		return createInvoice(params);
	}

	/**
	 * Get available payment methods
	 */
	getPaymentMethods(): PaymentMethod[] {
		return getPaymentMethods();
	}

	/**
	 * Verify Telegram webhook signature
	 */
	verifySignature(body: unknown, headers: Record<string, string>): boolean {
		return verifySignature(body, headers);
	}

	/**
	 * Refund a Stars payment.
	 *
	 * Telegram identifies the charge by `telegram_payment_charge_id`, which is
	 * exactly what normalizeEvent stores as gateway_reference. Refunds are
	 * full-value only — the Bot API does not accept a partial amount — so a
	 * partial refund request is rejected rather than silently rounded.
	 */
	async refundPayment(
		gatewayRef: string,
		amount: number,
		opts?: GatewayVerifyOpts,
	): Promise<RefundResult> {
		// Telegram requires the payer's user_id, captured at payment time and
		// stored on the order metadata. Look it up from the charge id.
		const userId = await getTelegramUserIdForCharge(gatewayRef);
		return refundStarsPayment(gatewayRef, amount, opts?.merchantId, userId);
	}

	/**
	 * Normalize Telegram update to standard payment event
	 */
	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		return normalizeEvent(body, metadata);
	}
}
