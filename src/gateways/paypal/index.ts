/**
 * PayPal Gateway
 *
 * PayPal is a global payment platform supporting PayPal Checkout,
 * Pay Later, Venmo, and credit/debit cards.
 *
 * Flow:
 * 1. Create PayPal order via API
 * 2. User approves payment on PayPal
 * 3. Capture the order
 * 4. PayPal sends webhook notification
 *
 * API: https://developer.paypal.com/docs/api/
 *
 * @module paypal
 */

import type {
	CreatePaymentParams,
	CreatePaymentResult,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
} from "../base";
import { createOrder, getPaymentMethods } from "./payment";
import {
	extractStatus,
	normalizeEvent,
	verifySignature as verifyWebhookSignature,
} from "./webhook";

export class PayPalGateway implements PaymentGateway {
	readonly name = "paypal";

	/**
	 * Create a PayPal order
	 */
	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		return createOrder(params);
	}

	/**
	 * Get available payment methods
	 */
	getPaymentMethods(): PaymentMethod[] {
		return getPaymentMethods();
	}

	/**
	 * Verify PayPal webhook signature via PayPal's verification API
	 */
	async verifySignature(
		body: unknown,
		headers: Record<string, string>,
	): Promise<boolean> {
		return verifyWebhookSignature(body, headers);
	}

	/**
	 * Normalize PayPal webhook event to standard payment event
	 */
	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		return normalizeEvent(body, metadata);
	}
}
