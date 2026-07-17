/**
 * 1ai-payment — Payment Gateway Aggregation Microservice
 *
 * Unified API for creating payments and routing callbacks across multiple gateways.
 *
 * OpenAPI spec auto-generated at /doc (JSON) and /reference (Swagger UI).
 */

import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { getConfig } from "./config/env";
import { metricsHandler } from "./middleware/metrics";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { adminRoutes } from "./routes/admin";
import { healthRoutes } from "./routes/health";
import { merchantRoutes } from "./routes/merchant";
import { paymentRoutes } from "./routes/payment";
import { refundRoutes } from "./routes/refund";
import { registerRoutes } from "./routes/register";
import { webhookRoutes } from "./routes/webhook";
import { defaultHook } from "./schemas";
const config = getConfig();
export { config };

const app = new OpenAPIHono({ defaultHook });

// Middleware
app.use("*", cors({ origin: getConfig().CORS_ORIGIN }));
// Stricter rate limit for registration (5 req per hour per IP)
app.use("/api/register", rateLimitMiddleware({ windowMs: 3_600_000, max: 5 }));
app.use("/api/*", rateLimitMiddleware({ windowMs: 60_000, max: 60 }));
app.use("/webhook/*", rateLimitMiddleware({ windowMs: 60_000, max: 120 }));

// Metrics — no auth, no rate limit
app.get("/metrics", metricsHandler);

// Static files — landing page at /, merchant portal at /dashboard
app.get("/", async (c) => {
	c.header("Cache-Control", "no-cache, must-revalidate");
	return c.html(await Bun.file("./src/landing/index.html").text());
});
app.get("/favicon.svg", (c) => {
	c.header("Cache-Control", "no-cache, must-revalidate");
	return new Response(Bun.file("./src/landing/favicon.svg"), {
		headers: { "Content-Type": "image/svg+xml" },
	});
});
app.get("/dashboard", async (c) => {
	c.header("Cache-Control", "no-cache, must-revalidate");
	return c.html(await Bun.file("./src/dashboard/index.html").text());
});
app.get("/dashboard/", async (c) => {
	c.header("Cache-Control", "no-cache, must-revalidate");
	return c.html(await Bun.file("./src/dashboard/index.html").text());
});
app.route("/api", registerRoutes);

// API routes (auth required)
app.route("/", healthRoutes);
app.route("/webhook", webhookRoutes);
app.route("/api", paymentRoutes);
app.route("/api", merchantRoutes);
app.route("/api", refundRoutes);

// Admin routes — protected by adminAuthMiddleware via adminRoutes
app.route("/api", adminRoutes);

// Auto-generated OpenAPI JSON spec at /doc
app.doc("/doc", {
	openapi: "3.1.0",
	info: {
		title: "1ai-payment",
		version: "0.1.0",
		description: "Payment gateway aggregator microservice for 1ai-ecosystem",
	},
});

// Swagger UI at /reference — pre-fills API key from query param
app.get("/reference", (c) => {
	const key = c.req.query("key");
	if (key) {
		return swaggerUI({ url: "/doc", persistAuthorization: true })(
			c,
			async () => {},
		);
	}
	return swaggerUI({ url: "/doc" })(c, async () => {});
});

export { app };
