/**
 * Refund routes — create and list refunds.
 *
 * - POST /api/refunds — create refund
 * - GET  /api/refunds — list refunds for merchant
 *
 * All endpoints require API key authentication.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authMiddleware } from "../middleware/auth";
import {
	createRefundBodySchema,
	defaultHook,
	errorSchema,
	refundResponseSchema,
} from "../schemas";
import {
	createRefund,
	getRefundById,
	listRefunds,
} from "../services/refund.service";
import { GatewayError } from "../utils/errors";
import { logger } from "../utils/logger";

type MerchantEnv = {
	Variables: { merchantId?: string; merchantName?: string };
};
export const refundRoutes = new OpenAPIHono<MerchantEnv>({ defaultHook });

refundRoutes.use("/*", authMiddleware);

// ── POST /api/refunds ──────────────────────────────────────────

const createRefundRoute = createRoute({
	method: "post",
	path: "/refunds",
	tags: ["Refunds"],
	summary: "Create a refund",
	description:
		"Refunds a successful payment. Partial refund supported. Gateway must support refunds or refund is marked pending for manual processing.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		body: {
			content: { "application/json": { schema: createRefundBodySchema } },
		},
	},
	responses: {
		201: {
			description: "Refund created.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: refundResponseSchema,
					}),
				},
			},
		},
		400: {
			description: "Invalid request.",
			content: { "application/json": { schema: errorSchema } },
		},
		401: {
			description: "Unauthorized.",
			content: { "application/json": { schema: errorSchema } },
		},
		404: {
			description: "Order not found.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

refundRoutes.openapi(createRefundRoute, async (c) => {
	const body = c.req.valid("json");
	const merchantId = c.get("merchantId") ?? "merch_default";

	try {
		const refund = await createRefund({
			order_id: body.order_id,
			merchant_id: merchantId,
			amount: body.amount,
			reason: body.reason,
		});

		return c.json({ success: true as const, data: refund }, 201);
	} catch (err: unknown) {
		if (err instanceof GatewayError) {
			const statusCode = err.message.includes("not found") ? 404 : 400;
			return c.json(
				{
					success: false as const,
					error: { code: err.code || "REFUND_ERROR", message: err.message },
				},
				statusCode as 400 | 404,
			);
		}
		throw err;
	}
});

// ── GET /api/refunds ───────────────────────────────────────────

const listRefundsRoute = createRoute({
	method: "get",
	path: "/refunds",
	tags: ["Refunds"],
	summary: "List refunds",
	description: "Returns refunds for the authenticated merchant.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		query: z.object({
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
			description: "Refund list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							refunds: z.array(refundResponseSchema),
							total: z.number(),
							limit: z.number(),
							offset: z.number(),
						}),
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

refundRoutes.openapi(listRefundsRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	const { limit, offset } = c.req.valid("query");

	const result = await listRefunds(merchantId, limit, offset);

	return c.json(
		{
			success: true as const,
			data: {
				refunds: result.refunds,
				total: result.total,
				limit,
				offset,
			},
		},
		200,
	);
});
