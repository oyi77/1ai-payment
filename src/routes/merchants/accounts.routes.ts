// Merchant account endpoints -- create, read, update, key rotation.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../../config/database";
import { authMiddleware } from "../../middleware/auth";
import { GATEWAY_NAMES } from "../../schemas";
import {
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
export const accountsRouter = new OpenAPIHono<MerchantEnv>({ defaultHook });

accountsRouter.use("/*", authMiddleware);
// ── POST /api/merchants ─────────────────────────────────────────

const createMerchantRoute = createRoute({
	method: "post",
	path: "/merchants",
	tags: ["Merchants"],
	summary: "Create a merchant",
	description:
		"Creates a new merchant account and returns the API key. The key is shown ONCE — store it securely.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		body: {
			content: { "application/json": { schema: createMerchantBodySchema } },
		},
	},
	responses: {
		201: {
			description: "Merchant created.",
			content: { "application/json": { schema: createMerchantResponseSchema } },
		},
		400: {
			description: "Invalid request.",
			content: { "application/json": { schema: errorSchema } },
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		409: {
			description: "Duplicate merchant.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

accountsRouter.openapi(createMerchantRoute, async (c) => {
	const body = c.req.valid("json");
	const db = getDb();

	const id = generateMerchantId();
	const apiKey = generateApiKey();
	const apiKeyHash = sha256Hash(apiKey);
	const webhookSecret = generateWebhookSecret();

	try {
		await db.execute({
			sql: `INSERT INTO merchants (id, name, api_key_hash, webhook_secret, default_callback_url, active, plan)
            VALUES (?, ?, ?, ?, ?, 1, ?)`,
			args: [
				id,
				body.name,
				apiKeyHash,
				webhookSecret,
				body.default_callback_url ?? null,
				"free",
			],
		});

		logger.info("Merchant created", { id, name: body.name, plan: "free" });

		return c.json(
			{
				success: true as const,
				data: {
					merchant: {
						id,
						name: body.name,
						default_callback_url: body.default_callback_url ?? null,
						active: true,
						plan: "free",
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
					api_key: apiKey,
				},
			},
			201,
		);
	} catch (err: unknown) {
		if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
			return c.json(
				{
					success: false as const,
					error: {
						code: "DUPLICATE",
						message: "Merchant with this API key already exists",
					},
				},
				409,
			);
		}
		throw err;
	}
});

// ── GET /api/merchants ──────────────────────────────────────────

const listMerchantsRoute = createRoute({
	method: "get",
	path: "/merchants",
	tags: ["Merchants"],
	summary: "Get own merchant",
	description:
		"Returns the authenticated merchant's own account (no API keys — hashes only).",
	security: [{ ApiKeyAuth: [] }],
	responses: {
		200: {
			description: "Merchant list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.array(merchantResponseSchema),
					}),
				},
			},
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

accountsRouter.openapi(listMerchantsRoute, async (c) => {
	const db = getDb();
	const merchantId = c.get("merchantId") ?? "merch_default";
	const result = await db.execute({
		sql: "SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants WHERE id = ?",
		args: [merchantId],
	});

	return c.json(
		{
			success: true as const,
			data: result.rows.map((row) => ({
				id: row.id as string,
				name: row.name as string,
				default_callback_url: row.default_callback_url as string | null,
				active: Boolean(row.active),
				plan: row.plan as string,
				created_at: row.created_at as string,
				updated_at: row.updated_at as string,
			})),
		},
		200,
	);
});

// ── GET /api/merchants/:id ──────────────────────────────────────

const getMerchantRoute = createRoute({
	method: "get",
	path: "/merchants/{id}",
	tags: ["Merchants"],
	summary: "Get merchant details",
	description: "Returns merchant account details by ID.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({ id: z.string().openapi({ example: "merch_abc123" }) }),
	},
	responses: {
		200: {
			description: "Merchant found.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: merchantResponseSchema,
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

accountsRouter.openapi(getMerchantRoute, async (c) => {
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

	const result = await db.execute({
		sql: "SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants WHERE id = ?",
		args: [id],
	});

	if (result.rows.length === 0) {
		return c.json(
			{
				success: false as const,
				error: { code: "NOT_FOUND", message: `Merchant not found: ${id}` },
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
				name: row.name as string,
				default_callback_url: row.default_callback_url as string | null,
				active: Boolean(row.active),
				plan: row.plan as string,
				created_at: row.created_at as string,
				updated_at: row.updated_at as string,
			},
		},
		200,
	);
});

// ── PATCH /api/merchants/:id ────────────────────────────────────

const updateMerchantRoute = createRoute({
	method: "patch",
	path: "/merchants/{id}",
	tags: ["Merchants"],
	summary: "Update merchant",
	description:
		"Updates merchant name or callback URL. Plan and active changes are admin-only.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({ id: z.string().openapi({ example: "merch_abc123" }) }),
		body: {
			content: { "application/json": { schema: updateMerchantBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Merchant updated.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: merchantResponseSchema,
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

accountsRouter.openapi(updateMerchantRoute, async (c) => {
	const { id } = c.req.valid("param");
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

	// Check exists
	const existing = await db.execute({
		sql: "SELECT id FROM merchants WHERE id = ?",
		args: [id],
	});
	if (existing.rows.length === 0) {
		return c.json(
			{
				success: false as const,
				error: { code: "NOT_FOUND", message: `Merchant not found: ${id}` },
			},
			404,
		);
	}

	const updates: string[] = ["updated_at = datetime('now')"];
	const args: Array<string | number | null> = [];

	if (body.name !== undefined) {
		updates.push("name = ?");
		args.push(body.name);
	}
	if (body.default_callback_url !== undefined) {
		updates.push("default_callback_url = ?");
		args.push(body.default_callback_url);
	}

	args.push(id);
	await db.execute({
		sql: `UPDATE merchants SET ${updates.join(", ")} WHERE id = ?`,
		args,
	});

	logger.info("Merchant updated", { id });

	// Re-read
	const result = await db.execute({
		sql: "SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants WHERE id = ?",
		args: [id],
	});
	const row = result.rows[0];

	return c.json(
		{
			success: true as const,
			data: {
				id: row.id as string,
				name: row.name as string,
				default_callback_url: row.default_callback_url as string | null,
				active: Boolean(row.active),
				plan: row.plan as string,
				created_at: row.created_at as string,
				updated_at: row.updated_at as string,
			},
		},
		200,
	);
});

// ── POST /api/merchants/:id/api-key ─────────────────────────────

const rotateKeyRoute = createRoute({
	method: "post",
	path: "/merchants/{id}/api-key",
	tags: ["Merchants"],
	summary: "Rotate API key",
	description:
		"Generates a new API key for the merchant. The old key is immediately invalidated. New key shown ONCE.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({ id: z.string().openapi({ example: "merch_abc123" }) }),
	},
	responses: {
		200: {
			description: "API key rotated.",
			content: { "application/json": { schema: rotateKeyResponseSchema } },
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

accountsRouter.openapi(rotateKeyRoute, async (c) => {
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

	const existing = await db.execute({
		sql: "SELECT id FROM merchants WHERE id = ?",
		args: [id],
	});
	if (existing.rows.length === 0) {
		return c.json(
			{
				success: false as const,
				error: { code: "NOT_FOUND", message: `Merchant not found: ${id}` },
			},
			404,
		);
	}

	const newApiKey = generateApiKey();
	const newHash = sha256Hash(newApiKey);

	await db.execute({
		sql: "UPDATE merchants SET api_key_hash = ?, updated_at = datetime('now') WHERE id = ?",
		args: [newHash, id],
	});

	logger.info("Merchant API key rotated", { id });

	return c.json(
		{
			success: true as const,
			data: {
				merchant_id: id,
				api_key: newApiKey,
			},
		},
		200,
	);
});
