/**
 * Webhook routes — receives callbacks from payment gateways.
 *
 * Each gateway has its own endpoint:
 * - POST /webhook/midtrans
 * - POST /webhook/tripay
 * - ... (10 gateways total)
 *
 * Flow: receive → verify signature → normalize → lookup order → forward to project
 * Returns 200 immediately. Forwarding happens asynchronously with retries.
 *
 * OpenAPI spec is auto-generated from route definitions.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { getGateway } from '../gateways';
import { generateEventId } from '../utils/crypto';
import { logger } from '../utils/logger';
import { webhooksReceivedCounter } from '../middleware/metrics';
import { getDb } from '../config/database';
import { updateOrderStatus, getOrderById, getOrderByGatewayRef } from '../services/order.service';
import { forwardEvent } from '../services/forwarder.service';
import { webhookAckSchema, webhookErrorSchema, GATEWAY_NAMES, defaultHook } from '../schemas';
import type { NormalizedPaymentEvent } from '../gateways/base';
import type { Order } from '../services/order.service';
import { handleNexusPayment } from '../services/nexus-fulfillment';

export const webhookRoutes = new OpenAPIHono({ defaultHook });

const webhookAckJson = { 'application/json': { schema: webhookAckSchema } } as const;
const errorJson = { 'application/json': { schema: webhookErrorSchema } } as const;

for (const gatewayName of GATEWAY_NAMES) {
  const route = createRoute({
    method: 'post',
    path: `/${gatewayName}` as string,
    tags: ['Webhooks'],
    summary: `Receive ${gatewayName} callback`,
    description:
      `Called by ${gatewayName}, not by API clients. ` +
      'Verifies signature, normalizes event, updates order, forwards to project callback_url asynchronously.',
    security: [],
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.record(z.string(), z.unknown()).openapi({
              description: 'Gateway-specific payload. Schema varies per gateway.',
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Webhook accepted. Forwarding happens asynchronously.', content: webhookAckJson },
      400: { description: 'Invalid JSON body or malformed event.', content: errorJson },
      401: { description: 'Signature verification failed.', content: errorJson },
      501: { description: 'Gateway not yet implemented.', content: errorJson },
    },
  });

  webhookRoutes.openapi(route, async (c) => {
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

    webhooksReceivedCounter.inc({ gateway: gatewayName, status: event.status });

    // Look up order — try by gateway_reference first, then order_id
    let order: Order | null = null;

    // For Scalev, the order_id extracted from notes field is our internal order_id
    if (gatewayName === 'scalev' && event.order_id) {
      order = await getOrderById(event.order_id);
    }

    // Try by gateway_reference (for gateways that provide it)
    if (!order && event.gateway_reference) {
      order = await getOrderByGatewayRef(event.gateway_reference);
    }

    // Try by order_id (for gateways that use our order_id directly)
    if (!order && event.order_id) {
      order = await getOrderById(event.order_id);
    }

    if (!order) {
      logger.warn('Webhook received for unknown order', {
        gateway: gatewayName,
        order_id: event.order_id,
        gateway_reference: event.gateway_reference,
      });
      try {
        const db = getDb();
        await db.execute({
          sql: `INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status, raw_payload, headers, signature_valid)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          args: [generateEventId(), gatewayName, event.order_id, event.gateway_reference, event.status, JSON.stringify(body), JSON.stringify(headers)],
        });
      } catch (dbErr: unknown) {
        logger.error('Failed to log webhook for unknown order', { error: String(dbErr) });
      }

      // B2: Try nexus fulfillment for direct Scalev checkout (no order in DB)
      if (gatewayName === 'scalev') {
        const result = await handleNexusPayment(
          gatewayName,
          body as Record<string, unknown>,
          String((body as Record<string, unknown>).customer_email ?? ''),
          String((body as Record<string, unknown>).customer_name ?? ''),
        );
        if (result.success) {
          logger.info('Nexus: fulfillment complete for direct checkout', {
            subId: result.subscriptionId,
          });
        }
      }
      return c.json({ ok: true as const }, 200);
    }

    // Re-normalize with metadata from order
    const fullEvent = gateway.normalizeEvent(body, order.metadata);

    // INSERT into webhook_events FIRST — UNIQUE constraint catches duplicates
    const eventId = generateEventId();
    try {
      const db = getDb();
        await db.execute({
          sql: `INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status, raw_payload, headers, signature_valid)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          args: [eventId, gatewayName, order.id, fullEvent.gateway_reference, fullEvent.status, JSON.stringify(body), JSON.stringify(headers)],
        });
    } catch (dbErr: unknown) {
      // UNIQUE(order_id, gateway, status) violation = duplicate webhook
      if (dbErr instanceof Error && dbErr.message.includes('UNIQUE constraint')) {
        logger.info('Duplicate webhook, skipping', {
          order_id: order.id,
          status: fullEvent.status,
          gateway: gatewayName,
        });
        return c.json({ ok: true as const }, 200);
      }
      // Unexpected DB error — still return 200 per webhook contract
      logger.error('Failed to log webhook event, skipping forward', {
        order_id: order.id,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
      return c.json({ ok: true as const }, 200);
    }

    // New event — update order and forward
    await updateOrderStatus(order.id, fullEvent.status, fullEvent.gateway_reference);

    // Look up merchant's webhook_secret for signing
    let webhookSecret = order.id; // fallback
    try {
      const merchantResult = await getDb().execute({
        sql: 'SELECT webhook_secret FROM merchants WHERE id = ?',
        args: [order.project_id],
      });
      if (merchantResult.rows.length > 0) {
        webhookSecret = merchantResult.rows[0].webhook_secret as string;
      }
    } catch { /* use fallback */ }

    forwardEvent(fullEvent, order, webhookSecret).catch((err: unknown) => {
      logger.error('Async forward failed', {
        order_id: order!.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ ok: true as const }, 200);
  });
}

// Catch-all for unknown gateways
webhookRoutes.all('*', (c) => {
  return c.json({ error: 'Unknown gateway', ok: false as const }, 501);
});
