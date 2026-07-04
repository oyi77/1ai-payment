/**
 * PayPal Payment Module
 *
 * Handles payment creation via PayPal API.
 * Supports PayPal Checkout, Pay Later, and Venmo.
 */

import { getConfig } from '../../config/env';
import { logger } from '../../utils/logger';
import { GatewayError } from '../../utils/errors';
import type { CreatePaymentParams, CreatePaymentResult } from '../base';

const PAYPAL_API = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  production: 'https://api-m.paypal.com',
};

interface PayPalAccessToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface PayPalOrder {
  id: string;
  status: string;
  links: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
}

/**
 * Get PayPal access token
 */
async function getAccessToken(): Promise<string> {
  const config = getConfig();
  
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
    throw new GatewayError('paypal', 'PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET not configured');
  }

  const baseUrl = config.PAYPAL_ENVIRONMENT === 'production' 
    ? PAYPAL_API.production 
    : PAYPAL_API.sandbox;

  const auth = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error('PayPal access token failed', { status: response.status, error });
    throw new GatewayError('paypal', `Access token failed: ${response.status} ${error}`);
  }

  const result = (await response.json()) as PayPalAccessToken;
  return result.access_token;
}

/**
 * Create a PayPal order
 */
export async function createOrder(params: CreatePaymentParams): Promise<CreatePaymentResult> {
  const config = getConfig();
  
  const baseUrl = config.PAYPAL_ENVIRONMENT === 'production' 
    ? PAYPAL_API.production 
    : PAYPAL_API.sandbox;

  const accessToken = await getAccessToken();

  // Convert amount to decimal (PayPal uses decimal amounts, e.g., 10.00)
  const amount = (params.amount / 100).toFixed(2);
  const currency = params.currency || 'USD';

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: params.orderId,
        description: `Payment for order ${params.orderId}`,
        amount: {
          currency_code: currency,
          value: amount,
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          brand_name: '1AI Payment',
          locale: 'en-US',
          landing_page: 'LOGIN',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: 'https://example.com/payment/success',
          cancel_url: 'https://example.com/payment/cancel',
        },
      },
    },
  };

  const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': params.orderId, // Idempotency key
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error('PayPal order creation failed', { status: response.status, error });
    throw new GatewayError('paypal', `Order creation failed: ${response.status} ${error}`);
  }

  const result = (await response.json()) as PayPalOrder;

  // Find the approval URL
  const approvalLink = result.links.find(link => link.rel === 'payer-action');
  if (!approvalLink) {
    throw new GatewayError('paypal', 'No approval URL in PayPal response');
  }

  return {
    gatewayReference: result.id,
    paymentUrl: approvalLink.href,
    expiresAt: undefined, // PayPal orders don't expire immediately
  };
}

/**
 * Get available payment methods for PayPal
 */
export function getPaymentMethods() {
  return [
    { code: 'paypal', name: 'PayPal', currencies: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] },
    { code: 'pay_later', name: 'Pay Later', currencies: ['USD', 'EUR', 'GBP'] },
    { code: 'venmo', name: 'Venmo', currencies: ['USD'] },
  ];
}