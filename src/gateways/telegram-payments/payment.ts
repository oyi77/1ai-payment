/**
 * Telegram Payments Payment Module
 *
 * Handles payment creation via Telegram Bot API.
 * Telegram Payments supports multiple providers (Stripe, PayPal, etc.)
 */

import { getConfig } from '../../config/env';
import { logger } from '../../utils/logger';
import { GatewayError } from '../../utils/errors';
import type { CreatePaymentParams, CreatePaymentResult } from '../base';

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Create a Telegram Payments invoice link
 */
export async function createInvoice(params: CreatePaymentParams): Promise<CreatePaymentResult> {
  const config = getConfig();
  
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new GatewayError('telegram_payments', 'TELEGRAM_BOT_TOKEN not configured');
  }

  // Use provider-specific currency
  const currency = params.currency || 'USD';
  
  // Create invoice link via Telegram Bot API
  const apiUrl = `${TELEGRAM_API}/bot${config.TELEGRAM_BOT_TOKEN}/createInvoiceLink`;
  
  const body = {
    title: params.customerName || 'Payment',
    description: `Payment for order ${params.orderId}`,
    payload: JSON.stringify({
      order_id: params.orderId,
      gateway: 'telegram_payments',
    }),
    provider_token: config.TELEGRAM_PAYMENT_PROVIDER_TOKEN || '',
    currency,
    prices: [
      {
        label: 'Payment',
        amount: params.amount, // Amount in smallest currency unit (cents, etc.)
      },
    ],
    // Optional: photo, need_email, need_phone, etc.
  };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error('Telegram Payments invoice creation failed', { status: response.status, error });
    throw new GatewayError('telegram_payments', `Invoice creation failed: ${response.status} ${error}`);
  }

  const result = (await response.json()) as { ok: boolean; result: string };

  if (!result.ok) {
    throw new GatewayError('telegram_payments', 'Failed to create invoice link');
  }

  return {
    gatewayReference: params.orderId,
    paymentUrl: result.result, // Telegram invoice link
    expiresAt: undefined,
  };
}

/**
 * Get available payment methods for Telegram Payments
 */
export function getPaymentMethods() {
  return [
    { code: 'telegram', name: 'Telegram Payments', currencies: ['USD', 'EUR', 'GBP', 'IDR'] },
  ];
}