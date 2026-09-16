// Gateway catalog endpoints.

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
export const gatewaysRouter = new OpenAPIHono<MerchantEnv>({ defaultHook });

gatewaysRouter.use("/*", authMiddleware);
// ── GET /api/gateways ──────────────────────────────────────────

const listGatewaysRoute = createRoute({
	method: "get",
	path: "/gateways",
	tags: ["Gateways"],
	summary: "List available gateways",
	description:
		"Returns all registered gateways with their configuration status, currencies, and payment methods.",
	security: [{ ApiKeyAuth: [] }],
	responses: {
		200: {
			description: "Gateway list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.array(gatewayInfoSchema),
					}),
				},
			},
		},
		401: {
			description: "Missing or invalid API key.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Unexpected server error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

gatewaysRouter.openapi(listGatewaysRoute, async (c) => {
	try {
		const gateways = getAvailableGateways();
		return c.json({ success: true as const, data: gateways }, 200);
	} catch (err: unknown) {
		logger.error("Error listing gateways", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false as const,
				error: { code: "INTERNAL_ERROR", message: "Failed to list gateways" },
			},
			500,
		);
	}
});

// ── GET /api/gateways/:gateway/methods ─────────────────────────

const getGatewayMethodsRoute = createRoute({
	method: "get",
	path: "/gateways/{gateway}/methods",
	tags: ["Gateways"],
	summary: "List payment methods for a gateway",
	description:
		"Returns all payment method codes, names, and supported currencies for the specified gateway.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		params: z.object({ gateway: gatewayNameSchema }),
	},
	responses: {
		200: {
			description: "Gateway methods.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: gatewayInfoSchema,
					}),
				},
			},
		},
		401: {
			description: "Missing or invalid API key.",
			content: { "application/json": { schema: errorSchema } },
		},
		404: {
			description: "Gateway not found.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Unexpected server error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

gatewaysRouter.openapi(getGatewayMethodsRoute, async (c) => {
	const { gateway } = c.req.valid("param");

	try {
		const info = getGatewayMethods(gateway);
		if (!info) {
			return c.json(
				{
					success: false as const,
					error: {
						code: "GATEWAY_NOT_FOUND",
						message: `Gateway not found: ${gateway}`,
					},
				},
				404,
			);
		}
		return c.json({ success: true as const, data: info }, 200);
	} catch (err: unknown) {
		logger.error("Error fetching gateway methods", {
			gateway,
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false as const,
				error: { code: "INTERNAL_ERROR", message: "Failed to fetch methods" },
			},
			500,
		);
	}
});
