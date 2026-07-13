/**
 * Payment routes — API endpoints for payment creation and management.
 *
 * - POST /api/payments — create payment (returns payment URL)
 * - GET /api/payments/:id — get payment status
 * - GET /api/gateways — list available gateways
 * - GET /api/gateways/:gateway/methods — list payment methods for a gateway
 *
 * All endpoints require API key authentication.
 * OpenAPI spec is auto-generated from route definitions.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import {
  createOrder,
  getOrderById,
  getOrderByIdempotencyKey,
  updateOrderStatus,
  listOrders,
  type CreateOrderParams,
} from '../services/order.service';
import { getGateway, getAvailableGateways, getGatewayMethods } from '../services/gateway.service';
import { getDb } from '../config/database';
import { DuplicateOrderError, GatewayError } from '../utils/errors';
import { logger } from '../utils/logger';
import { paymentsCreatedCounter, paymentCreationDuration, errorsCounter } from '../middleware/metrics';
import {
  gatewayNameSchema,
  createPaymentBodySchema,
  orderResponseSchema,
  gatewayInfoSchema,
  errorSchema,
  orderToResponse,
  defaultHook,
  transactionResponseSchema,
  webhookDeliverySchema,
} from '../schemas';

type MerchantEnv = { Variables: { merchantId?: string; merchantName?: string } };
export const paymentRoutes = new OpenAPIHono<MerchantEnv>({ defaultHook });

// Apply auth middleware to all payment routes
paymentRoutes.use('/*', authMiddleware);

// ── POST /api/payments ─────────────────────────────────────────

const createPaymentRoute = createRoute({
  method: 'post',
  path: '/payments',
  tags: ['Payments'],
  summary: 'Create a payment',
  description:
    'Creates an order and calls the chosen gateway to obtain a payment_url. ' +
    'Returns 201 on success, 200 on idempotent hit, 409 on duplicate, 502 on gateway error.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    headers: z.object({
      'idempotency-key': z.string().optional().openapi({
        description: 'Client-generated unique key to prevent duplicate orders',
      }),
    }),
    body: {
      content: { 'application/json': { schema: createPaymentBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Payment created. Redirect end user to `data.payment_url`.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: orderResponseSchema }),
        },
      },
    },
    200: {
      description: 'Idempotent hit — existing order returned unchanged.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: orderResponseSchema }),
        },
      },
    },
    400: {
      description: 'Invalid request body.',
      content: { 'application/json': { schema: errorSchema } },
    },
    401: {
      description: 'Missing or invalid API key.',
      content: { 'application/json': { schema: errorSchema } },
    },
    409: {
      description: 'Duplicate order conflict.',
      content: { 'application/json': { schema: errorSchema } },
    },
    502: {
      description: 'Gateway API error.',
      content: { 'application/json': { schema: errorSchema } },
    },
    500: {
      description: 'Unexpected server error.',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

paymentRoutes.openapi(createPaymentRoute, async (c) => {
  const body = c.req.valid('json');
  const headerKey = c.req.valid('header')['idempotency-key'];
  const idempotencyKey = body.idempotency_key ?? headerKey;

  // Check idempotency (scoped to merchant)
  const merchantId = c.get('merchantId') ?? 'merch_default';
  if (idempotencyKey) {
    try {
      const existing = await getOrderByIdempotencyKey(idempotencyKey, merchantId);
      if (existing) {
        return c.json({ success: true as const, data: orderToResponse(existing) }, 200);
      }
    } catch {
      // Ignore — proceed with creation
    }
  }

  // Get gateway implementation
  const gw = getGateway(body.gateway);
  if (!gw) {
    return c.json({
      success: false as const,
      error: { code: 'INVALID_BODY', message: `Unsupported gateway: ${body.gateway}` },
    }, 400);
  }

  // Create order in registry
  const orderParams: CreateOrderParams = {
    project_id: merchantId,
    merchant_id: merchantId,
    project_order_id: body.project_order_id,
    callback_url: body.callback_url,
    gateway: body.gateway,
    amount: body.amount,
    currency: body.currency,
    payment_method: body.payment_method,
    metadata: body.metadata as Record<string, unknown> | undefined,
    idempotency_key: idempotencyKey,
  };
  let order;
  try {
    order = await createOrder(orderParams);
  } catch (err: unknown) {
    if (err instanceof DuplicateOrderError) {
      return c.json({
        success: false as const,
        error: { code: 'DUPLICATE_ORDER', message: err.message },
      }, 409);
    }
    throw err;
  }
  // Create payment via gateway (with latency tracking)
  const endTimer = paymentCreationDuration.startTimer({ gateway: body.gateway });
  try {
    const result = await gw.createPayment({
      orderId: order.id,
      amount: body.amount,
      currency: order.currency,
      paymentMethod: body.payment_method,
      customerName: body.customer?.name,
      customerEmail: body.customer?.email,
    });
    endTimer();

    // Update order with gateway reference and payment URL
    await updateOrderStatus(
      order.id,
      'pending',
      result.gatewayReference,
      result.paymentUrl,
      body.payment_method,
    );

    // Re-read to get updated data
    const updatedOrder = await getOrderById(order.id);
    if (!updatedOrder) throw new Error('Order disappeared after creation');

    logger.info('Payment created', {
      order_id: updatedOrder.id,
      gateway: body.gateway,
      gateway_reference: result.gatewayReference,
      amount: body.amount,
    });

    paymentsCreatedCounter.inc({ gateway: body.gateway, status: 'success' });
    return c.json({ success: true as const, data: orderToResponse(updatedOrder) }, 201);
  } catch (err: unknown) {
    endTimer();
    paymentsCreatedCounter.inc({ gateway: body.gateway, status: 'failed' });
    errorsCounter.inc({ type: 'payment_creation' });

    // Mark order as failed if gateway errored
    await updateOrderStatus(order.id, 'failed');

    if (err instanceof GatewayError) {
      logger.warn('Gateway error during payment creation', {
        gateway: body.gateway,
        order_id: order.id,
        error: err.message,
      });
      return c.json({
        success: false as const,
        error: { code: 'GATEWAY_ERROR', message: err.message },
      }, 502);
    }

    throw err;
  }
});

// ── GET /api/payments/:id ──────────────────────────────────────

const getPaymentRoute = createRoute({
  method: 'get',
  path: '/payments/{id}',
  tags: ['Payments'],
  summary: 'Get payment status',
  description: 'Returns the current status and details of an order by its 1ai-payment ID.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ description: '1ai-payment order ID', example: 'pay_01j2k3l4m5n6' }),
    }),
  },
  responses: {
    200: {
      description: 'Order found.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: orderResponseSchema }),
        },
      },
    },
    401: {
      description: 'Missing or invalid API key.',
      content: { 'application/json': { schema: errorSchema } },
    },
    404: {
      description: 'Order not found.',
      content: { 'application/json': { schema: errorSchema } },
    },
    500: {
      description: 'Unexpected server error.',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

paymentRoutes.openapi(getPaymentRoute, async (c) => {
  const { id } = c.req.valid('param');

  try {
    const order = await getOrderById(id);
    if (!order) {
      return c.json({
        success: false as const,
        error: { code: 'ORDER_NOT_FOUND', message: `Order not found: ${id}` },
      }, 404);
    }
    return c.json({ success: true as const, data: orderToResponse(order) }, 200);
  } catch (err: unknown) {
    logger.error('Error fetching order', { id, error: err instanceof Error ? err.message : String(err) });
    return c.json({
      success: false as const,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch order' },
    }, 500);
  }
});

// ── GET /api/gateways ──────────────────────────────────────────

const listGatewaysRoute = createRoute({
  method: 'get',
  path: '/gateways',
  tags: ['Gateways'],
  summary: 'List available gateways',
  description: 'Returns all registered gateways with their configuration status, currencies, and payment methods.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Gateway list.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.array(gatewayInfoSchema) }),
        },
      },
    },
    401: {
      description: 'Missing or invalid API key.',
      content: { 'application/json': { schema: errorSchema } },
    },
    500: {
      description: 'Unexpected server error.',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

paymentRoutes.openapi(listGatewaysRoute, async (c) => {
  try {
    const gateways = getAvailableGateways();
    return c.json({ success: true as const, data: gateways }, 200);
  } catch (err: unknown) {
    logger.error('Error listing gateways', { error: err instanceof Error ? err.message : String(err) });
    return c.json({
      success: false as const,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list gateways' },
    }, 500);
  }
});

// ── GET /api/gateways/:gateway/methods ─────────────────────────

const getGatewayMethodsRoute = createRoute({
  method: 'get',
  path: '/gateways/{gateway}/methods',
  tags: ['Gateways'],
  summary: 'List payment methods for a gateway',
  description: 'Returns all payment method codes, names, and supported currencies for the specified gateway.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ gateway: gatewayNameSchema }),
  },
  responses: {
    200: {
      description: 'Gateway methods.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: gatewayInfoSchema }),
        },
      },
    },
    401: {
      description: 'Missing or invalid API key.',
      content: { 'application/json': { schema: errorSchema } },
    },
    404: {
      description: 'Gateway not found.',
      content: { 'application/json': { schema: errorSchema } },
    },
    500: {
      description: 'Unexpected server error.',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

paymentRoutes.openapi(getGatewayMethodsRoute, async (c) => {
  const { gateway } = c.req.valid('param');

  try {
    const info = getGatewayMethods(gateway);
    if (!info) {
      return c.json({
        success: false as const,
        error: { code: 'GATEWAY_NOT_FOUND', message: `Gateway not found: ${gateway}` },
      }, 404);
    }
    return c.json({ success: true as const, data: info }, 200);
  } catch (err: unknown) {
    logger.error('Error fetching gateway methods', {
      gateway,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({
      success: false as const,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch methods' },
    }, 500);
  }
});

// ── GET /api/transactions ──────────────────────────────────────

const listTransactionsRoute = createRoute({
  method: 'get',
  path: '/transactions',
  tags: ['Transactions'],
  summary: 'List transactions',
  description: 'Returns transaction history for the authenticated merchant with filters.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: z.object({
      status: z.string().optional().openapi({ example: 'success' }),
      gateway: z.string().optional().openapi({ example: 'midtrans' }),
      from: z.string().optional().openapi({ description: 'ISO date string', example: '2026-01-01' }),
      to: z.string().optional().openapi({ description: 'ISO date string', example: '2026-12-31' }),
      limit: z.coerce.number().int().min(1).max(100).default(50).openapi({ example: 50 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
    }),
  },
  responses: {
    200: {
      description: 'Transaction list.',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.object({
              transactions: z.array(transactionResponseSchema),
              total: z.number(),
              limit: z.number(),
              offset: z.number(),
            }),
          }),
        },
      },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    500: { description: 'Internal error.', content: { 'application/json': { schema: errorSchema } } },
  },
});

paymentRoutes.openapi(listTransactionsRoute, async (c) => {
  const merchantId = c.get('merchantId') ?? 'merch_default';
  const query = c.req.valid('query');

  try {
    const result = await listOrders({
      merchant_id: merchantId,
      gateway: query.gateway,
      status: query.status,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });

    return c.json({
      success: true as const,
      data: {
        transactions: result.orders.map((o) => ({
          id: o.id,
          gateway: o.gateway,
          gateway_reference: o.gateway_reference,
          status: o.status,
          amount: o.amount,
          currency: o.currency,
          payment_method: o.payment_method,
          fee: o.fee,
          net: o.net,
          created_at: o.created_at,
        })),
        total: result.total,
        limit: query.limit,
        offset: query.offset,
      },
    }, 200);
  } catch (err: unknown) {
    logger.error('Error listing transactions', { error: err instanceof Error ? err.message : String(err) });
    return c.json({
      success: false as const,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list transactions' },
    }, 500);
  }
});

// ── GET /api/webhook-deliveries ────────────────────────────────

const listWebhookDeliveriesRoute = createRoute({
  method: 'get',
  path: '/webhook-deliveries',
  tags: ['Webhooks'],
  summary: 'List webhook deliveries',
  description: 'Returns webhook delivery log for the authenticated merchant.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: z.object({
      order_id: z.string().optional().openapi({ example: 'pay_abc123' }),
      limit: z.coerce.number().int().min(1).max(100).default(20).openapi({ example: 20 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
    }),
  },
  responses: {
    200: {
      description: 'Webhook delivery list.',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.object({
              deliveries: z.array(webhookDeliverySchema),
              total: z.number(),
            }),
          }),
        },
      },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    500: { description: 'Internal error.', content: { 'application/json': { schema: errorSchema } } },
  },
});

paymentRoutes.openapi(listWebhookDeliveriesRoute, async (c) => {
  const merchantId = c.get('merchantId') ?? 'merch_default';
  const query = c.req.valid('query');

  try {
    const db = getDb();
    const conditions = ['o.merchant_id = ?'];
    const args: Array<string | number> = [merchantId];

    if (query.order_id) {
      conditions.push('we.order_id = ?');
      args.push(query.order_id);
    }

    const where = conditions.join(' AND ');
    const limit = Math.min(query.limit, 100);

    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM webhook_events we JOIN orders o ON we.order_id = o.id WHERE ${where}`,
      args,
    });
    const total = Number((countResult.rows[0] as Record<string, unknown>).count);

    const result = await db.execute({
      sql: `SELECT we.* FROM webhook_events we JOIN orders o ON we.order_id = o.id WHERE ${where} ORDER BY we.created_at DESC LIMIT ? OFFSET ?`,
      args: [...args, limit, query.offset],
    });

    return c.json({
      success: true as const,
      data: {
        deliveries: result.rows.map((row) => ({
          id: row.id as string,
          gateway: row.gateway as string,
          order_id: row.order_id as string | null,
          status: row.status as string | null,
          signature_valid: Number(row.signature_valid),
          created_at: row.created_at as string,
        })),
        total,
      },
    }, 200);
  } catch (err: unknown) {
    logger.error('Error listing webhook deliveries', { error: err instanceof Error ? err.message : String(err) });
    return c.json({
      success: false as const,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list webhook deliveries' },
    }, 500);
  }
});
