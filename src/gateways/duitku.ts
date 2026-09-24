/**
 * Duitku payment gateway implementation.
 *
 * Payment creation: POST /webapi/api/merchant/v2/inquiry
 * Signature (create): MD5(merchantCode + merchantOrderId + paymentAmount + apiKey)
 * Signature (callback): MD5(merchantCode + amount + merchantOrderId + apiKey)
 * Callback payload: see docs/03-gateway-specs.md
 */

import crypto from "node:crypto";
import { getConfig, resolveGatewayConfig } from "../config/env";
import { GatewayError, ValidationError } from "../utils/errors";
import { logger } from "../utils/logger";
import { assertSanePaymentMethod } from "./base";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	GatewayVerifyOpts,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
} from "./base";

interface DuitkuCallbackPayload {
	merchantCode: string;
	amount: string;
	merchantOrderId: string;
	resultCode: string;
	reference: string;
	signature: string;
}

interface DuitkuMerchantConfig {
	apiKey?: string;
	merchantCode?: string;
	environment?: string;
}

interface DuitkuInquiryResponse {
	merchantCode: string;
	reference: string;
	paymentUrl: string;
	vaNumber?: string;
	amount: string;
	statusCode: string;
	statusMessage: string;
}

const SANDBOX_URL = "https://sandbox.duitku.com";
const PRODUCTION_URL = "https://passport.duitku.com";

export class DuitkuGateway implements PaymentGateway {
	readonly name = "duitku";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		// Duitku settles IDR only — a USD amount would bill dollar-nominal as rupiah.
		if ((params.currency ?? "IDR").toUpperCase() !== "IDR") {
			throw new ValidationError(
				"duitku",
				`Duitku supports IDR only, got ${params.currency}`,
			);
		}
		const base = getConfig();
		// Shape-check the method code (Sweep127): full code-list validation
		// false-rejects ("bca" works at providers spelling it "BC").
		assertSanePaymentMethod("duitku", params.paymentMethod);
		const m = params.merchantId
			? ((await resolveGatewayConfig(
					"duitku",
					params.merchantId,
				)) as unknown as DuitkuMerchantConfig)
			: null;
		const apiKey = m?.apiKey || base.DUITKU_API_KEY;
		const merchantCode = m?.merchantCode || base.DUITKU_MERCHANT_CODE;
		if (!apiKey || !merchantCode) {
			throw new GatewayError(
				"duitku",
				"DUITKU_API_KEY or DUITKU_MERCHANT_CODE not configured",
			);
		}

		const env = m?.environment || base.DUITKU_ENVIRONMENT;
		const baseUrl = env === "production" ? PRODUCTION_URL : SANDBOX_URL;

		const signature = crypto
			.createHash("md5")
			.update(`${merchantCode}${params.orderId}${params.amount}${apiKey}`)
			.digest("hex");

		const publicBase = base.PUBLIC_BASE_URL.replace(/\/$/, "");
		const body = {
			merchantCode: merchantCode,
			paymentAmount: params.amount,
			paymentMethod: params.paymentMethod || "VC",
			merchantOrderId: params.orderId,
			productDetails: "Payment",
			customerVaName: params.customerName || "Customer",
			email: params.customerEmail || "",
			callbackUrl: `${publicBase}/webhook/duitku`,
			returnUrl: params.successUrl ?? `${publicBase}/payment/finish`,
			signature,
			expiryPeriod: 60,
		};

		const response = await fetch(`${baseUrl}/webapi/api/merchant/v2/inquiry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new GatewayError(
				"duitku",
				`Inquiry failed: ${response.status} ${error}`,
			);
		}

		const result = (await response.json()) as DuitkuInquiryResponse;

		if (result.statusCode !== "00") {
			throw new GatewayError(
				"duitku",
				result.statusMessage || "Payment creation failed",
			);
		}

		return {
			gatewayReference: result.reference,
			paymentUrl: result.paymentUrl,
			expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "VC", name: "Virtual Account (All Banks)", currencies: ["IDR"] },
			{ code: "BC", name: "BCA Virtual Account", currencies: ["IDR"] },
			{ code: "M2", name: "Mandiri Virtual Account", currencies: ["IDR"] },
			{ code: "I1", name: "BNI Virtual Account", currencies: ["IDR"] },
			{ code: "B1", name: "BRI Virtual Account", currencies: ["IDR"] },
			{ code: "BT", name: "Permata Virtual Account", currencies: ["IDR"] },
			{ code: "QR", name: "QRIS", currencies: ["IDR"] },
			{ code: "OV", name: "OVO", currencies: ["IDR"] },
			{ code: "DA", name: "DANA", currencies: ["IDR"] },
			{ code: "SP", name: "ShopeePay", currencies: ["IDR"] },
			{ code: "GQ", name: "GoPay", currencies: ["IDR"] },
		];
	}

	async verifySignature(
		body: unknown,
		_headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		const payload = body as DuitkuCallbackPayload;
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"duitku",
					opts.merchantId,
				)) as unknown as DuitkuMerchantConfig)
			: null;
		const apiKey = m?.apiKey || base.DUITKU_API_KEY;

		if (!apiKey) {
			logger.error("DUITKU_API_KEY not configured");
			return false;
		}

		const expected = crypto
			.createHash("md5")
			.update(
				`${payload.merchantCode}${payload.amount}${payload.merchantOrderId}${apiKey}`,
			)
			.digest("hex");

		try {
			return crypto.timingSafeEqual(
				Buffer.from(payload.signature, "hex"),
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
		const payload = body as DuitkuCallbackPayload;
		const status = this.extractStatus(payload);

		return {
			gateway: this.name,
			order_id: payload.merchantOrderId,
			gateway_reference: payload.reference,
			status,
			amount: Number.parseInt(payload.amount, 10),
			currency: "IDR",
			payment_method: "bank_transfer",
			paid_at: status === "success" ? new Date().toISOString() : null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(payload: DuitkuCallbackPayload): PaymentStatus {
		const code = payload.resultCode;
		if (code === "00") return "success";
		if (code === "01") return "pending";
		return "failed";
	}
}
