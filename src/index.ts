/**
 * 1ai-payment — Payment Gateway Aggregation Microservice
 *
 * Unified API for creating payments and routing callbacks across multiple gateways.
 * Internal use only; designed for future commercialization.
 *
 * OpenAPI spec auto-generated at /doc (JSON) and /reference (Swagger UI).
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import { logger } from './utils/logger';
import { getConfig } from './config/env';
import { initDatabase } from './config/database';
import { webhookRoutes } from './routes/webhook';
import { paymentRoutes } from './routes/payment';
import { merchantRoutes } from './routes/merchant';
import { refundRoutes } from './routes/refund';
import { healthRoutes } from './routes/health';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { defaultHook } from './schemas';

const config = getConfig();
const app = new OpenAPIHono({ defaultHook });

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

  const { getDb } = await import('./config/database');
  const { generateMerchantId, generateApiKey, generateWebhookSecret, sha256Hash } = await import('./utils/crypto');
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
      return c.json({ success: false as const, error: { code: 'DUPLICATE', message: 'Merchant already exists' } }, 409);
    }
    throw err;
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
  const key = c.req.query('key');
  if (key) {
    return swaggerUI({ url: '/doc', persistAuthorization: true })(c, async () => {});
  }
  return swaggerUI({ url: '/doc' })(c, async () => {});
});

// Dashboard at /dashboard
app.get('/dashboard', async (c) => {
  const file = Bun.file(new URL('./dashboard/index.html', import.meta.url));
  return new Response(file, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
});

// Global error handler (thrown errors only — validation handled by defaultHook)
app.onError((err, c) => {
  logger.error('Unhandled error:', err);
  return c.json({ success: false as const, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
});

// 404
app.notFound((c) => c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));

// Start
await initDatabase();

logger.info(`Starting 1ai-payment on port ${config.PORT}...`);

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
});

logger.info(`1ai-payment ready on http://localhost:${config.PORT}`);
logger.info(`Swagger UI: http://localhost:${config.PORT}/reference`);
logger.info(`OpenAPI spec: http://localhost:${config.PORT}/doc`);
