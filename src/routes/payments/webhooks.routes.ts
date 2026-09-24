// Webhook delivery log + dead-letter replay.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../../config/database";
import { authMiddleware } from "../../middleware/auth";
import {
	errorsCounter,
	paymentCreationDuration,
	paymentsCreatedCounter,
} from "../../middleware/metrics";
import {
	createPaymentBodySchema,
	defaultHook,
	errorSchema,
	gatewayInfoSchema,
	gatewayNameSchema,
	orderResponseSchema,
	orderToResponse,
	transactionResponseSchema,
	webhookDeliverySchema,
} from "../../schemas";
import { replayDeadLetter } from "../../services/forwarder.service";
import {
	getAvailableGateways,
	getGateway,
	getGatewayMethods,
} from "../../services/gateway.service";
import {
	type CreateOrderParams,
	type Order,
	createOrder,
	getOrderById,
	getOrderByIdempotencyKey,
	listOrders,
	updateOrderStatus,
} from "../../services/order.service";
import { DuplicateOrderError, GatewayError } from "../../utils/errors";
import { logger } from "../../utils/logger";

type MerchantEnv = {
	Variables: { merchantId?: string; merchantName?: string };
};
export const webhooksRouter = new OpenAPIHono<MerchantEnv>({ defaultHook });

webhooksRouter.use("/*", authMiddleware);
// ── GET /api/webhook-deliveries ────────────────────────────────

const listWebhookDeliveriesRoute = createRoute({
	method: "get",
	path: "/webhook-deliveries",
	tags: ["Webhooks"],
	summary: "List webhook deliveries",
	description: "Returns webhook delivery log for the authenticated merchant.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		query: z.object({
			order_id: z.string().optional().openapi({ example: "pay_abc123" }),
			limit: z.coerce
				.number()
				.int()
				.min(1)
				.max(100)
				.default(20)
				.openapi({ example: 20 }),
			offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
		}),
	},
	responses: {
		200: {
			description: "Webhook delivery list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							deliveries: z.array(webhookDeliverySchema),
							total: z.number(),
						}),
					}),
				},
			},
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Internal error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

webhooksRouter.openapi(listWebhookDeliveriesRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	const query = c.req.valid("query");

	try {
		const db = getDb();
		const conditions = ["o.merchant_id = ?"];
		const args: Array<string | number> = [merchantId];

		if (query.order_id) {
			conditions.push("we.order_id = ?");
			args.push(query.order_id);
		}

		const where = conditions.join(" AND ");
		const limit = Math.min(query.limit, 100);

		const countResult = await db.execute({
			sql: `SELECT COUNT(*) as count FROM webhook_events we JOIN orders o ON we.order_id = o.id WHERE ${where}`,
			args,
		});
		const total = Number(
			(countResult.rows[0] as Record<string, unknown>).count,
		);

		const result = await db.execute({
			sql: `SELECT we.* FROM webhook_events we JOIN orders o ON we.order_id = o.id WHERE ${where} ORDER BY we.created_at DESC LIMIT ? OFFSET ?`,
			args: [...args, limit, query.offset],
		});

		return c.json(
			{
				success: true as const,
				data: {
					deliveries: result.rows.map((row) => ({
						id: row.id as string,
						gateway: row.gateway as string,
						order_id: row.order_id as string | null,
						status: row.status as string | null,
						signature_valid: Number(row.signature_valid),
						created_at: row.created_at as string,
					})),
					total,
				},
			},
			200,
		);
	} catch (err: unknown) {
		logger.error("Error listing webhook deliveries", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false as const,
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to list webhook deliveries",
				},
			},
			500,
		);
	}
});

// ── POST /api/webhook-deliveries/{id}/replay ────────────────────

const replayWebhookDeliveryRoute = createRoute({
	method: "post",
	path: "/webhook-deliveries/{id}/replay",
	tags: ["Webhooks"],
	summary: "Replay a dead-lettered webhook delivery",
	description:
		"Re-forwards a previously failed webhook delivery to the owning project, " +
		"using the stored event and the merchant's webhook secret. Only the " +
		"merchant that owns the order may replay a delivery.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({
			id: z.string().openapi({ example: "dl_abc123" }),
		}),
	},
	responses: {
		200: {
			description: "Delivery re-forwarded.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							id: z.string(),
							replayed_at: z.string().nullable(),
						}),
					}),
				},
			},
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		404: {
			description: "Dead letter or owning order not found.",
			content: { "application/json": { schema: errorSchema } },
		},
		502: {
			description: "Replay failed at the forwarding step.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Internal error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

webhooksRouter.openapi(replayWebhookDeliveryRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	const { id } = c.req.valid("param");

	try {
		const db = getDb();
		const result = await db.execute({
			sql: "SELECT order_id FROM dead_letter_events WHERE id = ?",
			args: [id],
		});
		if (result.rows.length === 0) {
			return c.json(
				{
					success: false as const,
					error: { code: "NOT_FOUND", message: "Dead letter not found" },
				},
				404,
			);
		}

		const orderId = String(
			(result.rows[0] as Record<string, unknown>).order_id ?? "",
		);
		const order = await getOrderById(orderId);
		if (
			!order ||
			(order.merchant_id !== merchantId && order.project_id !== merchantId)
		) {
			return c.json(
				{
					success: false as const,
					error: { code: "NOT_FOUND", message: "Dead letter not found" },
				},
				404,
			);
		}

		const replay = await replayDeadLetter(id, merchantId);
		if (!replay.ok) {
			// Internal detail (DB/forward/secret state) stays in ops log; never leak to caller.
			logger.warn("Dead letter replay failed", {
				id,
				merchant_id: merchantId,
				error: replay.error,
			});
			return c.json(
				{
					success: false as const,
					error: {
						code: "REPLAY_FAILED",
						message: "Replay failed, please retry or contact support",
					},
				},
				502,
			);
		}

		const after = await db.execute({
			sql: "SELECT replayed_at FROM dead_letter_events WHERE id = ?",
			args: [id],
		});
		const replayedAt =
			after.rows.length > 0
				? (((after.rows[0] as Record<string, unknown>).replayed_at as
						| string
						| null) ?? null)
				: null;

		return c.json(
			{
				success: true as const,
				data: { id, replayed_at: replayedAt },
			},
			200,
		);
	} catch (err: unknown) {
		logger.error("Error replaying webhook delivery", {
			id,
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false as const,
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to replay delivery",
				},
			},
			500,
		);
	}
});
