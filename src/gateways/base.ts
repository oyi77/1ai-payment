/**
 * PaymentGateway — abstract interface for all payment gateway integrations.
 *
 * Provider/Plugin pattern (RULES.md §5): depend on abstractions, not implementations.
 * Each gateway implements this interface. Adding a new gateway = implement + register.
 */
import { ValidationError } from "../utils/errors";

export type PaymentStatus =
	| "success"
	| "pending"
	| "failed"
	| "expired"
	| "cancelled"
	| "refunded";

export interface NormalizedPaymentEvent {
	gateway: string;
	order_id: string;
	gateway_reference: string;
	status: PaymentStatus;
	amount: number;
	currency: string;
	payment_method: string;
	paid_at: string | null;
	metadata: Record<string, unknown> | null;
}

export interface CreatePaymentParams {
	orderId: string;
	amount: number;
	currency: string;
	paymentMethod?: string;
	customerName?: string;
	customerEmail?: string;
	metadata?: Record<string, unknown>;
	/** Where to send the buyer after payment completes (gateway-hosted redirect). */
	successUrl?: string;
	/** Where to send the buyer after cancelling. */
	cancelUrl?: string;
	/** Owning merchant — gateways resolve per-merchant credentials via getGatewayConfigForMerchant; absent = platform env config. */
	merchantId?: string;
}

export interface CreatePaymentResult {
	gatewayReference: string;
	paymentUrl: string;
	expiresAt?: string;
}

export interface RefundResult {
	gatewayRefundId: string;
	status: "success" | "pending" | "failed";
}

export interface PaymentMethod {
	code: string;
	name: string;
	currencies: string[];
}

/**
 * Per-call verification/operation options.
 * merchantId — resolve credentials via resolveGatewayConfig(merchant) first,
 * falling back to platform env config. Lets stored merchant keys take effect
 * without changing the sync verify call shape (resolution is async).
 */
export interface GatewayVerifyOpts {
	merchantId?: string;
}

/**
 * Reject payment_method values that cannot be real provider codes
 * (Sweep127). Shape-only: letters/digits/`_`/`-`, max 32 chars.
 *
 * Deliberately NOT checked against getPaymentMethods() codes — merchants
 * send natural codes ("bca") that providers accept but our lists spell
 * differently ("BC"), and providers add codes without telling us. A
 * code-list check false-rejects legitimate payments (proven by the sim
 * suite, which sends "bca" to every gateway). Unknown-but-shaped codes
 * still fail at the provider with a 502, which is the honest signal.
 */
export function assertSanePaymentMethod(
	gateway: string,
	method: string | undefined,
): void {
	if (!method) return;
	if (!/^[A-Za-z0-9_-]{1,32}$/.test(method)) {
		throw new ValidationError(
			gateway,
			`Invalid payment_method "${method}" (letters/digits/_/-, max 32 chars)`,
		);
	}
}

export interface PaymentGateway {
	readonly name: string;

	/** Create a payment via gateway API */
	createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;

	/** List available payment methods */
	getPaymentMethods(): PaymentMethod[];

	/**
	 * Verify webhook signature. Returns true if valid.
	 * MUST use timing-safe comparison (crypto.timingSafeEqual).
	 * May be async (some gateways verify via external API).
	 * opts.merchantId — verify against the merchant's own stored credentials
	 * (resolved via resolveGatewayConfig); absent = platform env config.
	 */
	verifySignature(
		body: unknown,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): boolean | Promise<boolean>;
	/**
	 * Verify webhook signature over the RAW request body bytes.
	 * Optional — gateways whose signature is computed over the raw JSON
	 * body (HMAC over bytes, not parsed fields) implement this so the
	 * webhook route passes the unmodified body. Falls back to
	 * verifySignature when not implemented.
	 */
	verifySignatureRaw?(
		rawBody: string,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): boolean | Promise<boolean>;

	/**
	 * Normalize gateway-specific payload to standard format.
	 * Throws if payload is malformed.
	 * metadata is injected from order registry, not from gateway.
	 */
	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent;

	/**
	 * Refund a payment. Optional — gateways that don't support refunds
	 * should throw GatewayError('REFUND_NOT_SUPPORTED').
	 */
	refundPayment?(
		gatewayRef: string,
		amount: number,
		opts?: GatewayVerifyOpts,
	): Promise<RefundResult>;
}
