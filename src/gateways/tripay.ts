/**
 * Tripay payment gateway implementation.
 *
 * Payment creation: POST /api/transaction/create
 * Signature: HMAC-SHA256(JSON body, private_key)
 * Header: X-Signature
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

interface TripayCallbackPayload {
	merchant_ref: string;
	reference: string;
	status: string;
	amount: number;
	payment_method: string;
}

interface TripayMerchantConfig {
	apiKey?: string;
	privateKey?: string;
	merchantCode?: string;
	environment?: string;
}

interface TripayCreateResponse {
	success: boolean;
	data?: {
		reference: string;
		merchant_ref: string;
		payment_method: string;
		amount: number;
		status: string;
		pay_url: string;
		expired_time: number;
	};
	message?: string;
}

const SANDBOX_URL = "https://tripay.co.id/api-sandbox";
const PRODUCTION_URL = "https://tripay.co.id/api";

export class TripayGateway implements PaymentGateway {
	readonly name = "tripay";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		// Tripay settles IDR only — a USD amount would bill dollar-nominal as rupiah.
		if ((params.currency ?? "IDR").toUpperCase() !== "IDR") {
			throw new GatewayError(
				"tripay",
				`Tripay supports IDR only, got ${params.currency}`,
			);
		}
		const base = getConfig();
		const m = params.merchantId
			? ((await resolveGatewayConfig(
					"tripay",
					params.merchantId,
				)) as unknown as TripayMerchantConfig)
			: null;
		const apiKey = m?.apiKey || base.TRIPAY_API_KEY;
		if (!apiKey) {
			throw new GatewayError("tripay", "TRIPAY_API_KEY not configured");
		}

		const env = m?.environment || base.TRIPAY_ENVIRONMENT;
		const baseUrl = env === "production" ? PRODUCTION_URL : SANDBOX_URL;

		const publicBase = base.PUBLIC_BASE_URL.replace(/\/$/, "");
		const body = {
			method: params.paymentMethod || "BCA",
			merchant_ref: params.orderId,
			amount: params.amount,
			customer_name: params.customerName || "Customer",
			customer_email: params.customerEmail || "",
			order_items: [
				{
					sku: "PAYMENT",
					name: "Payment",
					price: params.amount,
					quantity: 1,
				},
			],
			callback_url: `${publicBase}/webhook/tripay`,
			return_url: params.successUrl ?? `${publicBase}/payment/finish`,
			expired_time: Math.floor(Date.now() / 1000) + 86400, // 24 hours
		};

		const response = await fetch(`${baseUrl}/transaction/create`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new GatewayError(
				"tripay",
				`Create failed: ${response.status} ${error}`,
			);
		}

		const result = (await response.json()) as TripayCreateResponse;

		if (!result.success || !result.data) {
			throw new GatewayError(
				"tripay",
				result.message || "Payment creation failed",
			);
		}

		return {
			gatewayReference: result.data.reference,
			paymentUrl: result.data.pay_url,
			expiresAt: new Date(result.data.expired_time * 1000).toISOString(),
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "BCA", name: "BCA Virtual Account", currencies: ["IDR"] },
			{ code: "BNI", name: "BNI Virtual Account", currencies: ["IDR"] },
			{ code: "BRI", name: "BRI Virtual Account", currencies: ["IDR"] },
			{ code: "MANDIRI", name: "Mandiri Virtual Account", currencies: ["IDR"] },
			{ code: "PERMATA", name: "Permata Virtual Account", currencies: ["IDR"] },
			{ code: "BSI", name: "BSI Virtual Account", currencies: ["IDR"] },
			{ code: "QRIS", name: "QRIS", currencies: ["IDR"] },
			{ code: "GOPAY", name: "GoPay", currencies: ["IDR"] },
			{ code: "SHOPEEPAY", name: "ShopeePay", currencies: ["IDR"] },
			{ code: "OVO", name: "OVO", currencies: ["IDR"] },
			{ code: "DANA", name: "DANA", currencies: ["IDR"] },
			{ code: "ALFAMART", name: "Alfamart", currencies: ["IDR"] },
			{ code: "INDOMARET", name: "Indomaret", currencies: ["IDR"] },
		];
	}

	async verifySignature(
		body: unknown,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		// Signature is HMAC over the raw request body — delegate to raw,
		// forwarding opts so merchant-key verification keeps working.
		return this.verifySignatureRaw(JSON.stringify(body), headers, opts);
	}

	async verifySignatureRaw(
		rawBody: string,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"tripay",
					opts.merchantId,
				)) as unknown as TripayMerchantConfig)
			: null;
		const privateKey = m?.privateKey || base.TRIPAY_PRIVATE_KEY;

		if (!privateKey) {
			logger.error("TRIPAY_PRIVATE_KEY not configured");
			return false;
		}

		const signature = headers["x-signature"] || headers["X-Signature"];
		if (!signature) {
			logger.warn("Tripay: missing X-Signature header");
			return false;
		}

		const expected = crypto
			.createHmac("sha256", privateKey)
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
		const payload = body as TripayCallbackPayload;
		const status = this.extractStatus(payload);

		return {
			gateway: this.name,
			order_id: payload.merchant_ref,
			gateway_reference: payload.reference,
			status,
			amount: payload.amount,
			currency: "IDR",
			payment_method: payload.payment_method,
			paid_at: status === "success" ? new Date().toISOString() : null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(payload: TripayCallbackPayload): PaymentStatus {
		const map: Record<string, PaymentStatus> = {
			PAID: "success",
			EXPIRED: "expired",
			FAILED: "failed",
			CANCELLED: "cancelled",
			UNPAID: "pending",
		};
		return map[payload.status] || "pending";
	}
}
