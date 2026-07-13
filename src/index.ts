/**
 * 1ai-payment — Server entry point.
 *
 * Imports the configured app from ./app and starts the Bun HTTP server.
 * Tests import `app` directly and call app.fetch() without starting a server.
 */

import { app, config } from './app';
import { initDatabase } from './config/database';
import { logger } from './utils/logger';
await initDatabase();

logger.info(`Starting 1ai-payment on port ${config.PORT}...`);

const server = Bun.serve({
  port: config.PORT,
  fetch: app.fetch,
});

logger.info(`1ai-payment ready on http://localhost:${config.PORT}`);
logger.info(`Swagger UI: http://localhost:${config.PORT}/reference`);
logger.info(`OpenAPI spec: http://localhost:${config.PORT}/doc`);

// Graceful shutdown — stop accepting, drain, exit
function shutdown(signal: string) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  server.stop();
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
  queueMicrotask(() => {
    clearTimeout(forceExit);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
