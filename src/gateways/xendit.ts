/**
 * Xendit payment gateway implementation.
 *
 * Payment creation (Invoice): POST /v2/invoices
 * Payment creation (Virtual Account): POST /callback_virtual_accounts
 * Signature: X-Callback-Token header
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

interface XenditInvoiceCallbackPayload {
	id: string;
	external_id: string;
	status: string;
	amount: number;
	paid_amount: number;
	payment_method: string;
	paid_at: string;
	currency?: string;
	invoice_url: string;
	x_callback_token: string;
}

interface XenditVACallbackPayload {
	id: string;
	external_id: string;
	status: string;
	amount: number;
	paid_amount: number;
	bank_code: string;
	currency?: string;
	paid_at: string;
	virtual_account_number: string;
	x_callback_token: string;
}

interface XenditInvoiceResponse {
	id: string;
	external_id: string;
	status: string;
	amount: number;
	invoice_url: string;
	expiry_date: string;
}

interface XenditVAResponse {
	id: string;
	external_id: string;
	status: string;
	amount: number;
	bank_code: string;
	account_number: string;
	expiry_date: string;
}

const SANDBOX_URL = "https://api.xendit.co";
const PRODUCTION_URL = "https://api.xendit.co";

export class XenditGateway implements PaymentGateway {
	readonly name = "xendit";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		const config = getConfig();
		if (!config.XENDIT_API_KEY) {
			throw new GatewayError("xendit", "XENDIT_API_KEY not configured");
		}

		const baseUrl =
			config.XENDIT_ENVIRONMENT === "production" ? PRODUCTION_URL : SANDBOX_URL;

		// Determine payment type from paymentMethod
		const isVA = [
			"bca",
			"mandiri",
			"bni",
			"bri",
			"permata",
			"cimb",
			"btn",
			"bjb",
			"bsi",
		].includes((params.paymentMethod || "").toLowerCase());

		if (isVA) {
			// Create Virtual Account
			const body = {
				external_id: params.orderId,
				bank_code: params.paymentMethod?.toUpperCase() || "BCA",
				name: params.customerName || "Customer",
				expected_amount: params.amount,
				is_closed: true,
				is_single_use: true,
			};

			const response = await fetch(`${baseUrl}/callback_virtual_accounts`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Basic ${Buffer.from(`${config.XENDIT_API_KEY}:`).toString("base64")}`,
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				const error = await response.text();
				throw new GatewayError(
					"xendit",
					`VA Create failed: ${response.status} ${error}`,
				);
			}

			const result = (await response.json()) as XenditVAResponse;

			// For VA, payment_url is the VA number displayed to user
			const vaNumber = result.account_number;
			const paymentUrl = `https://pay.1ai.dev/virtual-account?va=${vaNumber}&bank=${result.bank_code}`;

			return {
				gatewayReference: result.id,
				paymentUrl,
				expiresAt: result.expiry_date
					? new Date(result.expiry_date).toISOString()
					: undefined,
			};
		}
		// Create Invoice (for QRIS, e-Wallet, Retail Outlets)
		const body = {
			external_id: params.orderId,
			amount: params.amount,
			payer_email: params.customerEmail || "customer@example.com",
			description: "Payment",
			fees: [],
			items: [
				{
					name: "Payment",
					quantity: 1,
					price: params.amount,
				},
			],
			success_redirect_url: "https://example.com/payment/finish",
			failure_redirect_url: "https://example.com/payment/cancel",
			currency: params.currency || "IDR",
		};

		const response = await fetch(`${baseUrl}/v2/invoices`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Basic ${Buffer.from(`${config.XENDIT_API_KEY}:`).toString("base64")}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new GatewayError(
				"xendit",
				`Invoice Create failed: ${response.status} ${error}`,
			);
		}

		const result = (await response.json()) as XenditInvoiceResponse;

		return {
			gatewayReference: result.id,
			paymentUrl: result.invoice_url,
			expiresAt: result.expiry_date
				? new Date(result.expiry_date).toISOString()
				: undefined,
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			// Virtual Accounts
			{ code: "bca", name: "BCA Virtual Account", currencies: ["IDR"] },
			{ code: "mandiri", name: "Mandiri Virtual Account", currencies: ["IDR"] },
			{ code: "bni", name: "BNI Virtual Account", currencies: ["IDR"] },
			{ code: "bri", name: "BRI Virtual Account", currencies: ["IDR"] },
			{ code: "permata", name: "Permata Virtual Account", currencies: ["IDR"] },
			{ code: "cimb", name: "CIMB Virtual Account", currencies: ["IDR"] },
			{ code: "btn", name: "BTN Virtual Account", currencies: ["IDR"] },
			{ code: "bjb", name: "BJB Virtual Account", currencies: ["IDR"] },
			{ code: "bsi", name: "BSI Virtual Account", currencies: ["IDR"] },

			// e-Wallets
			{ code: "dana", name: "DANA", currencies: ["IDR"] },
			{ code: "ovo", name: "OVO", currencies: ["IDR"] },
			{ code: "shopeepay", name: "ShopeePay", currencies: ["IDR"] },
			{ code: "linkaja", name: "LinkAja", currencies: ["IDR"] },

			// QRIS
			{ code: "qris", name: "QRIS", currencies: ["IDR"] },

			// Retail Outlets
			{ code: "alfamart", name: "Alfamart", currencies: ["IDR"] },
			{ code: "indomaret", name: "Indomaret", currencies: ["IDR"] },

			// Credit Card (via Invoice)
			{ code: "credit_card", name: "Credit Card", currencies: ["IDR"] },

			// Installments
			{ code: "kredivo", name: "Kredivo", currencies: ["IDR"] },
			{ code: "akulaku", name: "Akulaku", currencies: ["IDR"] },
			{ code: "atome", name: "Atome", currencies: ["IDR"] },
		];
	}

	verifySignature(body: unknown, headers: Record<string, string>): boolean {
		const config = getConfig();

		if (!config.XENDIT_CALLBACK_TOKEN) {
			logger.error("XENDIT_CALLBACK_TOKEN not configured");
			return false;
		}

		const token = headers["x-callback-token"] || headers["X-Callback-Token"];
		if (!token) {
			logger.warn("Xendit: missing X-Callback-Token header");
			return false;
		}

		try {
			return crypto.timingSafeEqual(
				Buffer.from(token),
				Buffer.from(config.XENDIT_CALLBACK_TOKEN),
			);
		} catch {
			return false;
		}
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		const payload = body as
			| XenditInvoiceCallbackPayload
			| XenditVACallbackPayload;
		const status = this.extractStatus(payload);

		// Determine if it's VA or Invoice callback
		const isVA = "bank_code" in payload;

		return {
			gateway: this.name,
			order_id: payload.external_id,
			gateway_reference: payload.id,
			status,
			amount: payload.amount,
			currency: payload.currency || "IDR",
			payment_method: isVA
				? payload.bank_code
				: payload.payment_method || "unknown",
			paid_at: status === "success" ? payload.paid_at : null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(
		payload: XenditInvoiceCallbackPayload | XenditVACallbackPayload,
	): PaymentStatus {
		const status = payload.status?.toLowerCase();

		if (status === "paid" || status === "settled") return "success";
		if (status === "pending") return "pending";
		if (status === "expired") return "expired";
		if (status === "failed") return "failed";
		if (status === "cancelled" || status === "voided") return "cancelled";

		return "pending";
	}
}
