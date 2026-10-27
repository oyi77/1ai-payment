import { getConfig, resolveGatewayConfig } from "../config/env";
import { GatewayError } from "../utils/errors";
import { logger } from "../utils/logger";
import { assertSanePaymentMethod } from "./base";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	GatewayVerifyOpts,
	MerchantTransaction,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
} from "./base";
import type { FeedGateway } from "./base";

export interface ShopeeMerchantConfig {
	apiKey?: string;
	environment?: string;
	checkoutUrl?: string;
}

export class ShopeeGateway implements PaymentGateway, FeedGateway {
	readonly name = "shopee";

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		const base = getConfig();
		const m = params.merchantId
			? ((await resolveGatewayConfig(
					"shopee",
					params.merchantId,
				)) as unknown as ShopeeMerchantConfig)
			: null;
		assertSanePaymentMethod("shopee", params.paymentMethod);
		const apiKey = m?.apiKey || base.SHOPEE_API_KEY;
		const checkoutUrl =
			m?.checkoutUrl ||
			base.SHOPEE_CHECKOUT_URL ||
			"https://shopee.co.id/checkout";

		const gatewayReference = params.orderId;
		const paymentUrl = `${checkoutUrl}${checkoutUrl.includes("?") ? "&" : "?"}ref=${encodeURIComponent(params.orderId)}`;

		if (!apiKey) {
			logger.warn("Shopee: no API key configured, returning fallback URL", {
				orderId: params.orderId,
			});
		}

		return { gatewayReference, paymentUrl };
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
		// Shopee uses cookie-JWT auth, not signed webhooks; settlement via feed reconciliation only.
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
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"shopee",
					opts.merchantId,
				)) as unknown as ShopeeMerchantConfig)
			: null;
		const apiKey = m?.apiKey || base.SHOPEE_API_KEY;
		const environment = m?.environment || base.SHOPEE_ENVIRONMENT;
		const baseUrl =
			environment === "production"
				? "https://api.shopee.co.id"
				: "https://sandbox-api.shopee.co.id";

		if (!apiKey) {
			throw new GatewayError("shopee", "SHOPEE_API_KEY not configured");
		}

		try {
			const response = await fetch(`${baseUrl}/api/v1/transactions`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				signal: AbortSignal.timeout(30_000),
			});

			if (!response.ok) {
				const text = await response.text();
				logger.error("Shopee fetchRecentTransactions failed", {
					status: response.status,
					error: text.slice(0, 200),
				});
				throw new GatewayError(
					"shopee",
					`Feed fetch failed: ${response.status}`,
				);
			}

			const data = (await response.json()) as Record<string, unknown>;
			const list = (data.transactions ??
				data.data ??
				data.items ??
				[]) as Array<Record<string, unknown>>;

			return list.map((t) => ({
				transaction_id: String(t.transaction_id ?? t.id ?? t.order_id ?? ""),
				amount: Number(t.amount ?? t.total ?? 0),
				status: String(t.status ?? "pending"),
				created_at: String(
					t.created_at ?? t.paid_at ?? t.timestamp ?? new Date().toISOString(),
				),
			}));
		} catch (err) {
			if (err instanceof GatewayError) throw err;
			logger.error("Shopee fetchRecentTransactions error", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw new GatewayError(
				"shopee",
				`Feed fetch error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
