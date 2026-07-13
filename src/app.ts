/**
 * 1ai-payment — Payment Gateway Aggregation Microservice
 *
 * Unified API for creating payments and routing callbacks across multiple gateways.
 * Internal use only; designed for future commercialization.
 *
 * OpenAPI spec auto-generated at /doc (JSON) and /reference (Swagger UI).
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { getDb } from './config/database';
import { getConfig } from './config/env';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { healthRoutes } from './routes/health';
import { merchantRoutes } from './routes/merchant';
import { paymentRoutes } from './routes/payment';
import { refundRoutes } from './routes/refund';
import { webhookRoutes } from './routes/webhook';
import { defaultHook } from './schemas';
import { generateApiKey, generateMerchantId, generateWebhookSecret, sha256Hash } from './utils/crypto';
import { logger } from './utils/logger';

export const config = getConfig();
export const app = new OpenAPIHono({ defaultHook });

// Middleware
app.use('*', cors());
app.use('/api/*', rateLimitMiddleware({ windowMs: 60_000, max: 60 }));
app.use('/webhook/*', rateLimitMiddleware({ windowMs: 60_000, max: 120 }));

// Public registration endpoint (no auth required)
app.post('/api/register', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false as const, error: { code: 'INVALID_BODY', message: 'Invalid JSON' } }, 400);
  }

  const name = body.name as string | undefined;
  const plan = (body.plan as string) ?? 'free';
  const callbackUrl = body.default_callback_url as string | undefined;

  if (!name || typeof name !== 'string' || name.length < 1) {
    return c.json({ success: false as const, error: { code: 'INVALID_BODY', message: 'Business name is required' } }, 400);
  }
  if (!['free', 'pro', 'enterprise'].includes(plan)) {
    return c.json({ success: false as const, error: { code: 'INVALID_BODY', message: 'Invalid plan' } }, 400);
  }

  const db = getDb();

  const id = generateMerchantId();
  const apiKey = generateApiKey();
  const apiKeyHash = sha256Hash(apiKey);
  const webhookSecret = generateWebhookSecret();

  try {
    await db.execute({
      sql: `INSERT INTO merchants (id, name, api_key_hash, webhook_secret, default_callback_url, active, plan)
            VALUES (?, ?, ?, ?, ?, 1, ?)`,
      args: [id, name, apiKeyHash, webhookSecret, callbackUrl ?? null, plan],
    });

    logger.info('Merchant registered', { id, name, plan });

    return c.json({
      success: true as const,
      data: {
        merchant: { id, name, default_callback_url: callbackUrl ?? null, active: true, plan, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        api_key: apiKey,
      },
    }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      return c.json({ success: false as const, error: { code: 'CONFLICT', message: 'A merchant with this name already exists' } }, 409);
    }
    logger.error('Registration failed', { error: err });
    return c.json({ success: false as const, error: { code: 'INTERNAL_ERROR', message: 'Registration failed' } }, 500);
  }
});

// API routes (auth required)
app.route('/', healthRoutes);
app.route('/webhook', webhookRoutes);
app.route('/api', paymentRoutes);
app.route('/api', merchantRoutes);
app.route('/api', refundRoutes);

// Auto-generated OpenAPI JSON spec at /doc
app.doc('/doc', {
  openapi: '3.1.0',
  info: {
    title: '1ai-payment',
    version: '0.1.0',
    description: 'Payment gateway aggregator microservice for 1ai-ecosystem',
  },
});

// Swagger UI at /reference — pre-fills API key from query param
app.get('/reference', (c) => {
  c.header('Content-Type', 'text/html');
  const apiKey = c.req.query('api_key') || '';
  return c.html(swaggerUI({
    url: '/doc',
    query: { api_key: apiKey },
  }));
});

// Dashboard at /dashboard
app.get('/dashboard', async (c) => {
  c.header('Content-Type', 'text/html');
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>1ai-payment Dashboard</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50"><div class="max-w-7xl mx-auto p-8"><h1 class="text-3xl font-bold mb-6">1ai-payment Dashboard</h1><div id="root" class="bg-white p-6 rounded-lg shadow"><h2 class="text-xl font-semibold mb-4">Gateway Status</h2><p class="text-gray-600">Dashboard is in development. Please use the <a href="/reference" class="text-blue-600 hover:underline">API Reference</a>.</p></div></div></body>
</html>`);
});

// Global error handler (thrown errors only — validation handled by defaultHook)
app.onError((err, c) => {
  logger.error('Unhandled error', { error: err.message, path: c.req.path });
  return c.json({ success: false as const, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

// 404
app.notFound((c) => c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));
