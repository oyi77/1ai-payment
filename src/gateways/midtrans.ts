/**
 * Midtrans payment gateway implementation.
 *
 * Payment creation: POST /v2/charge
 * Signature: SHA-512(order_id + status_code + gross_amount + server_key)
 * Callback payload: see docs/03-gateway-specs.md
 */

import crypto from "node:crypto";
import { getConfig } from "../config/env";
import { GatewayError } from "../utils/errors";
import { logger } from "../utils/logger";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
} from "./base";

interface MidtransCallbackPayload {
	order_id: string;
	status_code: string;
	gross_amount: string;
	signature_key: string;
	transaction_status: string;
	payment_type: string;
	transaction_time: string;
	fraud_status?: string;
}

interface MidtransChargeResponse {
	status_code: string;
	transaction_id: string;
	order_id: string;
	redirect_url?: string;
	va_numbers?: Array<{ bank: string; va_number: string }>;
	payment_type: string;
	transaction_status: string;
	expiry_time?: string;
}

const SANDBOX_URL = "https://api.sandbox.midtrans.com";
const PRODUCTION_URL = "https://api.midtrans.com";

export class MidtransGateway implements PaymentGateway {
	readonly name = "midtrans";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		const config = getConfig();
		if (!config.MIDTRANS_SERVER_KEY) {
			throw new GatewayError("midtrans", "MIDTRANS_SERVER_KEY not configured");
		}

		const baseUrl =
			config.MIDTRANS_ENVIRONMENT === "production"
				? PRODUCTION_URL
				: SANDBOX_URL;
		const paymentType = this.mapPaymentMethod(params.paymentMethod);

		const body: Record<string, unknown> = {
			payment_type: paymentType,
			transaction_details: {
				order_id: params.orderId,
				gross_amount: params.amount,
			},
			customer_details: {} as Record<string, string>,
		};

		if (params.customerName)
			(body.customer_details as Record<string, string>).first_name =
				params.customerName;
		if (params.customerEmail)
			(body.customer_details as Record<string, string>).email =
				params.customerEmail;

		// Bank transfer specific
		if (paymentType === "bank_transfer") {
			body.bank_transfer = { bank: params.paymentMethod || "bca" };
		}

		// QRIS and e-wallet: use Snap API
		if (
			paymentType === "qris" ||
			paymentType === "gopay" ||
			paymentType === "shopeepay"
		) {
			body.callbacks = { finish: "https://example.com/payment/finish" };
		}

		const auth = Buffer.from(`${config.MIDTRANS_SERVER_KEY}:`).toString(
			"base64",
		);

		// Use Snap API for QRIS/e-wallet, Core API for bank transfer
		const endpoint =
			paymentType === "qris" ||
			paymentType === "gopay" ||
			paymentType === "shopeepay"
				? `${baseUrl}/snap/v1/transactions`
				: `${baseUrl}/v2/charge`;

		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Basic ${auth}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new GatewayError(
				"midtrans",
				`Charge failed: ${response.status} ${error}`,
			);
		}

		const result = (await response.json()) as MidtransChargeResponse;

		// Snap API returns redirect_url, Core API returns va_numbers
		let paymentUrl = result.redirect_url || "";
		if (!paymentUrl && result.va_numbers) {
			// For bank transfer, construct VA page URL
			paymentUrl = `https://${config.MIDTRANS_ENVIRONMENT === "production" ? "app.midtrans.com" : "app.sandbox.midtrans.com"}/snap/v2/vtweb/${params.orderId}`;
		}

		return {
			gatewayReference: result.transaction_id,
			paymentUrl,
			expiresAt: result.expiry_time
				? new Date(result.expiry_time).toISOString()
				: undefined,
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "bca", name: "BCA Virtual Account", currencies: ["IDR"] },
			{ code: "bni", name: "BNI Virtual Account", currencies: ["IDR"] },
			{ code: "bri", name: "BRI Virtual Account", currencies: ["IDR"] },
			{ code: "mandiri", name: "Mandiri Bill", currencies: ["IDR"] },
			{ code: "permata", name: "Permata Virtual Account", currencies: ["IDR"] },
			{ code: "gopay", name: "GoPay", currencies: ["IDR"] },
			{ code: "shopeepay", name: "ShopeePay", currencies: ["IDR"] },
			{ code: "qris", name: "QRIS", currencies: ["IDR"] },
			{ code: "credit_card", name: "Credit Card", currencies: ["IDR"] },
		];
	}

	verifySignature(body: unknown, _headers: Record<string, string>): boolean {
		const payload = body as MidtransCallbackPayload;
		const config = getConfig();

		if (!config.MIDTRANS_SERVER_KEY) {
			logger.error("MIDTRANS_SERVER_KEY not configured");
			return false;
		}

		const expected = crypto
			.createHash("sha512")
			.update(
				`${payload.order_id}${payload.status_code}${payload.gross_amount}${config.MIDTRANS_SERVER_KEY}`,
			)
			.digest("hex");

		try {
			return crypto.timingSafeEqual(
				Buffer.from(payload.signature_key, "hex"),
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
		const payload = body as MidtransCallbackPayload;
		const status = this.extractStatus(payload);

		return {
			gateway: this.name,
			order_id: payload.order_id,
			gateway_reference: payload.order_id,
			status,
			amount: Math.round(Number.parseFloat(payload.gross_amount)),
			currency: "IDR",
			payment_method: payload.payment_type,
			paid_at: status === "success" ? payload.transaction_time : null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(payload: MidtransCallbackPayload): PaymentStatus {
		const { transaction_status, fraud_status } = payload;

		if (transaction_status === "capture" && fraud_status === "accept")
			return "success";
		if (transaction_status === "settlement") return "success";
		if (transaction_status === "pending") return "pending";
		if (transaction_status === "deny") return "failed";
		if (transaction_status === "cancel") return "cancelled";
		if (transaction_status === "expire") return "expired";
		if (transaction_status === "refund") return "failed";

		return "pending";
	}

	private mapPaymentMethod(method?: string): string {
		const map: Record<string, string> = {
			bca: "bank_transfer",
			bni: "bank_transfer",
			bri: "bank_transfer",
			mandiri: "echannel",
			permata: "bank_transfer",
			gopay: "gopay",
			shopeepay: "shopeepay",
			qris: "qris",
			credit_card: "credit_card",
		};
		return map[method || ""] || "bank_transfer";
	}
}
