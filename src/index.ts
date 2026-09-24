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
	// Pass the Bun server into app env (Sweep144): rate-limit IP fallback
	// reads c.env.server.requestIP(req) for the true socket address. Without
	// this, every headerless request shared one "unknown" bucket.
	fetch: (req, server) => app.fetch(req, { server }),
});

logger.info(`1ai-payment ready on http://localhost:${config.PORT}`);
logger.info(`Swagger UI: http://localhost:${config.PORT}/reference`);
logger.info(`OpenAPI spec: http://localhost:${config.PORT}/doc`);

// Graceful shutdown — stop accepting, drain, exit.
// Budget (Sweep143): live PM2 kill_timeout is 5000ms, so EVERYTHING here
// must finish below that — drain 3000ms + forced exit at 4500ms. Budgets
// above 5000ms never run: PM2 SIGKILLs first. Keep in sync with
// ecosystem.config.cjs (kill_timeout) if either changes.
function shutdown(signal: string) {
	logger.info(`Received ${signal}, starting graceful shutdown...`);
	stopNexusCron();
	const forceExit = setTimeout(() => {
		logger.error("Graceful shutdown timed out, forcing exit");
		process.exit(1);
	}, 4_500).unref();
	// Drain in-flight forwards first (Sweep141): up to 3s for active
	// attempts; anything still sleeping in backoff gets a replayable dead
	// letter instead of vanishing. Then stop the server and exit.
	const finish = () => {
		// Let Bun finish draining open connections before exiting.
		server.stop().then(() => {
			clearTimeout(forceExit);
			logger.info("Graceful shutdown complete");
		});
	};
	(async () => {
		try {
			const { drainForwards } = await import("./services/forwarder.service");
			const drained = await drainForwards(3_000);
			if (drained.settled + drained.deadLettered > 0) {
				logger.info("Forward drain complete", drained);
			}
		} catch (err) {
			logger.error("Forward drain failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		finish();
	})();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
