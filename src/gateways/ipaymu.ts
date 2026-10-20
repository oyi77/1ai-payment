/**
 * iPaymu payment gateway implementation.
 *
 * Payment creation: POST /api/v2/payment
 * Signature (create): HMAC-SHA256(POST:{VA_KEY}:{bodyHash}:{API_KEY})
 * Callback signature: HMAC-SHA256(normalized+sorted JSON, VA_KEY) in X-Signature header
 * Callback payload: see docs/03-gateway-specs.md and https://docs.ipaymu.com/en/docs/callback
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

interface IPaymuCallbackPayload {
	trx_id: number | string;
	sid: string;
	reference_id: string;
	status: string; // berhasil | pending | expired
	status_code: number | string;
	amount: string;
	total: string;
	sub_total: string;
	fee: string;
	paid_off: number | string;
	via: string; // payment method (e.g. "va")
	channel: string; // payment channel (e.g. "bca")
	merchant: string; // merchant VA
	additional_info?: unknown;
	[key: string]: unknown;
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
		// Shape-check the method code (Sweep127): full code-list validation
		// false-rejects natural codes providers accept under other spellings.
		assertSanePaymentMethod("ipaymu", params.paymentMethod);

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
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"ipaymu",
					opts.merchantId,
				)) as unknown as IPaymuMerchantConfig)
			: null;
		const vaKey = m?.vaKey || base.IPAYMU_VA_KEY;

		if (!vaKey) {
			logger.error("IPAYMU_VA_KEY not configured");
			return false;
		}

		// iPaymu sends signature in X-Signature header (HMAC-SHA256)
		const signature = headers["x-signature"] || headers["X-Signature"];
		if (!signature) {
			logger.warn("iPaymu: missing X-Signature header");
			return false;
		}

		// Official iPaymu callback signature validation:
		// 1. Normalize data types per spec (String→Int, String→Bool, etc.)
		// 2. Sort keys A-Z
		// 3. Serialize to JSON with forward-slash escaping
		// 4. HMAC-SHA256 with VA number as key
		// See: https://docs.ipaymu.com/en/docs/callback#signature-validation
		const rawData = body as Record<string, unknown>;
		const intFields = [
			"trx_id",
			"status_code",
			"transaction_status_code",
			"paid_off",
		];
		const normalized: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(rawData)) {
			if (key === "signature") continue; // strip body-level signature if present
			if (key === "is_escrow") {
				normalized[key] = val === "true" || val === "1" || val === 1;
			} else if (intFields.includes(key)) {
				normalized[key] = Number.parseInt(String(val), 10);
			} else if (key === "additional_info") {
				normalized[key] = val === "[]" ? [] : val;
			} else {
				normalized[key] = String(val);
			}
		}
		if (!("additional_info" in normalized)) {
			normalized.additional_info = [];
		}

		// Sort keys alphabetically (case-sensitive, PHP ksort semantics)
		const sortedKeys = Object.keys(normalized).sort((a, b) =>
			a.localeCompare(b),
		);
		const sorted: Record<string, unknown> = {};
		for (const key of sortedKeys) {
			sorted[key] = normalized[key];
		}

		// JSON.stringify + escape forward slashes (PHP json_encode standard)
		let jsonBody = JSON.stringify(sorted);
		jsonBody = jsonBody.replace(/\//g, "\\/");

		const expected = crypto
			.createHmac("sha256", vaKey)
			.update(jsonBody)
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
		const payload = body as IPaymuCallbackPayload;
		const status = this.extractStatus(payload);

		return {
			gateway: this.name,
			order_id: payload.reference_id,
			gateway_reference: String(payload.trx_id),
			status,
			amount: Number.parseInt(payload.amount, 10),
			currency: "IDR",
			payment_method: payload.via || payload.channel || "unknown",
			paid_at: status === "success" ? new Date().toISOString() : null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(payload: IPaymuCallbackPayload): PaymentStatus {
		const map: Record<string, PaymentStatus> = {
			berhasil: "success",
			success: "success",
			pending: "pending",
			gagal: "failed",
			failed: "failed",
			expired: "expired",
			dibatalkan: "cancelled",
			cancelled: "cancelled",
		};
		return map[payload.status?.toLowerCase()] || "pending";
	}
}
