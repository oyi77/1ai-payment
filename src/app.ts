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
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getConfig } from "./config/env";
import { adminAuthMiddleware } from "./middleware/admin-auth";
import { authMiddleware } from "./middleware/auth";
import { metricsHandler } from "./middleware/metrics";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { adminRoutes } from "./routes/admin";
import { healthRoutes } from "./routes/health";
import { merchantRoutes } from "./routes/merchant";
import { paymentRoutes } from "./routes/payment";
import { refundRoutes } from "./routes/refund";
import { registerRoutes } from "./routes/register";
import { savedMethodsRouter } from "./routes/saved-methods";
import { webhookRoutes } from "./routes/webhook";
import { defaultHook } from "./schemas";
import { PaymentError } from "./utils/errors";
import { logger } from "./utils/logger";
const config = getConfig();
export { config };

const app = new OpenAPIHono({ defaultHook });

// Middleware
app.use("*", cors({ origin: getConfig().CORS_ORIGIN }));

// Pre-auth IP abuse guard — runs BEFORE auth so unauthenticated floods
// (wrong/missing API key, webhook brute attempts) cannot bypass rate
// limiting. Keys by client IP (merchantId is not set yet). The post-auth
// per-merchant limiter below still enforces plan tiers for authed traffic.
app.use("/api/*", rateLimitMiddleware({ windowMs: 60_000, max: 60 }));
app.use("/webhook/*", rateLimitMiddleware({ windowMs: 60_000, max: 120 }));

// Merchant auth BEFORE rate limiting: the limiter keys by merchantId (set by
// auth) so plans apply per-merchant, not per-IP. Applied per-prefix because
// Hono <4.13 rejects array-form app.use([...]) with "handler is an instance
// of Array". /api/register is public; /api/admin/* is exempt — admin routes
// carry their own adminAuthMiddleware.
app.use("/api/payments/*", authMiddleware);
app.use("/api/gateways/*", authMiddleware);
app.use("/api/transactions/*", authMiddleware);
app.use("/api/webhook-deliveries/*", authMiddleware);
app.use("/api/refunds/*", authMiddleware);
app.use("/api/merchants/*", authMiddleware);

// Stricter rate limit for registration (5 req per hour per IP)
app.use("/api/register", rateLimitMiddleware({ windowMs: 3_600_000, max: 5 }));
// Post-auth per-merchant tiering (free=30/pro=120/enterprise=600) — keys by
// merchantId set by authMiddleware above; falls back to IP keying (unauth).
app.use("/api/*", rateLimitMiddleware({ windowMs: 60_000, max: 60 }));

// Metrics — admin auth required
app.get("/metrics", adminAuthMiddleware(), metricsHandler);

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
app.route("/api", savedMethodsRouter);

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

// Unified error envelope — every handler error and unhandled route falls back
// to { success: false, error: { code, message } }.
app.onError((err, c) => {
	if (err instanceof PaymentError) {
		return c.json(
			{
				success: false as const,
				error: { code: err.code, message: err.message },
			},
			err.statusCode as ContentfulStatusCode,
		);
	}
	// Body parse failures (c.req.json() throws a standard Error, not the module-local
	// `SyntaxError` const re-exported above) and unknown RPC/route errors surface here.
	if (
		err instanceof globalThis.SyntaxError ||
		(err instanceof Error && /JSON|parse|body/i.test(err.message))
	) {
		return c.json(
			{
				success: false as const,
				error: { code: "BAD_REQUEST", message: "Invalid request body" },
			},
			400,
		);
	}
	logger.error("Unhandled error", { error: err });
	const message =
		config.NODE_ENV === "production"
			? "Internal server error"
			: (err.message ?? "Internal server error");
	return c.json(
		{
			success: false as const,
			error: { code: "INTERNAL_ERROR", message },
		},
		500,
	);
});

app.notFound((c) =>
	c.json(
		{
			success: false as const,
			error: { code: "NOT_FOUND", message: "Route not found" },
		},
		404,
	),
);

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
