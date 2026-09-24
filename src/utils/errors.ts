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
		super(`Gateway ${gateway} error: ${details}`, "GATEWAY_ERROR", 502);
		this.name = "GatewayError";
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
