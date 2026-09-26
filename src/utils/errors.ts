/**
 * Error classes — explicit, typed errors for clear handling.
 */

export class PaymentError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode: number = 400,
	) {
		super(message);
		this.name = "PaymentError";
	}
}

export class SignatureError extends PaymentError {
	constructor(gateway: string) {
		super(`Invalid signature from ${gateway}`, "INVALID_SIGNATURE", 401);
		this.name = "SignatureError";
	}
}

export class OrderNotFoundError extends PaymentError {
	constructor(orderId: string) {
		super(`Order not found: ${orderId}`, "ORDER_NOT_FOUND", 404);
		this.name = "OrderNotFoundError";
	}
}
export class DuplicateOrderError extends PaymentError {
	constructor(idempotencyKey: string) {
		super(
			`Duplicate order with idempotency key: ${idempotencyKey}`,
			"DUPLICATE_ORDER",
			409,
		);
		this.name = "DuplicateOrderError";
		this.idempotencyKey = idempotencyKey;
	}
	public readonly idempotencyKey: string;
}

export class DuplicateSavedMethodError extends PaymentError {
	constructor(merchantId: string, gateway: string, gatewayToken: string) {
		super(
			`Duplicate saved method for merchant ${merchantId} gateway ${gateway}`,
			"DUPLICATE_SAVED_METHOD",
			409,
		);
		this.name = "DuplicateSavedMethodError";
		this.merchantId = merchantId;
		this.gateway = gateway;
		this.gatewayToken = gatewayToken;
	}
	public readonly merchantId: string;
	public readonly gateway: string;
	public readonly gatewayToken: string;
}
export class GatewayError extends PaymentError {
	constructor(
		gateway: string,
		public readonly details: string,
	) {
		// 422, not 502: Cloudflare swaps 5xx origin bodies for its own error
		// page (proven live: merchants got HTML instead of the JSON contract).
		super(`Gateway ${gateway} error: ${details}`, "GATEWAY_ERROR", 422);
		this.name = "GatewayError";
	}
}

/**
 * Caller-side validation failure inside a gateway (Sweep122).
 *
 * Currency guards etc. reject a request the merchant can fix — that is a
 * 400, not a 502: telling the caller to "retry" a deterministically bad
 * request burns their retry budget and hides the real message. Unlike
 * GatewayError (redacted, upstream may leak), details here are always
 * merchant-safe (currency names, field names — never keys or amounts).
 */
export class ValidationError extends PaymentError {
	constructor(
		gateway: string,
		public readonly details: string,
	) {
		super(`Gateway ${gateway} error: ${details}`, "VALIDATION_ERROR", 400);
		this.name = "ValidationError";
	}
}

export class ForwardError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly attempts: number,
	) {
		super(message);
		this.name = "ForwardError";
	}
}
