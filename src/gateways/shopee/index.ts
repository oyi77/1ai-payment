/**
 * ShopeeGateway — feed-based reconciliation gateway.
 *
 * ⚠️ EXPERIMENTAL: reverse-engineered private merchant API (paygateme port).
 * Not affiliated with Shopee. Settlement relies on polling the merchant
 * transaction feed and matching unique amounts — no signed inbound webhooks.
 *
 * Flow:
 * 1. Merchant logs in externally (paygateme CLI: `go run ./cmd/login`), exports
 *    session JSON, stores it via PUT /api/merchants/:id/gateways/shopee
 *    { credentials: { session: "<json>", staticQris: "<emvco>" } }.
 * 2. POST /api/payments allocates a unique amount (base + offset ≤999) and
 *    derives a dynamic QRIS from the merchant's static payload.
 * 3. Buyer scans/pays; poller fetches the merchant feed, matches by amount,
 *    settles via settleOrder.
 *
 * ponytail: session refresh (SSO re-mint) NOT implemented — when the token
 * expires, merchant must re-login externally and re-upload. Add RefreshSession
 * when live creds confirm the exchange endpoint contract.
 */

import { getConfig, resolveGatewayConfig } from "../../config/env";
import { GatewayError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { assertSanePaymentMethod } from "../base";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	FeedGateway,
	GatewayVerifyOpts,
	MerchantTransaction,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
} from "../base";
import { staticToDynamicQris } from "../../utils/qris";
import { isAuthRequired, ShopeeProvider } from "./provider";

export interface ShopeeMerchantConfig {
	apiKey?: string;
	environment?: string;
	checkoutUrl?: string;
	/** Persisted session JSON (preferred over apiKey). */
	session?: string;
	/** Static EMVCo QRIS payload bound to the merchant's outlet. */
	staticQris?: string;
}

/** Cache providers per merchantId so session cookies survive across ticks. */
const providerCache = new Map<string, ShopeeProvider>();
const cacheExpiry = new Map<string, number>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — refresh window

async function resolveProvider(
	merchantId: string | undefined,
): Promise<{ provider: ShopeeProvider | null; config: ShopeeMerchantConfig }> {
	const base = getConfig();
	const m = merchantId
		? ((await resolveGatewayConfig(
				"shopee",
				merchantId,
			)) as unknown as ShopeeMerchantConfig)
		: ({} as ShopeeMerchantConfig);

	const sessionJson = m.session || base.SHOPEE_SESSION_JSON;
	if (!sessionJson) {
		return { provider: null, config: m };
	}

	const key = merchantId ?? "__platform__";
	const cached = providerCache.get(key);
	const expiry = cacheExpiry.get(key) ?? 0;
	if (cached && Date.now() < expiry) {
		return { provider: cached, config: m };
	}

	try {
		const provider = ShopeeProvider.fromSession(sessionJson);
		providerCache.set(key, provider);
		cacheExpiry.set(key, Date.now() + CACHE_TTL_MS);
		return { provider, config: m };
	} catch (err) {
		if (isAuthRequired(err)) {
			logger.warn("Shopee: session expired, re-login required", {
				merchantId: merchantId ?? "platform",
			});
			providerCache.delete(key);
			cacheExpiry.delete(key);
		}
		throw err;
	}
}

export class ShopeeGateway implements PaymentGateway, FeedGateway {
	readonly name = "shopee";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		assertSanePaymentMethod("shopee", params.paymentMethod);
		const { provider, config } = await resolveProvider(params.merchantId);

		// Unique amount comes from the route layer (allocator). Fall back to
		// base amount only if absent (non-feed callers shouldn't hit this).
		const chargeAmount = params.uniqueAmount ?? params.amount;

		// Dynamic QRIS from the merchant's static payload when available.
		let paymentUrl = "";
		const staticQris = config.staticQris || getConfig().SHOPEE_STATIC_QRIS;
		if (staticQris) {
			try {
				paymentUrl = staticToDynamicQris(staticQris, chargeAmount);
			} catch (err) {
				logger.error("Shopee: QRIS generation failed", {
					order_id: params.orderId,
					error: err instanceof Error ? err.message : String(err),
				});
				throw new GatewayError(
					"shopee",
					`Static QRIS invalid: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			// No static QRIS bound — fall back to the generic checkout URL so
			// the order isn't stranded (buyer pays via app search).
			const checkoutUrl =
				config.checkoutUrl ||
				getConfig().SHOPEE_CHECKOUT_URL ||
				"https://shopee.co.id/checkout";
			paymentUrl = `${checkoutUrl}${checkoutUrl.includes("?") ? "&" : "?"}ref=${encodeURIComponent(params.orderId)}`;
		}

		if (!provider) {
			logger.warn("Shopee: no session configured, returning placeholder payment", {
				order_id: params.orderId,
			});
		}

		return {
			gatewayReference: params.orderId,
			paymentUrl,
			expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "qris", name: "QRIS", currencies: ["IDR"] },
			{ code: "shopeepay", name: "ShopeePay", currencies: ["IDR"] },
		];
	}

	verifySignature(
		_body: unknown,
		_headers: Record<string, string>,
		_opts?: GatewayVerifyOpts,
	): boolean {
		// Shopee uses cookie-JWT auth, not signed webhooks; settlement via feed
		// reconciliation only.
		return false;
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		const raw = (body ?? {}) as Record<string, unknown>;
		const txn = (raw.transaction ?? raw.data ?? raw) as Record<string, unknown>;

		const orderId =
			(txn.order_id as string) ||
			(txn.orderId as string) ||
			(txn.ref_id as string) ||
			(metadata?.order_id as string) ||
			"";

		const statusRaw = String(
			txn.status ?? txn.payment_status ?? txn.transaction_status ?? "pending",
		).toLowerCase();
		const status: NormalizedPaymentEvent["status"] =
			statusRaw === "success" ||
			statusRaw === "paid" ||
			statusRaw === "completed" ||
			statusRaw === "settled"
				? "success"
				: statusRaw === "failed" || statusRaw === "cancelled"
					? "failed"
					: statusRaw === "expired"
						? "expired"
						: "pending";

		const amount = Number(txn.amount ?? txn.total ?? txn.gross_amount ?? 0);
		const currency = String(txn.currency ?? "IDR");
		const paymentMethod = String(
			txn.payment_method ?? txn.paymentMethod ?? "qris",
		);
		const paidAt =
			(txn.paid_at as string) ||
			(txn.created_at as string) ||
			(txn.timestamp as string) ||
			null;

		const gatewayReference =
			(txn.transaction_id as string) || (txn.id as string) || orderId;

		return {
			gateway: this.name,
			order_id: orderId,
			gateway_reference: gatewayReference,
			status,
			amount,
			currency,
			payment_method: paymentMethod,
			paid_at: paidAt,
			metadata: metadata ?? null,
		};
	}

	async fetchRecentTransactions(
		opts?: GatewayVerifyOpts,
	): Promise<MerchantTransaction[]> {
		const { provider } = await resolveProvider(opts?.merchantId);
		if (!provider) {
			throw new GatewayError(
				"shopee",
				"No Shopee session configured for this merchant",
			);
		}

		// Window: 24h lookback (paygateme DefaultTransactionLookback parity).
		const now = new Date();
		const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		return provider.fetchTransactions(start, now);
	}

	/** Surface AUTH_REQUIRED distinctly so ops/alerts can react. */
	static isAuthRequiredError(err: unknown): boolean {
		return isAuthRequired(err);
	}
}
