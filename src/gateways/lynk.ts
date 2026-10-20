/**
 * Lynk.id payment gateway implementation.
 *
 * Lynk.id is an Indonesian link-in-bio & checkout platform (lynk.id).
 * Webhooks are dispatched on successful order payments.
 *
 * Docs / Payload format:
 * Payload arrives with message data containing:
 * - ref_id / order_number
 * - customer: { name, email, phone }
 * - totals: { grand_total, total_price }
 * - items: [{ title, qty, price }]
 *
 * Verification:
 * - Header X-Signature (HMAC-SHA256 or SHA256 with merchant key)
 * - Or Header X-Merchant-Key / Authorization matching merchant key
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

export interface LynkWebhookPayload {
	data?: {
		message_data?: {
			ref_id?: string;
			customer?: {
				name?: string;
				email?: string;
				phone?: string;
			};
			items?: Array<{
				title?: string;
				qty?: number;
				price?: number;
			}>;
			totals?: {
				total_price?: number;
				grand_total?: number;
			};
			created_at?: string;
			custom_fields?:
				| Record<string, unknown>
				| Array<{ label?: string; value?: unknown }>;
		};
	};
	order_id?: string;
	order_number?: string;
	ref_id?: string;
	status?: string;
	order_status?: string;
	customer_name?: string;
	customer_email?: string;
	customer_phone?: string;
	email?: string;
	phone?: string;
	total?: number | string;
	grand_total?: number | string;
	amount?: number | string;
	product_title?: string;
	variant?: string;
	metadata?: Record<string, unknown>;
	merchant_key?: string;
}

export class LynkGateway implements PaymentGateway {
	readonly name = "lynk";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		assertSanePaymentMethod(this.name, params.paymentMethod);
		const config = getConfig();
		const checkoutUrl =
			process.env.LYNK_CHECKOUT_URL ||
			"https://lynk.id/jendralbot/ox33n8n04792";

		return {
			gatewayReference: params.orderId,
			paymentUrl: checkoutUrl,
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "qris", name: "QRIS", currencies: ["IDR"] },
			{ code: "bank_transfer", name: "Bank Transfer", currencies: ["IDR"] },
			{ code: "e_wallet", name: "E-Wallet", currencies: ["IDR"] },
		];
	}

	async verifySignature(
		body: unknown,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		return this.verifySignatureRaw(JSON.stringify(body ?? {}), headers, opts);
	}

	async verifySignatureRaw(
		rawBody: string,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		let merchantKey = "";
		if (opts?.merchantId) {
			const cfg = (await resolveGatewayConfig(this.name, opts.merchantId)) as {
				merchantKey?: string;
			};
			merchantKey = cfg.merchantKey || "";
		}
		if (!merchantKey) {
			merchantKey = getConfig().LYNK_MERCHANT_KEY || "";
		}

		if (!merchantKey) {
			logger.warn("Lynk: LYNK_MERCHANT_KEY not configured");
			return false;
		}

		// Normalize headers to lowercase
		const h: Record<string, string> = {};
		for (const [k, v] of Object.entries(headers)) {
			h[k.toLowerCase()] = v;
		}

		// 1. Direct header match (e.g. X-Merchant-Key or Authorization)
		const directKey = h["x-merchant-key"] || h["merchant-key"];
		if (directKey && this.safeCompare(directKey, merchantKey)) {
			return true;
		}

		const auth = h.authorization || "";
		if (auth) {
			const token = auth.startsWith("Bearer ")
				? auth.slice(7).trim()
				: auth.trim();
			if (this.safeCompare(token, merchantKey)) {
				return true;
			}
		}

		// 2. Signature header match (X-Signature, X-Webhook-Signature, X-Lynk-Signature)
		const sig =
			h["x-signature"] ||
			h["x-webhook-signature"] ||
			h["x-lynk-signature"] ||
			"";

		if (sig) {
			// A. HMAC-SHA256(rawBody, merchantKey)
			const expectedHmac = crypto
				.createHmac("sha256", merchantKey)
				.update(rawBody)
				.digest("hex");
			if (this.safeCompare(sig.toLowerCase(), expectedHmac.toLowerCase())) {
				return true;
			}

			// B. SHA256(rawBody + merchantKey)
			const expectedConcat = crypto
				.createHash("sha256")
				.update(rawBody + merchantKey)
				.digest("hex");
			if (this.safeCompare(sig.toLowerCase(), expectedConcat.toLowerCase())) {
				return true;
			}

			// C. Starsender formula: SHA256(amount + ref_id + message_id + merchant_key)
			try {
				const parsed = JSON.parse(rawBody) as LynkWebhookPayload;
				const msgData = parsed.data?.message_data;
				const amount =
					msgData?.totals?.grand_total ??
					msgData?.totals?.total_price ??
					parsed.grand_total ??
					parsed.total ??
					parsed.amount ??
					"";
				const refId =
					msgData?.ref_id ?? parsed.ref_id ?? parsed.order_number ?? "";
				const messageId =
					(parsed as unknown as Record<string, unknown>).message_id ?? "";

				const formulaStr = `${amount}${refId}${messageId}${merchantKey}`;
				const expectedFormula = crypto
					.createHash("sha256")
					.update(formulaStr)
					.digest("hex");
				if (
					this.safeCompare(sig.toLowerCase(), expectedFormula.toLowerCase())
				) {
					return true;
				}
			} catch {
				// Non-JSON rawBody
			}

			// D. Literal key match in signature header
			if (this.safeCompare(sig, merchantKey)) {
				return true;
			}
		}

		// 3. Body payload check (if merchant_key passed in JSON body)
		try {
			const parsed = JSON.parse(rawBody) as Record<string, unknown>;
			const bodyKey = (parsed.merchant_key || parsed.merchantKey) as
				| string
				| undefined;
			if (bodyKey && this.safeCompare(bodyKey, merchantKey)) {
				return true;
			}
		} catch {}

		return false;
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		const payload = (body ?? {}) as LynkWebhookPayload;
		const msgData = payload.data?.message_data;

		// Extract order reference
		const orderId =
			msgData?.ref_id ||
			payload.ref_id ||
			payload.order_number ||
			payload.order_id ||
			`lynk_${Date.now()}`;

		// Extract customer information
		const customerName = msgData?.customer?.name || payload.customer_name || "";
		const customerEmail =
			msgData?.customer?.email || payload.customer_email || payload.email || "";
		const customerPhone =
			msgData?.customer?.phone || payload.customer_phone || payload.phone || "";

		// Extract product title
		const productTitle =
			msgData?.items?.[0]?.title ||
			payload.product_title ||
			payload.variant ||
			"Lifetime";

		// Extract amount
		const rawAmount =
			msgData?.totals?.grand_total ??
			msgData?.totals?.total_price ??
			payload.grand_total ??
			payload.total ??
			payload.amount ??
			254000;
		const amount =
			typeof rawAmount === "number" ? rawAmount : Number(rawAmount) || 254000;

		// Extract status
		const rawStatus = (
			payload.status ||
			payload.order_status ||
			"paid"
		).toLowerCase();
		let status: PaymentStatus = "success";
		if (rawStatus === "pending" || rawStatus === "processing") {
			status = "pending";
		} else if (rawStatus === "failed" || rawStatus === "unpaid") {
			status = "failed";
		} else if (rawStatus === "cancelled" || rawStatus === "canceled") {
			status = "cancelled";
		} else if (rawStatus === "expired") {
			status = "expired";
		} else if (rawStatus.includes("refund")) {
			status = "refunded";
		} else {
			// Lynk webhooks are sent on payment success
			status = "success";
		}

		// Try to resolve chat_id from custom fields, customer info, or metadata
		let chatId: string | undefined = undefined;
		if (metadata?.chat_id) {
			chatId = String(metadata.chat_id);
		} else if (payload.metadata?.chat_id) {
			chatId = String(payload.metadata.chat_id);
		}

		// Inspect custom_fields if available
		const customFields = msgData?.custom_fields;
		if (!chatId && customFields) {
			if (Array.isArray(customFields)) {
				for (const field of customFields) {
					const label = String(field.label || "").toLowerCase();
					if (
						label.includes("telegram") ||
						label.includes("chat") ||
						label.includes("id")
					) {
						chatId = String(field.value || "").trim();
						break;
					}
				}
			} else if (typeof customFields === "object") {
				for (const [k, v] of Object.entries(customFields)) {
					const lk = k.toLowerCase();
					if (
						lk.includes("telegram") ||
						lk.includes("chat") ||
						lk.includes("id")
					) {
						chatId = String(v || "").trim();
						break;
					}
				}
			}
		}

		// Clean up leading @ if telegram username entered
		if (chatId?.startsWith("@")) {
			chatId = chatId.slice(1);
		}

		const mergedMetadata: Record<string, unknown> = {
			...(metadata ?? {}),
			...(payload.metadata ?? {}),
			chat_id: chatId,
			customer_name: customerName,
			customer_email: customerEmail,
			customer_phone: customerPhone,
			product_title: productTitle,
			tier: "lifetime",
			market_scope: "forex",
		};

		return {
			gateway: this.name,
			order_id: orderId,
			gateway_reference: orderId,
			status,
			amount,
			currency: "IDR",
			payment_method: "lynk",
			paid_at: status === "success" ? new Date().toISOString() : null,
			metadata: mergedMetadata,
		};
	}

	private safeCompare(a: string, b: string): boolean {
		if (typeof a !== "string" || typeof b !== "string") return false;
		if (a.length !== b.length) return false;
		try {
			return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
		} catch {
			return false;
		}
	}
}
