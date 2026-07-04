/**
 * PaymentGateway — abstract interface for all payment gateway integrations.
 *
 * Provider/Plugin pattern (RULES.md §5): depend on abstractions, not implementations.
 * Each gateway implements this interface. Adding a new gateway = implement + register.
 */

export type PaymentStatus = 'success' | 'pending' | 'failed' | 'expired' | 'cancelled';

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
  orderId: string;        // 1ai-payment order ID
  amount: number;         // In smallest currency unit
  currency: string;
  paymentMethod?: string;
  customerName?: string;
  customerEmail?: string;
}

export interface CreatePaymentResult {
  gatewayReference: string;  // Gateway's transaction ID
  paymentUrl: string;        // URL to redirect user to
  expiresAt?: string;        // ISO timestamp
}

export interface PaymentMethod {
  code: string;
  name: string;
  currencies: string[];
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
   */
  verifySignature(body: unknown, headers: Record<string, string>): boolean;

  /**
   * Normalize gateway-specific payload to standard format.
   * Throws if payload is malformed.
   * metadata is injected from order registry, not from gateway.
   */
  normalizeEvent(body: unknown, metadata?: Record<string, unknown> | null): NormalizedPaymentEvent;
}
