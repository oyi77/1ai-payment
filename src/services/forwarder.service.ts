/**
 * Forwarder service — sends normalized payment events to project callbacks.
 *
 * SECURITY: Signs forwarded events with project's webhook_secret.
 * RETRIES: 3 attempts with exponential backoff (5s, 30s, 300s).
 */

import { signPayload } from '../utils/crypto';
import { markForwarded } from './order.service';
import type { NormalizedPaymentEvent } from '../gateways/base';
import type { Order } from './order.service';

interface ForwardResult {
  success: boolean;
  statusCode: number;
  attempts: number;
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [5_000, 30_000, 300_000];

/**
 * Forward a normalized payment event to a project callback URL.
 * Returns immediately (async) — does not block webhook response.
 *
 * Uses order.metadata to include project's original data in forwarded event.
 */
export async function forwardEvent(
  event: NormalizedPaymentEvent,
  order: Order,
  webhookSecret: string
): Promise<ForwardResult> {
  const status = event.status;
  const eventType = `payment.${status}`;

  const payload = JSON.stringify({
    event: eventType,
    gateway: event.gateway,
    order_id: order.id,
    project_order_id: order.project_order_id,
    gateway_reference: event.gateway_reference,
    status,
    amount: event.amount,
    currency: event.currency,
    payment_method: event.payment_method,
    paid_at: event.paid_at,
    metadata: order.metadata,
    timestamp: new Date().toISOString(),
  });

  const signature = signPayload(payload, webhookSecret);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(order.callback_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Signature': signature,
          'X-Payment-Event': eventType,
        },
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        await markForwarded(order.id, response.status, attempt + 1);
        return { success: true, statusCode: response.status, attempts: attempt + 1 };
      }

      lastError = new Error(`HTTP ${response.status}: ${await response.text().catch(() => 'unknown')}`);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < MAX_RETRIES - 1) {
      const backoff = BACKOFF_MS[attempt] || 30_000;
      await sleep(backoff);
    }
  }

  logger.error('Forward failed after all retries', {
    order_id: order.id,
    callback_url: order.callback_url,
    error: lastError?.message,
    attempts: MAX_RETRIES,
  });

  await markForwarded(order.id, 0, MAX_RETRIES);
  return { success: false, statusCode: 0, attempts: MAX_RETRIES };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Inline logger to avoid circular dependency
const logger = {
  error: (msg: string, data?: Record<string, unknown>) => {
    console.error(`[Forwarder] ${msg}`, data ? JSON.stringify(data) : '');
  },
  info: (msg: string, data?: Record<string, unknown>) => {
    console.log(`[Forwarder] ${msg}`, data ? JSON.stringify(data) : '');
  },
};
