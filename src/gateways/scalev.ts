/**
 * Scalev payment gateway implementation.
 *
 * PARKED (ops, 2026-09-23): owner quota exhausted — hidden from landing/
 * dashboard user surfaces. Code stays wired (registry, webhook, nexus,
 * merchant-creds contract) so existing credentials keep resolving.
 *
 * IMPORTANT: Scalev is a HEADLESS COMMERCE PLATFORM, not a simple payment gateway.
 * It requires:
 * 1. A Scalev store with products/variants configured
 * 2. Storefront API key (sfpk_...) - different from business API key
 * 2. Products/variants configured in Scalev dashboard
 * 3. Checkout uses variant_id from Scalev product variants
 *
 * Endpoint: POST /v3/stores/{store_id}/public/checkout
 * Auth: X-Scalev-Storefront-Api-Key header
 * Docs: https://docs.scalev.com
 *
 * Idempotency: Scalev has built-in duplicate order detection.
 * We use our order_id as notes field to track our orders.
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

interface ScalevCheckoutItem {
	type: "variant";
	variant_id: number;
	quantity: number;
}

interface ScalevCheckoutRequest {
	customer_name: string;
	customer_email: string;
	customer_phone?: string;
	shipping_address?: string;
	shipping_province?: string;
	shipping_city?: string;
	shipping_subdistrict?: string;
	shipping_postal_code?: string;
	shipping_location_id?: string | number;
	payment_method: string;
	sub_payment_method?: string;
	courier_service_id?: number;
	warehouse_unique_id?: string;
	courier_aggregator_code?: string;
	discount_code_code?: string;
	notes?: string;
	items: ScalevCheckoutItem[];
}

interface ScalevCheckoutResponse {
	id: string;
	secret_slug: string;
	status: string;
	customer_name: string;
	customer_email: string;
	total_amount: number;
	currency: string;
	payment_method: string;
	payment_url: string;
	expired_at: string;
}

interface ScalevWebhookPayload {
	id: string;
	secret_slug: string;
	status: string;
	total_amount: number;
	currency: string;
	payment_method: string;
	paid_at?: string;
	created_at: string;
	customer_name: string;
	customer_email: string;
}

interface ScalevMerchantConfig {
	storefrontApiKey?: string;
	storeId?: string;
	variantId?: string;
	webhookSecret?: string;
	environment?: string;
}

const BASE_URL = "https://api.scalev.com";

export class ScalevGateway implements PaymentGateway {
	readonly name = "scalev";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		const base = getConfig();
		const m = params.merchantId
			? ((await resolveGatewayConfig(
					"scalev",
					params.merchantId,
				)) as unknown as ScalevMerchantConfig)
			: null;
		const storefrontApiKey =
			m?.storefrontApiKey || base.SCALEV_STOREFRONT_API_KEY;
		const storeId = m?.storeId || base.SCALEV_STORE_ID;
		const variantId = m?.variantId || base.SCALEV_VARIANT_ID;

		if (!storefrontApiKey) {
			throw new GatewayError(
				"scalev",
				"SCALEV_STOREFRONT_API_KEY not configured",
			);
		}
		if (!storeId) {
			throw new GatewayError("scalev", "SCALEV_STORE_ID not configured");
		}
		const variantOverride = params.metadata?.variant_id;
		if (!variantId && !variantOverride) {
			throw new GatewayError(
				"scalev",
				"SCALEV_VARIANT_ID not configured (need a product variant from Scalev dashboard)",
			);
		}

		const baseUrl = BASE_URL;

		const items: ScalevCheckoutItem[] = [
			{
				type: "variant",
				variant_id: Number(variantOverride ?? variantId),
				quantity: 1,
			},
		];

		// Use notes field to store our order_id for tracking and idempotency
		const notes = `1ai-payment:${params.orderId}`;

		const body: ScalevCheckoutRequest = {
			customer_name: params.customerName || "Customer",
			customer_email:
				params.customerEmail || `customer-${Date.now()}@example.com`,
			customer_phone: "",
			payment_method: params.paymentMethod || "bank_transfer",
			notes,
			items,
		};

		const response = await fetch(
			`${baseUrl}/v3/stores/${storeId}/public/checkout`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Scalev-Storefront-Api-Key": storefrontApiKey,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			},
		);

		if (!response.ok) {
			const error = await response.text();

			// Handle Scalev's "Duplicate order" error - this means the order already exists
			if (response.status === 400 && error.includes("Duplicate order")) {
				logger.warn("Scalev duplicate order detected", {
					orderId: params.orderId,
				});
				// Try to fetch the existing order by notes field
				const existingOrder = await this.getOrderByNotes(notes);
				if (existingOrder) {
					return {
						gatewayReference: existingOrder.id,
						paymentUrl: existingOrder.payment_url || "",
						expiresAt: existingOrder.expired_at
							? new Date(existingOrder.expired_at).toISOString()
							: undefined,
					};
				}
			}

			logger.error("Scalev checkout failed", {
				status: response.status,
				error,
			});
			throw new GatewayError(
				"scalev",
				`Checkout failed: ${response.status} ${error}`,
			);
		}

		const result = (await response.json()) as ScalevCheckoutResponse;

		return {
			gatewayReference: result.id,
			paymentUrl:
				result.payment_url ||
				`https://checkout.scalev.com/${result.secret_slug}`,
			expiresAt: result.expired_at
				? new Date(result.expired_at).toISOString()
				: undefined,
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{
				code: "bank_transfer",
				name: "Bank Transfer (All Banks)",
				currencies: ["IDR"],
			},
			{ code: "qris", name: "QRIS", currencies: ["IDR"] },
			{ code: "gopay", name: "GoPay", currencies: ["IDR"] },
			{ code: "shopeepay", name: "ShopeePay", currencies: ["IDR"] },
			{ code: "dana", name: "DANA", currencies: ["IDR"] },
			{ code: "ovo", name: "OVO", currencies: ["IDR"] },
			{ code: "linkaja", name: "LinkAja", currencies: ["IDR"] },
			{ code: "kredivo", name: "Kredivo", currencies: ["IDR"] },
			{ code: "akulaku", name: "Akulaku", currencies: ["IDR"] },
			{ code: "atome", name: "Atome", currencies: ["IDR"] },
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
					"scalev",
					opts.merchantId,
				)) as unknown as ScalevMerchantConfig)
			: null;
		const webhookSecret = m?.webhookSecret || base.SCALEV_WEBHOOK_SECRET;
		if (!webhookSecret) {
			logger.error("SCALEV_WEBHOOK_SECRET not configured");
			return false;
		}

		// Scalev webhook uses HMAC-SHA256 with webhook secret
		// Signature is sent in x-scalev-signature header
		const signature =
			headers["x-scalev-signature"] || headers["X-Scalev-Signature"];
		if (!signature) {
			logger.warn("Scalev: missing X-Scalev-Signature header");
			return false;
		}

		const expected = crypto
			.createHmac("sha256", webhookSecret)
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
		const payload = body as ScalevWebhookPayload;
		const status = this.extractStatus(payload);

		// Extract our order_id from notes field (format: "1ai-payment:<order_id>")
		const payloadAny = payload as unknown as Record<string, unknown>;
		const notes = (payloadAny.notes as string) || "";
		const orderIdMatch = notes.match(/^1ai-payment:(.+)$/);
		const orderId = orderIdMatch
			? orderIdMatch[1]
			: payload.secret_slug || payload.id;

		return {
			gateway: this.name,
			order_id: orderId,
			gateway_reference: payload.id,
			status,
			amount: Number(payload.total_amount || 0),
			currency: String(payload.currency || "IDR"),
			payment_method: String(payload.payment_method || ""),
			paid_at:
				status === "success"
					? String(payload.paid_at || new Date().toISOString())
					: null,
			metadata: metadata ?? null,
		};
	}

	private extractStatus(payload: ScalevWebhookPayload): PaymentStatus {
		const status = String(payload.status || "").toLowerCase();
		if (status === "paid" || status === "completed") return "success";
		if (status === "pending" || status === "processing") return "pending";
		if (status === "failed") return "failed";
		if (status === "cancelled") return "cancelled";
		if (status === "expired") return "expired";
		return "pending";
	}

	private async getOrderByNotes(
		notes: string,
	): Promise<ScalevCheckoutResponse | null> {
		const config = getConfig();
		const baseUrl =
			config.SCALEV_ENVIRONMENT === "production" ? BASE_URL : BASE_URL;

		// Search for orders by notes (this is a simplified approach)
		// In production, you might need to list orders and filter
		try {
			const response = await fetch(
				`${baseUrl}/v3/stores/${config.SCALEV_STORE_ID}/public/orders?notes=${encodeURIComponent(notes)}`,
				{
					headers: {
						"X-Scalev-Storefront-Api-Key": config.SCALEV_STOREFRONT_API_KEY,
					},
					signal: AbortSignal.timeout(30_000),
				},
			);

			if (response.ok) {
				const result = (await response.json()) as {
					data: ScalevCheckoutResponse[];
				};
				return result.data?.[0] || null;
			}
		} catch (err) {
			logger.warn("Failed to fetch existing order by notes", {
				notes,
				error: err,
			});
		}

		return null;
	}
}
