/**
 * PayPal Webhook Module
 *
 * Handles PayPal webhook verification and event normalization.
 * PayPal sends webhooks for various payment events.
 */

import crypto from 'crypto';
import { getConfig } from '../../config/env';
import { logger } from '../../utils/logger';
import type { NormalizedPaymentEvent, PaymentStatus } from '../base';

interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type: string;
  resource: {
    id: string;
    status: string;
    amount: {
      currency_code: string;
      value: string;
    };
    custom_id?: string;
    invoice_id?: string;
    create_time: string;
    update_time: string;
  };
  create_time: string;
}

/**
 * Verify PayPal webhook signature
 * PayPal uses SHA-256 with webhook ID and webhook secret
 */
export async function verifySignature(body: unknown, headers: Record<string, string>): Promise<boolean> {
  const config = getConfig();
  
  if (!config.PAYPAL_WEBHOOK_ID || !config.PAYPAL_WEBHOOK_SECRET) {
    logger.warn('PAYPAL_WEBHOOK_ID or PAYPAL_WEBHOOK_SECRET not configured');
    return false;
  }

  // PayPal webhook headers
  const transmissionId = headers['paypal-transmission-id'];
  const timestamp = headers['paypal-transmission-time'];
  const signature = headers['paypal-transmission-sig'];
  const certUrl = headers['paypal-cert-url'];

  if (!transmissionId || !timestamp || !signature || !certUrl) {
    logger.warn('PayPal: missing webhook headers');
    return false;
  }

  // Verify the signature using PayPal's verification API
  const config2 = getConfig();
  const baseUrl = config2.PAYPAL_ENVIRONMENT === 'production' 
    ? 'https://api-m.paypal.com' 
    : 'https://api-m.sandbox.paypal.com';

  try {
    const accessToken = await getAccessToken();
    
    const verifyResponse = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transmission_id: transmissionId,
        transmission_time: timestamp,
        cert_url: certUrl,
        auth_algo: 'SHA256withRSA',
        transmission_sig: signature,
        webhook_id: config.PAYPAL_WEBHOOK_ID,
        webhook_event: body,
      }),
    });

    if (!verifyResponse.ok) {
      logger.error('PayPal signature verification failed', { status: verifyResponse.status });
      return false;
    }

    const result = await verifyResponse.json() as { verification_status: string };
    return result.verification_status === 'SUCCESS';
  } catch (error) {
    logger.error('PayPal signature verification error', { error });
    return false;
  }
}

/**
 * Normalize PayPal webhook event to standard payment event
 */
export function normalizeEvent(body: unknown, metadata?: Record<string, unknown> | null): NormalizedPaymentEvent {
  const event = body as PayPalWebhookEvent;
  const resource = event.resource;
  
  // Extract order ID from custom_id or invoice_id
  const orderId = resource.custom_id || resource.invoice_id || resource.id;
  
  return {
    gateway: 'paypal',
    order_id: orderId,
    gateway_reference: resource.id,
    status: extractStatus(body),
    amount: Math.round(parseFloat(resource.amount.value) * 100), // Convert to cents
    currency: resource.amount.currency_code,
    payment_method: 'paypal',
    paid_at: resource.update_time,
    metadata: metadata ?? null,
  };
}

/**
 * Extract payment status from PayPal event
 */
export function extractStatus(body: unknown): PaymentStatus {
  const event = body as PayPalWebhookEvent;
  const status = event.resource.status?.toLowerCase();
  const eventType = event.event_type;

  // Event-type-specific override: refunded
  if (eventType === 'PAYMENT.CAPTURE.REFUNDED') return 'refunded';

  // CHECKOUT.ORDER.APPROVED with APPROVED status means order approved but not captured
  if (eventType === 'CHECKOUT.ORDER.APPROVED' && status === 'approved') return 'pending';

  // Resource status map for known event types
  const statusMap: Record<string, PaymentStatus> = {
    completed: 'success',
    approved: 'success',
    captured: 'success',
    pending: 'pending',
    created: 'pending',
    voided: 'cancelled',
    refunded: 'refunded',
    denied: 'failed',
    failed: 'failed',
    expired: 'expired',
    cancelled: 'cancelled',
  };

  // For unknown event types, return pending as conservative default
  const knownEventTypes = [
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.REFUNDED',
    'CHECKOUT.ORDER.APPROVED',
    'CHECKOUT.ORDER.CANCELLED',
  ];

  if (eventType && !knownEventTypes.includes(eventType)) return 'pending';

  return statusMap[status] || 'pending';
}

/**
 * Helper to get PayPal access token (duplicated here for webhook verification)
 */
async function getAccessToken(): Promise<string> {
  const config = getConfig();
  
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
    throw new Error('PayPal credentials not configured');
  }

  const baseUrl = config.PAYPAL_ENVIRONMENT === 'production' 
    ? 'https://api-m.paypal.com' 
    : 'https://api-m.sandbox.paypal.com';

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
    throw new Error('Failed to get PayPal access token');
  }

  const result = await response.json() as { access_token: string };
  return result.access_token;
}