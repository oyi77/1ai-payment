/**
 * Telegram Stars Gateway
 *
 * Telegram Stars is Telegram's built-in digital currency for in-app purchases.
 * Users can buy Stars within Telegram and use them to pay for digital goods/services.
 *
 * Flow:
 * 1. Bot creates invoice link via Telegram Bot API
 * 2. User pays with Stars in Telegram
 * 3. Telegram sends update to bot via webhook
 * 4. Bot verifies and processes payment
 *
 * API: https://core.telegram.org/bots/api#payments
 *
 * @module telegram-stars
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

export class TelegramStarsGateway implements PaymentGateway {
  readonly name = 'telegram_stars';

  /**
   * Create a Telegram Stars invoice link
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