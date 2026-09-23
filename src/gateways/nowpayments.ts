/**
 * NOWPayments gateway implementation.
 *
 * Payment creation: POST /v1/invoice
 * Signature: HMAC-SHA512(JSON body, ipn_secret_key)
 * Header: x-now-sig
 * Callback payload: see docs/03-gateway-specs.md
 */

import crypto from "node:crypto";
import { getConfig, resolveGatewayConfig } from "../config/env";
import { GatewayError } from "../utils/errors";
import { logger } from "../utils/logger";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	GatewayVerifyOpts,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
} from "./base";

interface NowPaymentsCallbackPayload {
	payment_id: string;
	order_id: string;
	order_description: string;
	price_amount: number;
	price_currency: string;
	pay_amount: number;
	pay_currency: string;
	payment_status: string;
	created_at: string;
}

interface NowPaymentsMerchantConfig {
	apiKey?: string;
	ipnSecret?: string;
	environment?: string;
}

interface NowPaymentsInvoiceResponse {
	id: string;
	token_id: string;
	order_id: string;
	order_description: string;
	price_amount: number;
	price_currency: string;
	pay_currency: string;
	invoice_url: string;
	status: string;
	created_at: string;
	expiration_estimate_date: string;
}

const SANDBOX_URL = "https://api-sandbox.nowpayments.io";
const PRODUCTION_URL = "https://api.nowpayments.io";

export class NowPaymentsGateway implements PaymentGateway {
	readonly name = "nowpayments";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		const base = getConfig();
		const m = params.merchantId
			? ((await resolveGatewayConfig(
					"nowpayments",
					params.merchantId,
				)) as unknown as NowPaymentsMerchantConfig)
			: null;
		const apiKey = m?.apiKey || base.NOWPAYMENTS_API_KEY;
		if (!apiKey) {
			throw new GatewayError(
				"nowpayments",
				"NOWPAYMENTS_API_KEY not configured",
			);
		}

		const env = m?.environment || base.NOWPAYMENTS_ENVIRONMENT;
		const baseUrl = env === "production" ? PRODUCTION_URL : SANDBOX_URL;

		// NOWPayments uses major units (e.g., 20.00 USD, not 2000 cents)
		const amount =
			params.currency === "IDR" ? params.amount : params.amount / 100;

		const publicBase = base.PUBLIC_BASE_URL.replace(/\/$/, "");
		const body = {
			price_amount: amount,
			price_currency: params.currency.toLowerCase(),
			order_id: params.orderId,
			order_description: "Payment",
			ipn_callback_url: `${publicBase}/webhook/nowpayments`,
			success_url: params.successUrl ?? `${publicBase}/payment/finish`,
			cancel_url: params.cancelUrl ?? `${publicBase}/payment/cancel`,
		};

		const response = await fetch(`${baseUrl}/v1/invoice`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new GatewayError(
				"nowpayments",
				`Invoice failed: ${response.status} ${error}`,
			);
		}

		const result = (await response.json()) as NowPaymentsInvoiceResponse;

		return {
			gatewayReference: result.id,
			paymentUrl: result.invoice_url,
			expiresAt: result.expiration_estimate_date
				? new Date(result.expiration_estimate_date).toISOString()
				: undefined,
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "btc", name: "Bitcoin", currencies: ["USD", "EUR"] },
			{ code: "eth", name: "Ethereum", currencies: ["USD", "EUR"] },
			{ code: "usdttrc20", name: "USDT (TRC-20)", currencies: ["USD", "EUR"] },
			{ code: "usdterc20", name: "USDT (ERC-20)", currencies: ["USD", "EUR"] },
			{ code: "usdc", name: "USD Coin", currencies: ["USD", "EUR"] },
			{ code: "ltc", name: "Litecoin", currencies: ["USD", "EUR"] },
			{ code: "sol", name: "Solana", currencies: ["USD", "EUR"] },
			{ code: "trx", name: "TRON", currencies: ["USD", "EUR"] },
		];
	}

	async verifySignature(
		body: unknown,
		headers: Record<string, string>,
	): Promise<boolean> {
		// Signature is HMAC over the raw request body — delegate to raw
		return this.verifySignatureRaw(JSON.stringify(body), headers);
	}

	async verifySignatureRaw(
		rawBody: string,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"nowpayments",
					opts.merchantId,
				)) as unknown as NowPaymentsMerchantConfig)
			: null;
		const ipnSecret = m?.ipnSecret || base.NOWPAYMENTS_IPN_SECRET;

		if (!ipnSecret) {
			logger.error("NOWPAYMENTS_IPN_SECRET not configured");
			return false;
		}

		const signature = headers["x-now-sig"] || headers["X-Now-Sig"];
		if (!signature) {
			logger.warn("NOWPayments: missing x-now-sig header");
			return false;
		}

		const expected = crypto
			.createHmac("sha512", ipnSecret)
			.update(rawBody)
			.digest("hex");

		try {
			return crypto.timingSafeEqual(
				Buffer.from(signature, "hex"),
				Buffer.from(expected, "hex"),
			);
		} catch {
			return false;
		}
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		const payload = body as NowPaymentsCallbackPayload;
		const status = this.extractStatus(payload);

		return {
			gateway: this.name,
			order_id: payload.order_id,
			gateway_reference: String(payload.payment_id),
			status,
			amount: payload.price_amount,
			currency: payload.price_currency?.toUpperCase() || "USD",
			payment_method: `crypto_${payload.pay_currency}`,
			paid_at: status === "success" ? payload.created_at : null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(payload: NowPaymentsCallbackPayload): PaymentStatus {
		const map: Record<string, PaymentStatus> = {
			finished: "success",
			confirmed: "success",
			confirming: "pending",
			sending: "pending",
			partially_paid: "pending",
			failed: "failed",
			refunded: "refunded",
			expired: "expired",
		};
		return map[payload.payment_status] || "pending";
	}
}
