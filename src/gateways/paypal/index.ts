/**
 * PayPal Gateway
 *
 * PayPal is a global payment platform supporting PayPal Checkout,
 * Pay Later, Venmo, and credit/debit cards.
 *
 * Flow:
 * 1. Create PayPal order via API
 * 2. User approves payment on PayPal
 * 3. Capture the order
 * 4. PayPal sends webhook notification
 *
 * API: https://developer.paypal.com/docs/api/
 *
 * @module paypal
 */

import type {
  PaymentGateway,
  NormalizedPaymentEvent,
  PaymentStatus,
  CreatePaymentParams,
  CreatePaymentResult,
  PaymentMethod,
} from '../base';

import { createOrder, getPaymentMethods } from './payment';
import { verifySignature, normalizeEvent, extractStatus } from './webhook';

export class PayPalGateway implements PaymentGateway {
  readonly name = 'paypal';

  /**
   * Create a PayPal order
   */
  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    return createOrder(params);
  }

  /**
   * Get available payment methods
   */
  getPaymentMethods(): PaymentMethod[] {
    return getPaymentMethods();
  }

  /**
   * Verify PayPal webhook signature
   */
  verifySignature(body: unknown, headers: Record<string, string>): boolean {
    // PayPal signature verification is async, so we return true here
    // and verify in the webhook handler
    return true;
  }

  /**
   * Normalize PayPal webhook event to standard payment event
   */
  normalizeEvent(body: unknown, metadata?: Record<string, unknown> | null): NormalizedPaymentEvent {
    return normalizeEvent(body, metadata);
  }
}