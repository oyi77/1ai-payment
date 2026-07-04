/**
 * Telegram Payments Gateway
 *
 * Telegram Payments supports multiple payment providers (Stripe, PayPal, etc.)
 * through Telegram's interface. Users can pay with credit cards, Google Pay, etc.
 *
 * Flow:
 * 1. Bot creates invoice link via Telegram Bot API
 * 2. User pays with supported payment method in Telegram
 * 3. Telegram sends update to bot via webhook
 * 4. Bot verifies and processes payment
 *
 * API: https://core.telegram.org/bots/api#payments
 *
 * @module telegram-payments
 */

import type {
  PaymentGateway,
  NormalizedPaymentEvent,
  PaymentStatus,
  CreatePaymentParams,
  CreatePaymentResult,
  PaymentMethod,
} from '../base';

import { createInvoice, getPaymentMethods } from './payment';
import { verifySignature, normalizeEvent, extractStatus } from './webhook';

export class TelegramPaymentsGateway implements PaymentGateway {
  readonly name = 'telegram_payments';

  /**
   * Create a Telegram Payments invoice link
   */
  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    return createInvoice(params);
  }

  /**
   * Get available payment methods
   */
  getPaymentMethods(): PaymentMethod[] {
    return getPaymentMethods();
  }

  /**
   * Verify Telegram webhook signature
   */
  verifySignature(body: unknown, headers: Record<string, string>): boolean {
    return verifySignature(body, headers);
  }

  /**
   * Normalize Telegram update to standard payment event
   */
  normalizeEvent(body: unknown, metadata?: Record<string, unknown> | null): NormalizedPaymentEvent {
    return normalizeEvent(body, metadata);
  }
}