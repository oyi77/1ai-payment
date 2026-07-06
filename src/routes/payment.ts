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
  type CreateOrderParams,
} from '../services/order.service';
import { getGateway, getAvailableGateways, getGatewayMethods } from '../services/gateway.service';
import { DuplicateOrderError, GatewayError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  gatewayNameSchema,
  createPaymentBodySchema,
  orderResponseSchema,
  gatewayInfoSchema,
  errorSchema,
  orderToResponse,
  defaultHook,
} from '../schemas';

export const paymentRoutes = new OpenAPIHono({ defaultHook });

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

  // Check idempotency
  if (idempotencyKey) {
    try {
      const existing = await getOrderByIdempotencyKey(idempotencyKey);
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
    project_id: '1ai-content', // Hardcoded for now; multi-tenant in future
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

  // Create payment via gateway
  try {
    const result = await gw.createPayment({
      orderId: order.id,
      amount: body.amount,
      currency: order.currency,
      paymentMethod: body.payment_method,
      customerName: body.customer?.name,
      customerEmail: body.customer?.email,
    });

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

    return c.json({ success: true as const, data: orderToResponse(updatedOrder) }, 201);
  } catch (err: unknown) {
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
