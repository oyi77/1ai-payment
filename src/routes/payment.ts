/**
 * Payment routes — API endpoints for payment creation and management.
 *
 * - POST /api/payments — create payment (returns payment URL)
 * - GET /api/payments/:id — get payment status
 * - GET /api/gateways — list available gateways
 * - GET /api/gateways/:gateway/methods — list payment methods for a gateway
 *
 * All endpoints require API key authentication.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import {
  createOrder,
  getOrderById,
  getOrderByIdempotencyKey,
  updateOrderStatus,
  type CreateOrderParams,
} from '../services/order.service';
import { getGateway } from '../services/gateway.service';
import { getAvailableGateways, getGatewayMethods } from '../services/gateway.service';
import { DuplicateOrderError, OrderNotFoundError, GatewayError } from '../utils/errors';
import { logger } from '../utils/logger';

export const paymentRoutes = new Hono();

// Apply auth middleware to all payment routes
paymentRoutes.use('/*', authMiddleware);

// POST /api/payments — create payment
paymentRoutes.post('/payments', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: { code: 'INVALID_BODY', message: 'Invalid JSON body' } }, 400);
  }

  // Validate required fields
  const gateway = body.gateway as string | undefined;
  const amount = body.amount as number | undefined;
  const callbackUrl = body.callback_url as string | undefined;
  const idempotencyKey = body.idempotency_key as string | undefined;

  if (!gateway || typeof gateway !== 'string') {
    return c.json({ success: false, error: { code: 'INVALID_BODY', message: 'gateway is required' } }, 400);
  }
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_BODY', message: 'amount must be a positive number' } }, 400);
  }

  // Check idempotency
  if (idempotencyKey) {
    try {
      const existing = await getOrderByIdempotencyKey(idempotencyKey);
      if (existing) {
        return c.json({ success: true, data: orderToResponse(existing) }, 200);
      }
    } catch {
      // Ignore — proceed with creation
    }
  }

  // Get gateway implementation
  const gw = getGateway(gateway);
  if (!gw) {
    return c.json({
      success: false,
      error: { code: 'INVALID_BODY', message: `Unsupported gateway: ${gateway}` },
    }, 400);
  }

  // Create order in registry
  const orderParams: CreateOrderParams = {
    project_id: '1ai-content', // Hardcoded for now; multi-tenant in future
    project_order_id: body.project_order_id as string | undefined,
    callback_url: (callbackUrl || 'https://example.com/callback') as string,
    gateway,
    amount,
    currency: (body.currency as string) || 'IDR',
    payment_method: body.payment_method as string | undefined,
    metadata: body.metadata as Record<string, unknown> | undefined,
    idempotency_key: idempotencyKey,
  };

  let order;
  try {
    order = await createOrder(orderParams);
  } catch (err: unknown) {
    if (err instanceof DuplicateOrderError) {
      return c.json({ success: false, error: { code: 'DUPLICATE_ORDER', message: err.message } }, 409);
    }
    throw err;
  }

  // Create payment via gateway
  try {
    const result = await gw.createPayment({
      orderId: order.id,
      amount,
      currency: order.currency,
      paymentMethod: body.payment_method as string | undefined,
      customerName: (body.customer as Record<string, string> | undefined)?.name,
      customerEmail: (body.customer as Record<string, string> | undefined)?.email,
    });

    // Update order with gateway reference and payment URL
    await updateOrderStatus(
      order.id,
      'pending',
      result.gatewayReference,
      result.paymentUrl,
      body.payment_method as string | undefined,
    );

    // Re-read to get updated data
    const updatedOrder = await getOrderById(order.id);
    if (!updatedOrder) throw new Error('Order disappeared after creation');

    logger.info('Payment created', {
      order_id: updatedOrder.id,
      gateway,
      gateway_reference: result.gatewayReference,
      amount,
    });

    return c.json({ success: true, data: orderToResponse(updatedOrder) }, 201);
  } catch (err: unknown) {
    // Mark order as failed if gateway errored
    await updateOrderStatus(order.id, 'failed');

    if (err instanceof GatewayError) {
      logger.warn('Gateway error during payment creation', {
        gateway,
        order_id: order.id,
        error: err.message,
      });
      return c.json({
        success: false,
        error: { code: 'GATEWAY_ERROR', message: err.message },
      }, 502);
    }

    throw err;
  }
});

// GET /api/payments/:id — get payment status
paymentRoutes.get('/payments/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const order = await getOrderById(id);
    if (!order) {
      return c.json({ success: false, error: { code: 'ORDER_NOT_FOUND', message: `Order not found: ${id}` } }, 404);
    }
    return c.json({ success: true, data: orderToResponse(order) });
  } catch (err: unknown) {
    logger.error('Error fetching order', { id, error: err instanceof Error ? err.message : String(err) });
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch order' } }, 500);
  }
});

// GET /api/gateways — list available gateways
paymentRoutes.get('/gateways', async (c) => {
  try {
    const gateways = getAvailableGateways();
    return c.json({ success: true, data: gateways });
  } catch (err: unknown) {
    logger.error('Error listing gateways', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list gateways' } }, 500);
  }
});

// GET /api/gateways/:gateway/methods — list methods for a gateway
paymentRoutes.get('/gateways/:gateway/methods', async (c) => {
  const name = c.req.param('gateway');

  try {
    const info = getGatewayMethods(name);
    if (!info) {
      return c.json({
        success: false,
        error: { code: 'GATEWAY_NOT_FOUND', message: `Gateway not found: ${name}` },
      }, 404);
    }
    return c.json({ success: true, data: info });
  } catch (err: unknown) {
    logger.error('Error fetching gateway methods', {
      gateway: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch methods' } }, 500);
  }
});

function orderToResponse(order: {
  id: string;
  gateway: string;
  gateway_reference: string | null;
  status: string;
  amount: number;
  currency: string;
  payment_method: string | null;
  payment_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: order.id,
    gateway: order.gateway,
    gateway_reference: order.gateway_reference,
    status: order.status,
    amount: order.amount,
    currency: order.currency,
    payment_method: order.payment_method,
    payment_url: order.payment_url,
    metadata: order.metadata,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}
