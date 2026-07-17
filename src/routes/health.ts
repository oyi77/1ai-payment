/**
 * Health route — service health check.
 *
 * No authentication required.
 * Auto-generates OpenAPI spec via @hono/zod-openapi.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { getDb } from "../config/database";
import { defaultHook, healthResponseSchema } from "../schemas";
import { getGatewayHealth } from "../services/gateway.service";

export const healthRoutes = new OpenAPIHono({ defaultHook });

const healthRoute = createRoute({
	method: "get",
	path: "/health",
	tags: ["Health"],
	summary: "Service health check",
	description:
		"Returns service status, database connectivity, and per-gateway configuration status.",
	security: [], // No auth required
	responses: {
		200: {
			description:
				"Health status (always 200; inspect `status` field for degraded state)",
			content: { "application/json": { schema: healthResponseSchema } },
		},
	},
});

healthRoutes.openapi(healthRoute, async (c) => {
	let databaseOk = true;
	try {
		const db = getDb();
		await db.execute("SELECT 1");
	} catch {
		databaseOk = false;
	}

	const gateways = getGatewayHealth();
	const gatewayStatus = Object.fromEntries(
		Object.entries(gateways).map(
			([name, status]) =>
				[name, status.configured ? "configured" : "missing_key"] as const,
		),
	) as Record<string, "configured" | "missing_key">;

	return c.json(
		{
			status: databaseOk ? ("ok" as const) : ("degraded" as const),
			version: "0.1.0",
			uptime: process.uptime(),
			database: databaseOk ? ("ok" as const) : ("error" as const),
			gateways: gatewayStatus,
		},
		200,
	);
});
