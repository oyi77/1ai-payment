/**
 * Webhook routes — receives callbacks from payment gateways.
 *
 * Each gateway has its own endpoint:
 * - POST /webhook/midtrans
 * - POST /webhook/tripay
 * - POST /webhook/duitku
 * - POST /webhook/nowpayments
 * - POST /webhook/ipaymu
 * - POST /webhook/scalev
 * - POST /webhook/xendit
 *
 * Flow: receive → verify signature → normalize → lookup order → forward to project
 * Returns 200 immediately. Forwarding happens asynchronously with retries.
 */

import { Hono } from 'hono';
import { getGateway } from '../gateways';
import { generateEventId } from '../utils/crypto';
import { logger } from '../utils/logger';
import { getDb } from '../config/database';
import { updateOrderStatus, getOrderById } from '../services/order.service';
import { forwardEvent } from '../services/forwarder.service';
import { SignatureError } from '../utils/errors';
import type { NormalizedPaymentEvent } from '../gateways/base';
import type { Order } from '../services/order.service';

export const webhookRoutes = new Hono();

const GATEWAYS = ['midtrans', 'tripay', 'duitku', 'nowpayments', 'ipaymu', 'scalev', 'xendit', 'telegram_stars', 'telegram_payments', 'paypal'] as const;

for (const gatewayName of GATEWAYS) {
  webhookRoutes.post(`/${gatewayName}`, async (c) => {
    const gateway = getGateway(gatewayName);
    if (!gateway) {
      return c.json({ error: `Gateway not implemented: ${gatewayName}` }, 501);
    }

    // Parse headers (normalize to lowercase keys)
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Parse body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      logger.warn(`Webhook ${gatewayName}: invalid JSON body`);
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // Verify signature
    let signatureValid = false;
    try {
      signatureValid = gateway.verifySignature(body, headers);
    } catch (err: unknown) {
      logger.error(`Webhook ${gatewayName}: signature verification error`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!signatureValid) {
      logger.warn(`Webhook ${gatewayName}: invalid signature`);
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Normalize event (no metadata yet — we'll look up the order)
    let event: NormalizedPaymentEvent;
    try {
      event = gateway.normalizeEvent(body, null);
    } catch (err: unknown) {
      logger.error(`Webhook ${gatewayName}: normalization error`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'Failed to normalize event' }, 400);
    }

    // Log event (no raw payload — security rule)
    logger.info('Webhook received', {
      gateway: gatewayName,
      order_id: event.order_id,
      status: event.status,
      gateway_reference: event.gateway_reference,
    });

    // Look up order — try by gateway_reference first, then order_id
    let order: Order | null = null;

    // For Scalev, the order_id extracted from notes field is our internal order_id
    if (gatewayName === 'scalev' && event.order_id) {
      const { getOrderById } = await import('../services/order.service');
      order = await getOrderById(event.order_id);
    }

    // Try by gateway_reference (for gateways that provide it)
    if (!order && event.gateway_reference) {
      const { getOrderByGatewayRef } = await import('../services/order.service');
      order = await getOrderByGatewayRef(event.gateway_reference);
    }

    // Try by order_id (for gateways that use our order_id directly)
    if (!order && event.order_id) {
      const { getOrderById } = await import('../services/order.service');
      order = await getOrderById(event.order_id);
    }

    if (!order) {
      logger.warn('Webhook received for unknown order', {
        gateway: gatewayName,
        order_id: event.order_id,
        gateway_reference: event.gateway_reference,
      });

      // Still log the event but don't forward
      try {
        const db = getDb();
        await db.execute({
          sql: `INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status, signature_valid)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [generateEventId(), gatewayName, event.order_id, event.gateway_reference, event.status, 1],
        });
      } catch { /* ignore */ }

      return c.json({ ok: true });
    }

    // Re-normalize with metadata from order
    const fullEvent = gateway.normalizeEvent(body, order.metadata);

    // Update order status
    await updateOrderStatus(order.id, fullEvent.status, fullEvent.gateway_reference);

    // Log webhook event
    try {
      const db = getDb();
      await db.execute({
        sql: `INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status, signature_valid)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [generateEventId(), gatewayName, order.id, fullEvent.gateway_reference, fullEvent.status, 1],
      });
    } catch { /* ignore */ }

    // Forward to project (async — don't block webhook response)
    // webhook_secret is order.id for now; in multi-tenant future, use project's webhook_secret
    forwardEvent(fullEvent, order, order.id).catch((err: unknown) => {
      logger.error('Async forward failed', {
        order_id: order!.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Return 200 immediately (gateway expects fast response)
    return c.json({ ok: true });
  });
}