/**
 * Lynk.id payment gateway implementation.
 *
 * Lynk.id is an Indonesian link-in-bio & checkout platform (lynk.id).
 * Webhooks are dispatched on successful order payments.
 *
 * Payload format (official docs, 2025-04) — camelCase:
 * - data.message_action: "SUCCESS" on completion; message_code: "0"
 * - data.message_id: signature input (lives on data, NOT message_data)
 * - data.message_data: { refId, customer: {name, email, phone}, items, totals }
 * - data.message_data.totals: { grandTotal, totalPrice }
 *
 * Verification (official): header X-Lynk-Signature must equal
 *   SHA256(amount + refId + message_id + merchantKey)
 * Older/alternate forms (HMAC over the raw body, X-Merchant-Key,
 * Authorization bearer, merchant_key in the body) are still accepted.
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
		/** "SUCCESS" on a paid order; Lynk also sends other message_actions. */
		message_action?: string;
		message_code?: string;
		/** Signature input. Lives on data, NOT inside message_data. */
		message_id?: string;
		message_data?: {
			/** Lynk sends camelCase: refId. ref_id is a legacy spelling. */
			refId?: string;
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
				/** Serialized JSON of buyer answers to checkout questions. */
				questions?: string;
			}>;
			totals?: {
				/** Lynk sends camelCase: grandTotal / totalPrice. */
				grandTotal?: number;
				totalPrice?: number;
				/** Legacy spellings still tolerated. */
				grand_total?: number;
				total_price?: number;
			};
			createdAt?: string;
			custom_fields?:
				| Record<string, unknown>
				| Array<{ label?: string; value?: unknown }>;
		};
	};
	event?: string;
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

			// C. Official Lynk.id formula (documented 2025-04):
			//    SHA256(amount + refId + message_id + merchant_key)
			//    The payload is camelCase: data.message_data.refId,
			//    data.message_data.totals.grandTotal, data.message_id.
			//    Reading snake_case here produced "72000undefined" and made
			//    every genuine webhook fail with 401 Invalid signature.
			try {
				const parsed = JSON.parse(rawBody) as Record<string, unknown>;
				const data = (parsed.data ?? {}) as Record<string, unknown>;
				const msgData = (data.message_data ?? {}) as Record<string, unknown>;
				const totals = (msgData.totals ?? {}) as Record<string, unknown>;
				const amount =
					totals.grandTotal ??
					totals.totalPrice ??
					parsed.grand_total ??
					parsed.total ??
					parsed.amount ??
					"";
				const refId =
					msgData.refId ?? parsed.refId ?? parsed.order_number ?? "";
				const messageId = data.message_id ?? parsed.message_id ?? "";

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

		// Extract order reference. Lynk sends refId (camelCase); ref_id,
		// order_number and order_id cover legacy payloads and manual replays.
		const orderId =
			msgData?.refId ||
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

		// Extract amount. grandTotal/totalPrice are camelCase in the payload;
		// Lynk formats money with thousands separators ("72,000"), so strip
		// non-digits before coercing. An absent/unparseable amount is 0, never
		// a guessed nominal: the webhook route builds a real order from this
		// value for direct checkouts, so a fabricated 254000 would book and
		// forward revenue nobody paid.
		const rawAmount =
			msgData?.totals?.grandTotal ??
			msgData?.totals?.totalPrice ??
			msgData?.totals?.grand_total ??
			msgData?.totals?.total_price ??
			payload.grand_total ??
			payload.total ??
			payload.amount;
		const parsedAmount =
			typeof rawAmount === "number"
				? rawAmount
				: Number(String(rawAmount ?? "").replace(/[^\d.-]/g, ""));
		const amount = Number.isFinite(parsedAmount) ? parsedAmount : 0;

		// Extract status. Lynk states the outcome in data.message_action
		// ("SUCCESS") and data.message_code ("0"), not in a top-level status.
		// A webhook is only dispatched on a completed payment, so an absent or
		// SUCCESS action means paid.
		const rawStatus = (
			payload.status ||
			payload.order_status ||
			payload.data?.message_action ||
			"paid"
		).toLowerCase();
		let status: PaymentStatus = "success";
		if (rawStatus === "pending" || rawStatus === "processing") {
			status = "pending";
		} else if (
			rawStatus === "failed" ||
			rawStatus === "unpaid" ||
			rawStatus === "error"
		) {
			status = "failed";
		} else if (rawStatus === "cancelled" || rawStatus === "canceled") {
			status = "cancelled";
		} else if (rawStatus === "expired") {
			status = "expired";
		} else if (rawStatus.includes("refund")) {
			status = "refunded";
		} else {
			// success / paid / SUCCESS — Lynk only notifies on completion
			status = "success";
		}

		// Try to resolve chat_id from custom fields, customer info, or metadata
		let chatId: string | undefined = undefined;
		if (metadata?.chat_id) {
			chatId = String(metadata.chat_id);
		} else if (payload.metadata?.chat_id) {
			chatId = String(payload.metadata.chat_id);
		}
		// Lynk has no native chat_id. The buyer supplies it as a custom
		// checkout question ("Telegram ID"), which Lynk serialises as a
		// JSON *string* on items[0].questions. Without this the only
		// remaining fallback was "most recent pending order", which can
		// activate the wrong member entirely.
		// Privacy: the raw answers may contain PII (e.g. a KTP photo URL
		// from the official sample). Only the matched Telegram field is
		// surfaced; other answers are dropped, not forwarded.
		const rawQuestions = msgData?.items?.[0]?.questions;
		if (!chatId && typeof rawQuestions === "string") {
			try {
				const answers = JSON.parse(rawQuestions) as Record<string, unknown>;
				for (const [label, value] of Object.entries(answers)) {
					const lk = label.toLowerCase();
					if (
						lk.includes("telegram") ||
						lk.includes("chat id") ||
						lk.includes("chat_id") ||
						lk.includes("id telegram")
					) {
						chatId = String(value ?? "").trim();
						break;
					}
				}
			} catch {
				// Not JSON — the buyer left the answer blank
			}
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

		// Clean up leading @ if a telegram username was entered instead
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
