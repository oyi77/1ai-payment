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

export class NotFoundError extends PaymentError {
	constructor(resource: string) {
		super(`${resource} not found`, "NOT_FOUND", 404);
		this.name = "NotFoundError";
		this.resource = resource;
	}
	public readonly resource: string;
}

export class ValidationError extends PaymentError {
	constructor(message: string) {
		super(message, "VALIDATION_ERROR", 400);
		this.name = "ValidationError";
	}
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

/**
 * ApiError — typed error for API route responses.
 */
export class ApiError extends PaymentError {
	constructor(message: string, code = "API_ERROR", statusCode = 400) {
		super(message, code, statusCode);
		this.name = "ApiError";
	}
}

/**
 * Build a typed API error with an explicit HTTP status.
 */
export function httpError(
	statusCode: number,
	code: string,
	message: string,
): ApiError {
	return new ApiError(message, code, statusCode);
}

/**
 * Standard 404 helper.
 */
export function notFound(message = "Not found"): ApiError {
	return new ApiError(message, "NOT_FOUND", 404);
}
