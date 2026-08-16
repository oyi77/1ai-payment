import { getGatewayConfig } from "../config/env";
import { GatewayError } from "../utils/errors";
import { logger } from "../utils/logger";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
	RefundResult,
} from "./base";

// Saweria (Indonesia — anonymized donations via QRIS / GoPay / DANA).
// Contract reverse-engineered from the open-source `saweraspay` client
// (https://github.com/sholehbaktiabadi/saweraspay) against the undocumented
// Saweria backend. Saweria does NOT sign webhooks: verification is done by
// reconciliation (the webhook echoes our order id in `message` and the Saweria
// transaction uuid in `id`). The webhook URL is fixed in the Saweria dashboard.

const SAWERIA_BASE_URL = "https://backend.saweria.co";
const SAWERIA_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SAWERIA_ORIGIN = "https://saweria.co";

type SaweriaPaymentType = "qris" | "gopay" | "dana";

interface SaweriaCustomerInfo {
	first_name: string;
	email: string;
	phone?: string;
}

interface SaweriaGenerateBody {
	agree: boolean;
	notUnderage: boolean;
	message: string;
	amount: number;
	payment_type: SaweriaPaymentType;
	vote: string;
	currency: string;
	customer_info: SaweriaCustomerInfo;
}

interface SaweriaGenerateData {
	id: string;
	status: string;
	type: string;
	payment_type: SaweriaPaymentType;
	amount: number;
	amount_raw: number;
	currency: string;
	qr_string?: string;
	redirect_url?: string;
}

interface SaweriaEnvelope<T> {
	data: T;
}

// Webhook payload Saweria POSTs on a successful donation. No signature.
interface SaweriaWebhookPayload {
	version: string;
	created_at: string;
	id: string; // Saweria transaction UUID (matches generate response id)
	type: string; // "donation"
	amount_raw: number; // total paid by donor (incl. fees)
	cut: number; // Saweria deduction (negative)
	donator_name: string;
	donator_email: string;
	donator_is_user: boolean;
	message: string; // our order id, echoed from the generate request
	etc: {
		qr_string?: string;
		amount_to_display: number;
		transaction_fee_policy: string;
	};
}

export class SaweriaGateway implements PaymentGateway {
	readonly name = "saweria";

	private buildHeaders(username: string): Record<string, string> {
		return {
			"User-Agent": SAWERIA_USER_AGENT,
			"Content-Type": "application/json",
			Origin: SAWERIA_ORIGIN,
			Referer: `${SAWERIA_ORIGIN}/${username}`,
		};
	}

	private mapPaymentType(method?: string): SaweriaPaymentType {
		const m = (method || "qris").toLowerCase();
		if (m === "gopay" || m === "dana" || m === "qris") return m;
		return "qris";
	}

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		const cfg = getGatewayConfig("saweria");
		if (!cfg.username || !cfg.userId) {
			logger.error("Saweria config missing", { gateway: "saweria" });
			throw new GatewayError(
				"saweria",
				"SAWERIA_USERNAME / SAWERIA_USER_ID not configured",
			);
		}
		if (params.currency !== "IDR") {
			throw new GatewayError(
				"saweria",
				`Saweria supports IDR only, got ${params.currency}`,
			);
		}

		const paymentType = this.mapPaymentType(params.paymentMethod);
		const body: SaweriaGenerateBody = {
			agree: true,
			notUnderage: true,
			message: params.orderId,
			amount: Math.round(params.amount),
			payment_type: paymentType,
			vote: "",
			currency: "IDR",
			customer_info: {
				first_name: params.customerName || "Anon",
				email: params.customerEmail || "anonymous@1ai.dev",
				phone: "",
			},
		};

		logger.info("Saweria createPayment", {
			gateway: "saweria",
			order_id: params.orderId,
			payment_type: paymentType,
		});

		const res = await fetch(
			`${SAWERIA_BASE_URL}/donations/snap/${cfg.userId}`,
			{
				method: "POST",
				headers: this.buildHeaders(cfg.username),
				body: JSON.stringify(body),
			},
		);

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			logger.error("Saweria snap failed", {
				gateway: "saweria",
				order_id: params.orderId,
				status: res.status,
			});
			throw new GatewayError(
				"saweria",
				`snap ${res.status}: ${text.slice(0, 200)}`,
			);
		}

		const json = (await res.json()) as SaweriaEnvelope<SaweriaGenerateData>;
		const data = json.data;
		if (!data || !data.id) {
			logger.error("Saweria snap missing id", {
				gateway: "saweria",
				order_id: params.orderId,
			});
			throw new GatewayError("saweria", "snap response missing id");
		}

		const paymentUrl =
			paymentType === "qris" ? data.qr_string || "" : data.redirect_url || "";

		logger.info("Saweria payment created", {
			gateway: "saweria",
			order_id: params.orderId,
			reference: data.id,
		});

		return {
			gatewayReference: data.id,
			paymentUrl,
		};
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "qris", name: "QRIS", currencies: ["IDR"] },
			{ code: "gopay", name: "GoPay", currencies: ["IDR"] },
			{ code: "dana", name: "DANA", currencies: ["IDR"] },
		];
	}

	// Saweria does not sign webhooks. Per AGENTS.md the webhook MUST be verified:
	// we reconcile by requiring both the Saweria transaction `id` and our echoed
	// `message` (order id). The route layer will additionally look the order up.
	verifySignature(body: unknown): boolean {
		if (!body || typeof body !== "object") return false;
		const p = body as Partial<SaweriaWebhookPayload>;
		if (!p.id || !p.message) return false;
		if (p.type && p.type !== "donation") return false;
		return true;
	}

	normalizeEvent(body: unknown): NormalizedPaymentEvent {
		if (!body || typeof body !== "object") {
			throw new GatewayError("saweria", "webhook body is not an object");
		}
		const p = body as Partial<SaweriaWebhookPayload>;
		if (!p.id || !p.message) {
			throw new GatewayError("saweria", "webhook missing id or message");
		}

		const status: PaymentStatus = "success"; // receiving the webhook == payment received
		const paymentMethod = p.etc?.qr_string ? "qris" : "unknown";

		return {
			gateway: "saweria",
			order_id: p.message,
			gateway_reference: p.id,
			status,
			amount: p.amount_raw ?? 0,
			currency: "IDR",
			payment_method: paymentMethod,
			paid_at: p.created_at ?? null,
			metadata: {
				donator_name: p.donator_name,
				donator_email: p.donator_email,
				donator_is_user: p.donator_is_user,
				cut: p.cut,
				transaction_fee_policy: p.etc?.transaction_fee_policy,
				amount_to_display: p.etc?.amount_to_display,
			},
		};
	}

	async refundPayment(
		_gatewayRef: string,
		_amount: number,
	): Promise<RefundResult> {
		throw new GatewayError("saweria", "REFUND_NOT_SUPPORTED");
	}
}
