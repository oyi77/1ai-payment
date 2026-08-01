/**
 * Admin routes — merchant management.
 *
 * - GET   /api/admin/merchants — list all merchants
 * - PATCH /api/admin/merchants/:id — update merchant plan / active status
 *
 * All routes protected by adminAuthMiddleware (X-Admin-Key header).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { getDb } from "../config/database";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { adminMerchantUpdateBodySchema } from "../schemas";
import { logger } from "../utils/logger";

export const adminRoutes = new OpenAPIHono();

// Apply admin auth to all admin routes
adminRoutes.use("*", adminAuthMiddleware());

adminRoutes.get("/admin/merchants", async (c) => {
	const db = getDb();

	try {
		const result = await db.execute(
			"SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants ORDER BY created_at DESC",
		);

		const merchants = result.rows.map((row) => ({
			id: row.id as string,
			name: row.name as string,
			default_callback_url: row.default_callback_url as string | null,
			active: Boolean(row.active),
			plan: row.plan as string,
			created_at: row.created_at as string,
			updated_at: row.updated_at as string,
		}));

		return c.json({ success: true, data: { merchants } });
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

adminRoutes.patch("/admin/merchants/{id}", async (c) => {
	const db = getDb();
	const id = c.req.param("id") ?? "";

	const parseResult = adminMerchantUpdateBodySchema.safeParse(
		await c.req.json().catch(() => undefined),
	);
	if (!parseResult.success) {
		return c.json(
			{
				success: false,
				error: { code: "INVALID_BODY", message: "Invalid request body" },
			},
			400,
		);
	}
	const body = parseResult.data;

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

		return c.json({
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
		});
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
