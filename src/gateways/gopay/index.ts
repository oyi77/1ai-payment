/**
 * GoPayGateway — feed-based reconciliation gateway (GoBiz merchant dashboard).
 *
 * ⚠️ EXPERIMENTAL: reverse-engineered private API (paygateme port). Upstream
 * marks GoPay as in-development and untested against the live GoBiz API.
 * Not affiliated with Gojek/GoPay. Settlement relies on polling the merchant
 * analytics feed and matching unique amounts — no signed inbound webhooks.
 *
 * Flow (identical shape to shopee/):
 * 1. Merchant logs in externally (paygateme CLI), exports session JSON,
 *    stores it via PUT /api/merchants/:id/gateways/gopay
 *    { credentials: { session: "<json>", staticQris: "<emvco>" } }.
 * 2. POST /api/payments allocates a unique amount; dynamic QRIS derived from
 *    the outlet's static payload.
 * 3. Poller fetches the analytics feed (amounts ÷100), matches, settles.
 *
 * ponytail: session re-persist after token refresh NOT wired — rotated
 * refresh tokens live only in memory until restart. Wire OnTokenRefreshed →
 * merchant_gateways update when live creds verify the flow.
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
import { isAuthRequired, GoPayProvider } from "./provider";

export interface GoPayMerchantConfig {
	apiKey?: string;
	environment?: string;
	checkoutUrl?: string;
	/** Persisted session JSON (preferred over apiKey). */
	session?: string;
	/** Static EMVCo QRIS payload (overrides session-embedded value). */
	staticQris?: string;
}

const providerCache = new Map<string, GoPayProvider>();
const cacheExpiry = new Map<string, number>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveProvider(
	merchantId: string | undefined,
): Promise<{ provider: GoPayProvider | null; config: GoPayMerchantConfig }> {
	const base = getConfig();
	const m = merchantId
		? ((await resolveGatewayConfig(
				"gopay",
				merchantId,
			)) as unknown as GoPayMerchantConfig)
		: ({} as GoPayMerchantConfig);

	const sessionJson = m.session || base.GOPAY_SESSION_JSON;
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
		const provider = GoPayProvider.fromSession(sessionJson);
		providerCache.set(key, provider);
		cacheExpiry.set(key, Date.now() + CACHE_TTL_MS);
		return { provider, config: m };
	} catch (err) {
		if (isAuthRequired(err)) {
			logger.warn("GoPay: session expired, re-login required", {
				merchantId: merchantId ?? "platform",
			});
			providerCache.delete(key);
			cacheExpiry.delete(key);
		}
		throw err;
	}
}

export class GoPayGateway implements PaymentGateway, FeedGateway {
	readonly name = "gopay";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		assertSanePaymentMethod("gopay", params.paymentMethod);
		const { provider, config } = await resolveProvider(params.merchantId);

		const chargeAmount = params.uniqueAmount ?? params.amount;

		let paymentUrl = "";
		const staticQris = config.staticQris || getConfig().GOPAY_STATIC_QRIS;
		if (staticQris) {
			try {
				paymentUrl = staticToDynamicQris(staticQris, chargeAmount);
			} catch (err) {
				logger.error("GoPay: QRIS generation failed", {
					order_id: params.orderId,
					error: err instanceof Error ? err.message : String(err),
				});
				throw new GatewayError(
					"gopay",
					`Static QRIS invalid: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			// No static QRIS — generic checkout fallback so the order isn't stranded.
			const checkoutUrl =
				config.checkoutUrl ||
				getConfig().GOPAY_CHECKOUT_URL ||
				"https://gopay.co.id/checkout";
			paymentUrl = `${checkoutUrl}${checkoutUrl.includes("?") ? "&" : "?"}ref=${encodeURIComponent(params.orderId)}`;
		}

		if (!provider) {
			logger.warn("GoPay: no session configured, returning placeholder payment", {
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
			{ code: "gopay", name: "GoPay", currencies: ["IDR"] },
		];
	}

	verifySignature(
		_body: unknown,
		_headers: Record<string, string>,
		_opts?: GatewayVerifyOpts,
	): boolean {
		// GoPay uses OAuth2 Bearer auth, not signed webhooks; settlement via feed
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
			statusRaw === "settled" ||
			statusRaw === "settlement" ||
			statusRaw === "capture"
				? "success"
				: statusRaw === "failed" || statusRaw === "cancelled"
					? "failed"
					: statusRaw === "expired"
						? "expired"
						: "pending";

		const amount = Number(txn.amount ?? txn.total ?? txn.gross_amount ?? 0);
		const currency = String(txn.currency ?? "IDR");
		const paymentMethod = String(
			txn.payment_method ?? txn.paymentMethod ?? "gopay",
		);
		const paidAt =
			(txn.paid_at as string) ||
			(txn.created_at as string) ||
			(txn.settlement_time as string) ||
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
				"gopay",
				"No GoPay session configured for this merchant",
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
