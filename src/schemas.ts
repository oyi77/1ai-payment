/**
 * Shared Zod schemas for OpenAPI spec generation.
 *
 * These schemas are the single source of truth for:
 * - Runtime request validation (Zod parsing)
 * - OpenAPI spec generation (@hono/zod-openapi)
 * - TypeScript types (z.infer)
 */

import { z, ZodError } from 'zod';
import { extendZodWithOpenApi } from '@hono/zod-openapi';

extendZodWithOpenApi(z);

// ── Enums ──────────────────────────────────────────────────────

export const GATEWAY_NAMES = [
  'midtrans', 'tripay', 'duitku', 'nowpayments', 'ipaymu',
  'scalev', 'xendit', 'telegram_stars', 'telegram_payments', 'paypal',
] as const;

export const gatewayNameSchema = z.enum(GATEWAY_NAMES).openapi({
  description: 'Payment gateway identifier',
  example: 'midtrans',
});

export const paymentStatusSchema = z.enum([
  'pending', 'success', 'failed', 'expired', 'cancelled',
]).openapi({
  description: 'Lifecycle status of a payment order',
  example: 'pending',
});

// ── Schemas ────────────────────────────────────────────────────

export const customerSchema = z.object({
  name: z.string().optional().openapi({ example: 'Budi Santoso' }),
  email: z.string().email().optional().openapi({ example: 'budi@example.com' }),
}).optional().openapi('Customer');

export const createPaymentBodySchema = z.object({
  gateway: gatewayNameSchema,
  amount: z.number().int().positive().openapi({
    description: 'Payment amount in smallest currency unit (IDR = full Rupiah)',
    example: 100000,
  }),
  currency: z.string().default('IDR').openapi({ example: 'IDR' }),
  payment_method: z.string().optional().openapi({
    description: 'Gateway-specific payment method code (e.g. qris, bca_va, gopay)',
    example: 'qris',
  }),
  callback_url: z.string().url().openapi({
    description: 'URL to forward the normalized payment event to after gateway callback',
    example: 'https://your-app.com/payment/callback',
  }),
  idempotency_key: z.string().optional().openapi({
    description: 'Client-generated unique key to prevent duplicate orders',
    example: 'order-usr123-1720180000',
  }),
  project_order_id: z.string().optional().openapi({
    description: 'Your application\'s own order/invoice ID for cross-reference',
    example: 'inv_789',
  }),
  customer: customerSchema,
  metadata: z.record(z.string(), z.unknown()).optional().openapi({
    description: 'Arbitrary metadata preserved through the full payment lifecycle',
    example: { user_id: 'usr_789', plan: 'pro' },
  }),
}).openapi('CreatePaymentBody');

export const orderResponseSchema = z.object({
  id: z.string().openapi({ example: 'pay_01j2k3l4m5n6' }),
  gateway: z.string().openapi({ example: 'midtrans' }),
  gateway_reference: z.string().nullable().openapi({ example: 'trx_abc123' }),
  status: z.string().openapi({ example: 'pending' }),
  amount: z.number().openapi({ example: 100000 }),
  currency: z.string().openapi({ example: 'IDR' }),
  payment_method: z.string().nullable().openapi({ example: 'qris' }),
  payment_url: z.string().nullable().openapi({ example: 'https://sandbox.midtrans.com/pay/abc123' }),
  metadata: z.record(z.string(), z.unknown()).nullable().openapi({ example: { user_id: 'usr_789' } }),
  created_at: z.string().openapi({ example: '2026-07-05T10:00:00.000Z' }),
  updated_at: z.string().openapi({ example: '2026-07-05T10:01:00.000Z' }),
}).openapi('Order');

export const paymentMethodSchema = z.object({
  code: z.string().openapi({ example: 'qris' }),
  name: z.string().openapi({ example: 'QRIS' }),
  currencies: z.array(z.string()).openapi({ example: ['IDR'] }),
}).openapi('PaymentMethod');

export const gatewayInfoSchema = z.object({
  gateway: z.string().openapi({ example: 'midtrans' }),
  enabled: z.boolean().openapi({ example: true }),
  currencies: z.array(z.string()).openapi({ example: ['IDR'] }),
  methods: z.array(paymentMethodSchema),
}).openapi('GatewayInfo');

export const errorSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string().openapi({ example: 'INVALID_BODY' }),
    message: z.string().openapi({ example: 'gateway is required' }),
  }),
}).openapi('Error');

export const webhookErrorSchema = z.object({
  error: z.string().openapi({ example: 'Invalid signature' }),
}).openapi('WebhookError');

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']).openapi({ example: 'ok' }),
  version: z.string().openapi({ example: '0.1.0' }),
  uptime: z.number().openapi({ description: 'Process uptime in seconds', example: 3600.42 }),
  database: z.enum(['ok', 'error']).openapi({ example: 'ok' }),
  gateways: z.record(z.string(), z.enum(['configured', 'missing_key'])).openapi({
    example: { midtrans: 'configured', tripay: 'missing_key' },
  }),
}).openapi('HealthResponse');

export const webhookAckSchema = z.object({
  ok: z.literal(true),
}).openapi('WebhookAck');

// ── Helpers ────────────────────────────────────────────────────

export function orderToResponse(order: {
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

// ── Shared validation hook ──────────────────────────────────────

export const defaultHook = (result: { success: boolean; error?: unknown; data?: unknown }, c: { json: (data: unknown, status?: number) => Response }) => {
  if (!result.success && result.error instanceof ZodError) {
    const first = result.error.issues[0];
    const path = first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    return c.json(
      { success: false as const, error: { code: 'INVALID_BODY', message: `${first.message}${path}` } },
      400,
    );
  }
};
