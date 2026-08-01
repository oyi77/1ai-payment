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
	constructor(orderId: string) {
		super(`Duplicate order: ${orderId}`, "DUPLICATE_ORDER", 409);
		this.name = "DuplicateOrderError";
	}
}

export class GatewayError extends PaymentError {
	constructor(gateway: string, details: string) {
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
