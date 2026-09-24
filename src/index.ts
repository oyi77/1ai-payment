/**
 * 1ai-payment — Server entry point.
 *
 * Imports the configured app from ./app and starts the Bun HTTP server.
 * Tests import `app` directly and call app.fetch() without starting a server.
 */

import { app, config } from "./app";
import { initDatabase } from "./config/database";
import { startNexusCron, stopNexusCron } from "./services/nexus-cron";
import { logger } from "./utils/logger";
await initDatabase();

startNexusCron();

logger.info(`Starting 1ai-payment on port ${config.PORT}...`);

// Localhost-only: the only ingress is the Cloudflare tunnel (see
// /etc/cloudflared/config.yml → 127.0.0.1:3100). Binding * would let LAN
// clients bypass the tunnel and spoof CF-Connecting-IP, defeating IP-keyed
// rate limits. Cloudflare overwrites the header with the real client IP.
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: config.PORT,
	fetch: app.fetch,
});

logger.info(`1ai-payment ready on http://localhost:${config.PORT}`);
logger.info(`Swagger UI: http://localhost:${config.PORT}/reference`);
logger.info(`OpenAPI spec: http://localhost:${config.PORT}/doc`);

// Graceful shutdown — stop accepting, drain, exit
function shutdown(signal: string) {
	logger.info(`Received ${signal}, starting graceful shutdown...`);
	stopNexusCron();
	const forceExit = setTimeout(() => {
		logger.error("Graceful shutdown timed out, forcing exit");
		process.exit(1);
	}, 10_000).unref();
	// Let Bun finish draining open connections before exiting.
	server.stop().then(() => {
		clearTimeout(forceExit);
		logger.info("Graceful shutdown complete");
	});
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
