/**
 * Telegram Stars Webhook Module
 *
 * Handles Telegram webhook verification and event normalization.
 * Telegram sends updates via webhook when payments are made.
 */

import crypto from 'crypto';
import { getConfig } from '../../config/env';
import { logger } from '../../utils/logger';
import type { NormalizedPaymentEvent, PaymentStatus } from '../base';

interface TelegramUpdate {
  update_id: number;
  pre_checkout_query?: {
    id: string;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    currency: string;
    total_amount: number;
    invoice_payload: string;
  };
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
    };
    successful_payment?: {
      currency: string;
      total_amount: number;
      invoice_payload: string;
      telegram_payment_charge_id: string;
      provider_payment_charge_id: string;
    };
  };
}

/**
 * Verify Telegram webhook signature
 * Uses X-Telegram-Bot-Api-Secret-Token header
 */
export function verifySignature(body: unknown, headers: Record<string, string>): boolean {
  const config = getConfig();
  
  const secretToken = config.TELEGRAM_WEBHOOK_SECRET;
  if (!secretToken) {
    logger.warn('TELEGRAM_WEBHOOK_SECRET not configured - skipping verification');
    return true; // Allow in development
  }

  const token = headers['x-telegram-bot-api-secret-token'];
  if (!token) {
    logger.warn('Telegram: missing secret token header');
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(secretToken)
    );
  } catch {
    return false;
  }
}

/**
 * Normalize Telegram update to standard payment event
 */
export function normalizeEvent(body: unknown, metadata?: Record<string, unknown> | null): NormalizedPaymentEvent {
  const update = body as TelegramUpdate;
  
  // Check for successful payment in message
  if (update.message?.successful_payment) {
    const payment = update.message.successful_payment;
    const invoicePayload = JSON.parse(payment.invoice_payload || '{}');
    
    return {
      gateway: 'telegram_stars',
      order_id: invoicePayload.order_id || '',
      gateway_reference: payment.telegram_payment_charge_id,
      status: 'success',
      amount: payment.total_amount,
      currency: 'XTR',
      payment_method: 'telegram_stars',
      paid_at: new Date().toISOString(),
      metadata: metadata ?? null,
    };
  }

  // Check for pre-checkout query (payment initiated but not completed)
  if (update.pre_checkout_query) {
    const query = update.pre_checkout_query;
    const invoicePayload = JSON.parse(query.invoice_payload || '{}');
    
    return {
      gateway: 'telegram_stars',
      order_id: invoicePayload.order_id || '',
      gateway_reference: query.id,
      status: 'pending',
      amount: query.total_amount,
      currency: 'XTR',
      payment_method: 'telegram_stars',
      paid_at: null,
      metadata: metadata ?? null,
    };
  }

  throw new Error('Unknown Telegram payment update type');
}

/**
 * Extract payment status from Telegram update
 */
export function extractStatus(body: unknown): PaymentStatus {
  const update = body as TelegramUpdate;
  if (update.message?.successful_payment) return 'success';
  if (update.pre_checkout_query) return 'pending';
  return 'pending';
}