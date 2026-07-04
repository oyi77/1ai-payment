/**
 * Error classes — explicit, typed errors for clear handling.
 */

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export class SignatureError extends PaymentError {
  constructor(gateway: string) {
    super(`Invalid signature from ${gateway}`, 'INVALID_SIGNATURE', 401);
    this.name = 'SignatureError';
  }
}

export class OrderNotFoundError extends PaymentError {
  constructor(orderId: string) {
    super(`Order not found: ${orderId}`, 'ORDER_NOT_FOUND', 404);
    this.name = 'OrderNotFoundError';
  }
}

export class DuplicateOrderError extends PaymentError {
  constructor(orderId: string) {
    super(`Duplicate order: ${orderId}`, 'DUPLICATE_ORDER', 409);
    this.name = 'DuplicateOrderError';
  }
}

export class GatewayError extends PaymentError {
  constructor(gateway: string, details: string) {
    super(`Gateway ${gateway} error: ${details}`, 'GATEWAY_ERROR', 502);
    this.name = 'GatewayError';
  }
}

export class ForwardError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly attempts: number
  ) {
    super(message);
    this.name = 'ForwardError';
  }
}
