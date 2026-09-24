/**
 * iPaymu payment gateway implementation.
 *
 * Payment creation: POST /api/v2/payment
 * Signature: SHA-256(merchantId + referenceId + amount + apiKey)
 * Callback payload: see docs/03-gateway-specs.md
 */

import crypto from "node:crypto";
import { getConfig, resolveGatewayConfig } from "../config/env";
import { GatewayError, ValidationError } from "../utils/errors";
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

interface IPaymuCallbackPayload {
	order_id: string;
	status: string;
	amount: string;
	payment_method: string;
	reference_id: string;
	signature: string;
}

interface IPaymuMerchantConfig {
	apiKey?: string;
	vaKey?: string;
	environment?: string;
}

interface IPaymuCreateResponse {
	Status: number;
	Message: string;
	Data?: {
		SessionID: string;
		OrderID: string;
		Amount: string;
		ReferenceID: string;
		PaymentURL: string;
		PaymentMethod: string;
		ExpiredAt: string;
	};
}

const SANDBOX_URL = "https://sandbox.ipaymu.com";
const PRODUCTION_URL = "https://my.ipaymu.com";

export class IPaymuGateway implements PaymentGateway {
	readonly name = "ipaymu";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		// iPaymu settles IDR only — a USD amount would bill dollar-nominal as rupiah.
		if ((params.currency ?? "IDR").toUpperCase() !== "IDR") {
			throw new ValidationError(
				"ipaymu",
				`iPaymu supports IDR only, got ${params.currency}`,
			);
		}
		const base = getConfig();
		const m = params.merchantId
			? ((await resolveGatewayConfig(
					"ipaymu",
					params.merchantId,
				)) as unknown as IPaymuMerchantConfig)
			: null;
		const apiKey = m?.apiKey || base.IPAYMU_API_KEY;
		const vaKey = m?.vaKey || base.IPAYMU_VA_KEY;
		if (!apiKey || !vaKey) {
			throw new GatewayError(
				"ipaymu",
				"IPAYMU_API_KEY or IPAYMU_VA_KEY not configured",
			);
		}

		const env = m?.environment || base.IPAYMU_ENVIRONMENT;
		const baseUrl = env === "production" ? PRODUCTION_URL : SANDBOX_URL;

		const publicBase = base.PUBLIC_BASE_URL.replace(/\/$/, "");
		const body = {
			name: params.customerName || "Customer",
			email: params.customerEmail || "",
			phone: "",
			amount: params.amount,
			notifyUrl: `${publicBase}/webhook/ipaymu`,
			returnUrl: params.successUrl ?? `${publicBase}/payment/finish`,
			cancelUrl: params.cancelUrl ?? `${publicBase}/payment/cancel`,
			referenceId: params.orderId,
			paymentMethod: params.paymentMethod || "va",
			paymentChannel: "va",
		};

		const bodyStr = JSON.stringify(body);
		const bodyHash = crypto
			.createHash("sha256")
			.update(bodyStr)
			.digest("hex")
			.toLowerCase();
		const stringToSign = `POST:${vaKey}:${bodyHash}:${apiKey}`;
		const signature = crypto
			.createHmac("sha256", apiKey)
			.update(`POST:${vaKey}:${bodyHash}:${apiKey}`)
			.digest("hex")
			.toLowerCase();

		const timestamp = Date.now().toString();

		const response = await fetch(`${baseUrl}/api/v2/payment`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				va: vaKey,
				signature: signature,
				timestamp: timestamp,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new GatewayError(
				"ipaymu",
				`Create failed: ${response.status} ${error}`,
			);
		}

		const result = (await response.json()) as IPaymuCreateResponse;

		if (result.Status !== 200 || !result.Data) {
			throw new GatewayError(
				"ipaymu",
				result.Message || "Payment creation failed",
			);
		}

		return {
			gatewayReference: result.Data.SessionID,
			paymentUrl: result.Data.PaymentURL,
			expiresAt: result.Data.ExpiredAt
				? new Date(result.Data.ExpiredAt).toISOString()
				: undefined,
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "va", name: "Virtual Account (All Banks)", currencies: ["IDR"] },
			{ code: "bca", name: "BCA Virtual Account", currencies: ["IDR"] },
			{ code: "mandiri", name: "Mandiri Virtual Account", currencies: ["IDR"] },
			{ code: "bni", name: "BNI Virtual Account", currencies: ["IDR"] },
			{ code: "bri", name: "BRI Virtual Account", currencies: ["IDR"] },
			{ code: "permata", name: "Permata Virtual Account", currencies: ["IDR"] },
			{ code: "cimb", name: "CIMB Virtual Account", currencies: ["IDR"] },
			{ code: "btpn", name: "BTPN Virtual Account", currencies: ["IDR"] },
			{ code: "alfamart", name: "Alfamart", currencies: ["IDR"] },
			{ code: "indomaret", name: "Indomaret", currencies: ["IDR"] },
			{ code: "qris", name: "QRIS", currencies: ["IDR"] },
			{ code: "gopay", name: "GoPay", currencies: ["IDR"] },
			{ code: "shopeepay", name: "ShopeePay", currencies: ["IDR"] },
			{ code: "ovo", name: "OVO", currencies: ["IDR"] },
			{ code: "dana", name: "DANA", currencies: ["IDR"] },
			{ code: "kredivo", name: "Kredivo", currencies: ["IDR"] },
			{ code: "akulaku", name: "Akulaku", currencies: ["IDR"] },
		];
	}

	async verifySignature(
		body: unknown,
		_headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		const payload = body as IPaymuCallbackPayload;
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"ipaymu",
					opts.merchantId,
				)) as unknown as IPaymuMerchantConfig)
			: null;
		const apiKey = m?.apiKey || base.IPAYMU_API_KEY;
		const vaKey = m?.vaKey || base.IPAYMU_VA_KEY;

		if (!apiKey || !vaKey) {
			logger.error("IPAYMU_API_KEY or IPAYMU_VA_KEY not configured");
			return false;
		}

		// iPaymu signature: SHA256(va + order_id + status + amount + apiKey)
		const expected = crypto
			.createHash("sha256")
			.update(
				`${vaKey}${payload.order_id}${payload.status}${payload.amount}${apiKey}`,
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
		const payload = body as IPaymuCallbackPayload;
		const status = this.extractStatus(payload);

		return {
			gateway: this.name,
			order_id: payload.order_id,
			gateway_reference: payload.reference_id,
			status,
			amount: Number.parseInt(payload.amount, 10),
			currency: "IDR",
			payment_method: payload.payment_method,
			paid_at: status === "success" ? new Date().toISOString() : null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(payload: IPaymuCallbackPayload): PaymentStatus {
		const map: Record<string, PaymentStatus> = {
			success: "success",
			pending: "pending",
			failed: "failed",
			expired: "expired",
			cancelled: "cancelled",
		};
		return map[payload.status?.toLowerCase()] || "pending";
	}
}
