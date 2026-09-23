// Transaction history endpoint.

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
export const transactionsRouter = new OpenAPIHono<MerchantEnv>({ defaultHook });

transactionsRouter.use("/*", authMiddleware);
// ── GET /api/transactions ──────────────────────────────────────

const listTransactionsRoute = createRoute({
	method: "get",
	path: "/transactions",
	tags: ["Transactions"],
	summary: "List transactions",
	description:
		"Returns transaction history for the authenticated merchant with filters.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		query: z.object({
			status: z.string().optional().openapi({ example: "success" }),
			gateway: z.string().optional().openapi({ example: "midtrans" }),
			from: z
				.string()
				.optional()
				.openapi({ description: "ISO date string", example: "2026-01-01" }),
			to: z
				.string()
				.optional()
				.openapi({ description: "ISO date string", example: "2026-12-31" }),
			limit: z.coerce
				.number()
				.int()
				.min(1)
				.max(100)
				.default(50)
				.openapi({ example: 50 }),
			offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
		}),
	},
	responses: {
		200: {
			description: "Transaction list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							transactions: z.array(transactionResponseSchema),
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
		500: {
			description: "Internal error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

transactionsRouter.openapi(listTransactionsRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	const query = c.req.valid("query");

	try {
		const result = await listOrders({
			merchant_id: merchantId,
			gateway: query.gateway,
			status: query.status,
			from: query.from,
			to: query.to,
			limit: query.limit,
			offset: query.offset,
		});

		return c.json(
			{
				success: true as const,
				data: {
					transactions: result.orders.map((o) => ({
						id: o.id,
						gateway: o.gateway,
						gateway_reference: o.gateway_reference,
						status: o.status,
						amount: o.amount,
						currency: o.currency,
						payment_method: o.payment_method,
						fee: o.fee,
						net: o.net,
						created_at: o.created_at,
					})),
					total: result.total,
					limit: query.limit,
					offset: query.offset,
				},
			},
			200,
		);
	} catch (err: unknown) {
		logger.error("Error listing transactions", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false as const,
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to list transactions",
				},
			},
			500,
		);
	}
});
