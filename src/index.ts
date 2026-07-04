/**
 * 1ai-payment — Payment Gateway Aggregation Microservice
 *
 * Unified API for creating payments and routing callbacks across multiple gateways.
 * Internal use only; designed for future commercialization.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from './utils/logger';
import { getConfig } from './config/env';
import { initDatabase } from './config/database';
import { webhookRoutes } from './routes/webhook';
import { paymentRoutes } from './routes/payment';
import { healthRoutes } from './routes/health';
import { rateLimitMiddleware } from './middleware/rate-limit';

const config = getConfig();
const app = new Hono();

// Middleware
app.use('*', cors());
app.use('/api/*', rateLimitMiddleware({ windowMs: 60_000, max: 60 }));
app.use('/webhook/*', rateLimitMiddleware({ windowMs: 60_000, max: 120 }));

// Routes
app.route('/', healthRoutes);
app.route('/webhook', webhookRoutes);
app.route('/api', paymentRoutes);

// Global error handler
app.onError((err, c) => {
  logger.error('Unhandled error:', err);
  return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500);
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

