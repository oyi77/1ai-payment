/**
 * Telegram Stars Payment Module
 *
 * Handles payment creation via Telegram Bot API.
 * Telegram Stars is Telegram's built-in digital currency.
 */

import { getConfig } from '../../config/env';
import { logger } from '../../utils/logger';
import { GatewayError } from '../../utils/errors';
import type { CreatePaymentParams, CreatePaymentResult } from '../base';

const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramStarsPayment {
  orderId: string;
  invoiceLink: string;
  amount: number;
  currency: string;
}

/**
 * Create a Telegram Stars invoice link
 */
export async function createInvoice(params: CreatePaymentParams): Promise<CreatePaymentResult> {
  const config = getConfig();
  
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new GatewayError('telegram_stars', 'TELEGRAM_BOT_TOKEN not configured');
  }

  // Stars uses XTR as currency code
  const currency = 'XTR';
  
  // Create invoice link via Telegram Bot API
  const apiUrl = `${TELEGRAM_API}/bot${config.TELEGRAM_BOT_TOKEN}/createInvoiceLink`;
  
  const body = {
    title: params.customerName || 'Payment',
    description: `Payment for order ${params.orderId}`,
    payload: JSON.stringify({
      order_id: params.orderId,
      gateway: 'telegram_stars',
    }),
    currency,
    prices: [
      {
        label: 'Payment',
        amount: params.amount, // Amount in Stars (1 Star = ~$0.02)
      },
    ],
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
    logger.error('Telegram Stars invoice creation failed', { status: response.status, error });
    throw new GatewayError('telegram_stars', `Invoice creation failed: ${response.status} ${error}`);
  }

  const result = (await response.json()) as { ok: boolean; result: string };

  if (!result.ok) {
    throw new GatewayError('telegram_stars', 'Failed to create invoice link');
  }

  return {
    gatewayReference: params.orderId,
    paymentUrl: result.result, // Telegram invoice link
    expiresAt: undefined, // Telegram invoices don't expire by default
  };
}

/**
 * Get available payment methods for Telegram Stars
 */
export function getPaymentMethods() {
  return [
    { code: 'stars', name: 'Telegram Stars', currencies: ['XTR'] },
  ];
}