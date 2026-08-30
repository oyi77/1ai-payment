/**
 * Saved payment methods — merchant-scoped vault for reusable gateway tokens.
 * GET/POST /api/saved-methods
 * GET/DELETE /api/saved-methods/:methodId
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { authMiddleware } from "../middleware/auth";
import {
	createSavedMethodBodySchema,
	defaultHook,
	errorSchema,
	savedMethodIdParamsSchema,
	savedMethodToResponse,
	savedMethodsListSchema,
	savedPaymentMethodSchema,
} from "../schemas";
import {
	createSavedMethod,
	deleteSavedMethod,
	getSavedMethodById,
	listSavedMethods,
} from "../services/saved-methods.service";
import { NotFoundError } from "../utils/errors";

type MerchantEnv = {
	Variables: { merchantId: string; merchantName?: string };
};
const router = new OpenAPIHono<MerchantEnv>({ defaultHook });

router.use("*", authMiddleware);

// List saved methods
router.openapi(
	createRoute({
		method: "get",
		path: "/saved-methods",
		responses: {
			200: {
				description: "List of saved payment methods for the merchant",
				content: {
					"application/json": {
						schema: savedMethodsListSchema,
					},
				},
			},
		},
		tags: ["Saved Methods"],
		summary: "List saved payment methods",
	}),
	async (c) => {
		const merchantId = c.get("merchantId") ?? "merch_default";
		const methods = await listSavedMethods(merchantId);
		return c.json(methods.map(savedMethodToResponse));
	},
);

// Save a new payment method
router.openapi(
	createRoute({
		method: "post",
		path: "/saved-methods",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createSavedMethodBodySchema,
					},
				},
			},
		},
		responses: {
			201: {
				description:
					"Saved payment method created or existing returned (idempotent)",
				content: {
					"application/json": {
						schema: z.object({
							success: z.literal(true),
							data: savedPaymentMethodSchema,
						}),
					},
				},
			},
			409: {
				description: "Duplicate saved method (concurrent race)",
				content: { "application/json": { schema: errorSchema } },
			},
		},
		tags: ["Saved Methods"],
		summary: "Save a payment method",
	}),
	async (c) => {
		const merchantId = c.get("merchantId") ?? "merch_default";
		const body = c.req.valid("json");
		const method = await createSavedMethod(merchantId, body);
		return c.json(
			{ success: true as const, data: savedMethodToResponse(method) },
			201,
		);
	},
);

// Get a single saved method
router.openapi(
	createRoute({
		method: "get",
		path: "/saved-methods/{methodId}",
		request: {
			params: savedMethodIdParamsSchema,
		},
		responses: {
			200: {
				description: "Saved payment method details",
				content: {
					"application/json": {
						schema: z.object({
							success: z.literal(true),
							data: savedPaymentMethodSchema,
						}),
					},
				},
			},
			404: {
				description: "Saved method not found",
				content: { "application/json": { schema: errorSchema } },
			},
		},
		tags: ["Saved Methods"],
		summary: "Get a saved payment method",
	}),
	async (c) => {
		const merchantId = c.get("merchantId") ?? "merch_default";
		const { methodId } = c.req.valid("param");
		const method = await getSavedMethodById(merchantId, methodId);
		if (!method) {
			return c.json(
				{
					success: false as const,
					error: {
						code: "NOT_FOUND",
						message: `Saved payment method not found: ${methodId}`,
					},
				},
				404,
			);
		}
		return c.json(
			{ success: true as const, data: savedMethodToResponse(method) },
			200,
		);
	},
);

// Delete a saved method
router.openapi(
	createRoute({
		method: "delete",
		path: "/saved-methods/{methodId}",
		request: {
			params: savedMethodIdParamsSchema,
		},
		responses: {
			204: {
				description: "Saved payment method deleted",
			},
			404: {
				description: "Saved method not found",
				content: { "application/json": { schema: errorSchema } },
			},
		},
		tags: ["Saved Methods"],
		summary: "Delete a saved payment method",
	}),
	async (c) => {
		const merchantId = c.get("merchantId") ?? "merch_default";
		const { methodId } = c.req.valid("param");
		const deleted = await deleteSavedMethod(merchantId, methodId);
		if (deleted === 0) {
			return c.json(
				{
					success: false as const,
					error: {
						code: "NOT_FOUND",
						message: `Saved payment method not found: ${methodId}`,
					},
				},
				404,
			);
		}
		return c.body(null, 204);
	},
);

export { router as savedMethodsRouter };
