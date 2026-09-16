// Per-merchant gateway credential endpoints.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../../config/database";
import { MERCHANT_CREDENTIAL_KEYS } from "../../config/env";
import { authMiddleware } from "../../middleware/auth";
import {
	GATEWAY_NAMES,
	createMerchantBodySchema,
	createMerchantResponseSchema,
	defaultHook,
	errorSchema,
	merchantGatewayResponseSchema,
	merchantResponseSchema,
	rotateKeyResponseSchema,
	setGatewayCredentialsBodySchema,
	toggleGatewayBodySchema,
	updateMerchantBodySchema,
} from "../../schemas";
import {
	encrypt,
	generateApiKey,
	generateMerchantId,
	generateWebhookSecret,
	sha256Hash,
} from "../../utils/crypto";
import { logger } from "../../utils/logger";

type MerchantEnv = {
	Variables: { merchantId?: string; merchantName?: string };
};
export const merchantGatewaysRouter = new OpenAPIHono<MerchantEnv>({
	defaultHook,
});

merchantGatewaysRouter.use("/*", authMiddleware);
// ── GET /api/merchants/:id/gateways ─────────────────────────────

const listGatewaysRoute = createRoute({
	method: "get",
	path: "/merchants/{id}/gateways",
	tags: ["Merchants"],
	summary: "List merchant gateway configs",
	description: "Returns configured gateways for the merchant.",
	security: [{ ApiKeyAuth: [] }],
	request: { params: z.object({ id: z.string() }) },
	responses: {
		200: {
			description: "Gateway list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.array(merchantGatewayResponseSchema),
					}),
				},
			},
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		403: {
			description: "Forbidden.",
			content: { "application/json": { schema: errorSchema } },
		},
		404: {
			description: "Merchant not found.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

merchantGatewaysRouter.openapi(listGatewaysRoute, async (c) => {
	const { id } = c.req.valid("param");
	const requesterId = c.get("merchantId");
	if (id !== requesterId) {
		return c.json(
			{
				success: false as const,
				error: { code: "FORBIDDEN", message: "Forbidden" },
			},
			403,
		);
	}
	const db = getDb();

	const merchant = await db.execute({
		sql: "SELECT id FROM merchants WHERE id = ?",
		args: [id],
	});
	if (merchant.rows.length === 0) {
		return c.json(
			{
				success: false as const,
				error: { code: "NOT_FOUND", message: `Merchant not found: ${id}` },
			},
			404,
		);
	}

	const result = await db.execute({
		sql: "SELECT id, merchant_id, gateway, environment, enabled, created_at, updated_at FROM merchant_gateways WHERE merchant_id = ?",
		args: [id],
	});

	return c.json(
		{
			success: true as const,
			data: result.rows.map((row) => ({
				id: row.id as string,
				merchant_id: row.merchant_id as string,
				gateway: row.gateway as string,
				environment: row.environment as string,
				enabled: Boolean(row.enabled),
				created_at: row.created_at as string,
				updated_at: row.updated_at as string,
			})),
		},
		200,
	);
});

// ── PUT /api/merchants/:id/gateways/:gateway ────────────────────

const setGatewayRoute = createRoute({
	method: "put",
	path: "/merchants/{id}/gateways/{gateway}",
	tags: ["Merchants"],
	summary: "Set gateway credentials",
	description:
		"Set or update gateway credentials for a merchant. Credentials are encrypted at rest.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({ id: z.string(), gateway: z.enum(GATEWAY_NAMES) }),
		body: {
			content: {
				"application/json": { schema: setGatewayCredentialsBodySchema },
			},
		},
	},
	responses: {
		200: {
			description: "Gateway config set.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: merchantGatewayResponseSchema,
					}),
				},
			},
		},
		400: {
			description: "Invalid gateway.",
			content: { "application/json": { schema: errorSchema } },
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		403: {
			description: "Forbidden.",
			content: { "application/json": { schema: errorSchema } },
		},
		404: {
			description: "Merchant not found.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

merchantGatewaysRouter.openapi(setGatewayRoute, async (c) => {
	const { id, gateway } = c.req.valid("param");
	const body = c.req.valid("json");
	const requesterId = c.get("merchantId");
	if (id !== requesterId) {
		return c.json(
			{
				success: false as const,
				error: { code: "FORBIDDEN", message: "Forbidden" },
			},
			403,
		);
	}
	const db = getDb();

	const merchant = await db.execute({
		sql: "SELECT id FROM merchants WHERE id = ?",
		args: [id],
	});
	if (merchant.rows.length === 0) {
		return c.json(
			{
				success: false as const,
				error: { code: "NOT_FOUND", message: `Merchant not found: ${id}` },
			},
			404,
		);
	}
	const allowed = MERCHANT_CREDENTIAL_KEYS[gateway];
	if (!allowed) {
		return c.json(
			{
				success: false as const,
				error: {
					code: "INVALID_GATEWAY",
					message: `Gateway '${gateway}' does not accept merchant-owned credentials (uses platform credentials)`,
				},
			},
			400,
		);
	}
	const unknownKeys = Object.keys(body.credentials).filter(
		(k) => !allowed.includes(k),
	);
	if (unknownKeys.length > 0) {
		return c.json(
			{
				success: false as const,
				error: {
					code: "INVALID_CREDENTIALS",
					message: `Unknown credential keys for ${gateway}: ${unknownKeys.join(", ")}. Allowed: ${allowed.join(", ")}`,
				},
			},
			400,
		);
	}

	const encrypted = encrypt(JSON.stringify(body.credentials));
	const gwId = `mgw_${id.replace("merch_", "")}_${gateway}`;

	await db.execute({
		sql: `INSERT INTO merchant_gateways (id, merchant_id, gateway, credentials, environment, enabled)
          VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(merchant_id, gateway) DO UPDATE SET credentials = ?, environment = ?, enabled = 1, updated_at = datetime('now')`,
		args: [
			gwId,
			id,
			gateway,
			encrypted,
			body.environment,
			encrypted,
			body.environment,
		],
	});

	logger.info("Merchant gateway config set", {
		merchant_id: id,
		gateway,
		environment: body.environment,
	});

	return c.json(
		{
			success: true as const,
			data: {
				id: gwId,
				merchant_id: id,
				gateway,
				environment: body.environment,
				enabled: true,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		},
		200,
	);
});

// ── PATCH /api/merchants/:id/gateways/:gateway ──────────────────

const toggleGatewayRoute = createRoute({
	method: "patch",
	path: "/merchants/{id}/gateways/{gateway}",
	tags: ["Merchants"],
	summary: "Enable/disable gateway",
	description: "Toggle a gateway on or off for a merchant.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({ id: z.string(), gateway: z.enum(GATEWAY_NAMES) }),
		body: {
			content: { "application/json": { schema: toggleGatewayBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Gateway toggled.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: merchantGatewayResponseSchema,
					}),
				},
			},
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		403: {
			description: "Forbidden.",
			content: { "application/json": { schema: errorSchema } },
		},
		404: {
			description: "Gateway config not found.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

merchantGatewaysRouter.openapi(toggleGatewayRoute, async (c) => {
	const { id, gateway } = c.req.valid("param");
	const body = c.req.valid("json");
	const requesterId = c.get("merchantId");
	if (id !== requesterId) {
		return c.json(
			{
				success: false as const,
				error: { code: "FORBIDDEN", message: "Forbidden" },
			},
			403,
		);
	}
	const db = getDb();

	await db.execute({
		sql: "UPDATE merchant_gateways SET enabled = ?, updated_at = datetime('now') WHERE merchant_id = ? AND gateway = ?",
		args: [body.enabled ? 1 : 0, id, gateway],
	});

	const result = await db.execute({
		sql: "SELECT id, merchant_id, gateway, environment, enabled, created_at, updated_at FROM merchant_gateways WHERE merchant_id = ? AND gateway = ?",
		args: [id, gateway],
	});

	if (result.rows.length === 0) {
		return c.json(
			{
				success: false as const,
				error: {
					code: "NOT_FOUND",
					message: `Gateway config not found: ${gateway}`,
				},
			},
			404,
		);
	}

	const row = result.rows[0];
	return c.json(
		{
			success: true as const,
			data: {
				id: row.id as string,
				merchant_id: row.merchant_id as string,
				gateway: row.gateway as string,
				environment: row.environment as string,
				enabled: Boolean(row.enabled),
				created_at: row.created_at as string,
				updated_at: row.updated_at as string,
			},
		},
		200,
	);
});

// ── DELETE /api/merchants/:id/gateways/:gateway ─────────────────

const deleteGatewayRoute = createRoute({
	method: "delete",
	path: "/merchants/{id}/gateways/{gateway}",
	tags: ["Merchants"],
	summary: "Remove gateway config",
	description:
		"Remove gateway credentials for a merchant. Merchant will fall back to platform credentials.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({ id: z.string(), gateway: z.enum(GATEWAY_NAMES) }),
	},
	responses: {
		200: {
			description: "Gateway config removed.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({ deleted: z.literal(true) }),
					}),
				},
			},
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		403: {
			description: "Forbidden.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

merchantGatewaysRouter.openapi(deleteGatewayRoute, async (c) => {
	const { id, gateway } = c.req.valid("param");
	const requesterId = c.get("merchantId");
	if (id !== requesterId) {
		return c.json(
			{
				success: false as const,
				error: { code: "FORBIDDEN", message: "Forbidden" },
			},
			403,
		);
	}
	const db = getDb();

	await db.execute({
		sql: "DELETE FROM merchant_gateways WHERE merchant_id = ? AND gateway = ?",
		args: [id, gateway],
	});

	logger.info("Merchant gateway config removed", { merchant_id: id, gateway });

	return c.json(
		{ success: true as const, data: { deleted: true as const } },
		200,
	);
});
