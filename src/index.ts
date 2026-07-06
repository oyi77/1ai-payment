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
import { healthRoutes } from './routes/health';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { defaultHook } from './schemas';

const config = getConfig();
const app = new OpenAPIHono({ defaultHook });

// Middleware
app.use('*', cors());
app.use('/api/*', rateLimitMiddleware({ windowMs: 60_000, max: 60 }));
app.use('/webhook/*', rateLimitMiddleware({ windowMs: 60_000, max: 120 }));

// API routes
app.route('/', healthRoutes);
app.route('/webhook', webhookRoutes);
app.route('/api', paymentRoutes);

// Auto-generated OpenAPI JSON spec at /doc
app.doc('/doc', {
  openapi: '3.1.0',
  info: {
    title: '1ai-payment',
    version: '0.1.0',
    description: 'Payment gateway aggregator microservice for 1ai-ecosystem',
  },
});

// Swagger UI at /reference
app.get('/reference', swaggerUI({ url: '/doc' }));

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
