/**
 * Admin routes — merchant management.
 *
 * - GET   /api/admin/merchants — list all merchants
 * - PATCH /api/admin/merchants/:id — update merchant plan / active status
 * - POST  /api/admin/merchants/:id/api-key — reset a merchant's API key
 *   (account recovery for lost keys: rotate requires the CURRENT key, so
 *   admins need this escape hatch). Returns the new key once.
 *
 * All routes protected by adminAuthMiddleware (X-Admin-Key header) and
 * declared via .openapi(createRoute) so they appear in GET /doc.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../config/database";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import {
	adminMerchantUpdateBodySchema,
	defaultHook,
	errorSchema,
	merchantResponseSchema,
} from "../schemas";
import { generateApiKey, sha256Hash } from "../utils/crypto";
import { logger } from "../utils/logger";

type AdminEnv = {
	Variables: Record<string, string>;
};
export const adminRoutes = new OpenAPIHono<AdminEnv>({ defaultHook });

// Apply admin auth to all admin routes
adminRoutes.use("*", adminAuthMiddleware());

const adminSecurity = [{ AdminKeyAuth: [] }];
const merchantIdParam = z.object({
	id: z.string().openapi({ example: "merch_abc123" }),
});
const merchantDataSchema = z.object({
	success: z.literal(true),
	data: z.object({
		merchant: merchantResponseSchema,
	}),
});
const unauthorizedResponse = {
	description: "Unauthorized.",
	content: { "application/json": { schema: errorSchema } },
} as const;
const notFoundResponse = {
	description: "Merchant not found.",
	content: { "application/json": { schema: errorSchema } },
} as const;
const serverErrorResponse = {
	description: "Internal server error.",
	content: { "application/json": { schema: errorSchema } },
} as const;

// ── GET /api/admin/merchants ──────────────────────────────────────

const listMerchantsRoute = createRoute({
	method: "get",
	path: "/admin/merchants",
	tags: ["Admin"],
	summary: "List all merchants",
	description:
		"Returns every merchant account (admin only, X-Admin-Key). No API keys — hashes only.",
	security: adminSecurity,
	request: {
		query: z.object({
			limit: z.coerce
				.number()
				.int()
				.min(1)
				.max(100)
				.default(100)
				.openapi({ example: 100 }),
			offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
		}),
	},
	responses: {
		200: {
			description: "Merchant list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							merchants: z.array(merchantResponseSchema),
							total: z.number().openapi({ example: 17 }),
						}),
					}),
				},
			},
		},
		401: unauthorizedResponse,
		500: serverErrorResponse,
	},
});

adminRoutes.openapi(listMerchantsRoute, async (c) => {
	const db = getDb();
	const query = c.req.valid("query");

	try {
		const totalResult = await db.execute(
			"SELECT COUNT(*) as count FROM merchants",
		);
		const total = Number(
			(totalResult.rows[0] as Record<string, unknown>).count ?? 0,
		);
		const result = await db.execute({
			sql: "SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants ORDER BY created_at DESC LIMIT ? OFFSET ?",
			args: [query.limit, query.offset],
		});

		const merchants = result.rows.map((row) => ({
			id: row.id as string,
			name: row.name as string,
			default_callback_url: row.default_callback_url as string | null,
			active: Boolean(row.active),
			plan: row.plan as string,
			created_at: row.created_at as string,
			updated_at: row.updated_at as string,
		}));

		return c.json({ success: true, data: { merchants, total } }, 200);
	} catch (err) {
		logger.error("Failed to list merchants", { error: err });
		return c.json(
			{
				success: false,
				error: { code: "INTERNAL_ERROR", message: "Failed to list merchants" },
			},
			500,
		);
	}
});

// ── PATCH /api/admin/merchants/:id ───────────────────────────────

const updateMerchantRoute = createRoute({
	method: "patch",
	path: "/admin/merchants/{id}",
	tags: ["Admin"],
	summary: "Update merchant plan / active status",
	description: "Admin-only plan and active-state update (X-Admin-Key).",
	security: adminSecurity,
	request: {
		params: merchantIdParam,
		body: {
			content: {
				"application/json": { schema: adminMerchantUpdateBodySchema },
			},
		},
	},
	responses: {
		200: {
			description: "Merchant updated.",
			content: {
				"application/json": { schema: merchantDataSchema },
			},
		},
		400: {
			description: "Invalid request body.",
			content: { "application/json": { schema: errorSchema } },
		},
		401: unauthorizedResponse,
		404: notFoundResponse,
		500: serverErrorResponse,
	},
});

adminRoutes.openapi(updateMerchantRoute, async (c) => {
	const db = getDb();
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");

	try {
		const existing = await db.execute({
			sql: "SELECT id FROM merchants WHERE id = ?",
			args: [id],
		});
		if (existing.rows.length === 0) {
			return c.json(
				{
					success: false,
					error: { code: "NOT_FOUND", message: `Merchant not found: ${id}` },
				},
				404,
			);
		}

		const updates: string[] = ["updated_at = datetime('now')"];
		const args: Array<string | number | null> = [];

		if (body.plan !== undefined) {
			updates.push("plan = ?");
			args.push(body.plan);
		}
		if (body.active !== undefined) {
			updates.push("active = ?");
			args.push(body.active ? 1 : 0);
		}

		args.push(id);
		await db.execute({
			sql: `UPDATE merchants SET ${updates.join(", ")} WHERE id = ?`,
			args,
		});

		logger.info("Admin updated merchant", { merchant_id: id });

		const result = await db.execute({
			sql: "SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants WHERE id = ?",
			args: [id],
		});
		const row = result.rows[0];

		return c.json(
			{
				success: true,
				data: {
					merchant: {
						id: row.id as string,
						name: row.name as string,
						default_callback_url: row.default_callback_url as string | null,
						active: Boolean(row.active),
						plan: row.plan as string,
						created_at: row.created_at as string,
						updated_at: row.updated_at as string,
					},
				},
			},
			200,
		);
	} catch (err) {
		logger.error("Failed to update merchant", { merchant_id: id, error: err });
		return c.json(
			{
				success: false,
				error: { code: "INTERNAL_ERROR", message: "Failed to update merchant" },
			},
			500,
		);
	}
});

// ── POST /api/admin/merchants/:id/api-key (recovery reset) ───────

const resetKeyRoute = createRoute({
	method: "post",
	path: "/admin/merchants/{id}/api-key",
	tags: ["Admin"],
	summary: "Reset a merchant API key (recovery)",
	description:
		"Admin-only recovery reset for lost keys (X-Admin-Key). Returns the new key once.",
	security: adminSecurity,
	request: {
		params: merchantIdParam,
	},
	responses: {
		200: {
			description: "New API key (shown once).",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							merchant_id: z.string().openapi({ example: "merch_abc123" }),
							api_key: z.string().openapi({
								description: "New API key — shown ONCE, store it securely",
								example: "1pay_xyz789...",
							}),
						}),
					}),
				},
			},
		},
		401: unauthorizedResponse,
		404: notFoundResponse,
		500: serverErrorResponse,
	},
});

adminRoutes.openapi(resetKeyRoute, async (c) => {
	const db = getDb();
	const { id } = c.req.valid("param");

	try {
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

		const apiKey = generateApiKey();
		const apiKeyHash = sha256Hash(apiKey);
		await db.execute({
			sql: "UPDATE merchants SET api_key_hash = ?, updated_at = datetime('now') WHERE id = ?",
			args: [apiKeyHash, id],
		});

		logger.info("Admin reset merchant API key", { merchant_id: id });
		return c.json(
			{
				success: true as const,
				data: { merchant_id: id, api_key: apiKey },
			},
			200,
		);
	} catch (err) {
		logger.error("Failed to reset merchant API key", {
			merchant_id: id,
			error: err,
		});
		return c.json(
			{
				success: false as const,
				error: { code: "INTERNAL_ERROR", message: "Failed to reset API key" },
			},
			500,
		);
	}
});
