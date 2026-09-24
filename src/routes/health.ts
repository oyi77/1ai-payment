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
	const entries = Object.values(gateways);
	// Counts only: per-gateway configured/missing_key map would leak the live
	// attack surface on an unauthenticated endpoint (Sweep108).
	const configured = entries.filter((g) => g.configured).length;

	return c.json(
		{
			status: databaseOk ? ("ok" as const) : ("degraded" as const),
			version: "0.1.0",
			uptime: process.uptime(),
			database: databaseOk ? ("ok" as const) : ("error" as const),
			gateways: { configured, total: entries.length },
		},
		200,
	);
});
