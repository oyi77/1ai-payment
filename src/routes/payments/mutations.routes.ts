// Mutation pull API — merchant-scoped bank-mutation fetch.
//
// Aggregator gateways (Mutasiku / Moota) are read-only: the operator
// connects accounts inside the aggregator dashboard, then the project
// can pull mutations on demand via this route. The merchant's stored
// API key (in merchant_gateways) is used — the project never sees it.
//
// POST /api/mutasiku/mutations  → pull from Mutasiku
// POST /api/moota/mutations      → pull from Moota (requires account_id)
//
// Body shape varies per aggregator; see the OpenAPI schemas below.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { resolveGatewayConfig } from "../../config/env";
import {
	listAccounts as listMootaAccounts,
	pullMutations as pullMoota,
} from "../../gateways/moota";
import {
	listAccounts as listMutasikuAccounts,
	pullMutations as pullMutasiku,
} from "../../gateways/mutasiku";
import { authMiddleware } from "../../middleware/auth";
import { defaultHook, errorSchema } from "../../schemas";
import { GatewayError } from "../../utils/errors";
import { logger } from "../../utils/logger";

type MerchantEnv = {
	Variables: { merchantId?: string; merchantName?: string };
};

export const mutationsRouter = new OpenAPIHono<MerchantEnv>({ defaultHook });
mutationsRouter.use("/*", authMiddleware);

// ── Mutasiku: list accounts ──────────────────────────────────────

const mutasikuAccountsRoute = createRoute({
	method: "get",
	path: "/mutasiku/accounts",
	tags: ["Mutations"],
	summary: "List Mutasiku connected accounts",
	description:
		"Returns bank/e-wallet accounts connected in the Mutasiku dashboard. " +
		"Uses the merchant's stored Mutasiku API key.",
	security: [{ ApiKeyAuth: [] }],
	responses: {
		200: {
			description: "Connected accounts list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.array(z.record(z.string(), z.unknown())),
					}),
				},
			},
		},
		401: {
			description: "Missing or invalid API key.",
			content: { "application/json": { schema: errorSchema } },
		},
		422: {
			description: "Mutasiku API key not configured or invalid.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Unexpected error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

mutationsRouter.openapi(mutasikuAccountsRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	try {
		const cfg = (await resolveGatewayConfig("mutasiku", merchantId)) as {
			apiKey?: string;
		};
		if (!cfg.apiKey) {
			return c.json(
				{
					success: false,
					error: {
						code: "MUTASIKU_NOT_CONFIGURED",
						message: "Mutasiku API key not set for this merchant",
					},
				},
				422,
			);
		}
		const accounts = (await listMutasikuAccounts(cfg.apiKey)) as Record<
			string,
			unknown
		>[];
		return c.json({ success: true, data: accounts }, 200);
	} catch (err: unknown) {
		if (err instanceof GatewayError) {
			return c.json(
				{
					success: false,
					error: { code: "GATEWAY_ERROR", message: err.message },
				},
				422,
			);
		}
		logger.error("Mutasiku accounts route error", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false,
				error: { code: "INTERNAL", message: "Unexpected error" },
			},
			500,
		);
	}
});

// ── Mutasiku: pull mutations ─────────────────────────────────────

const mutasikuPullRoute = createRoute({
	method: "post",
	path: "/mutasiku/mutations",
	tags: ["Mutations"],
	summary: "Pull mutations from Mutasiku",
	description:
		"Fetches bank mutations from Mutasiku REST API using the merchant's " +
		"stored API key. Date range defaults to yesterday→today if omitted.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z
						.object({
							startDate: z.string().optional().openapi({
								example: "2026-01-01",
								description: "ISO date (YYYY-MM-DD). Defaults to yesterday.",
							}),
							endDate: z.string().optional().openapi({
								example: "2026-01-15",
								description: "ISO date (YYYY-MM-DD). Defaults to today.",
							}),
							accountId: z
								.string()
								.optional()
								.openapi({ description: "Filter to one connected account." }),
							page: z
								.number()
								.int()
								.positive()
								.optional()
								.openapi({ default: 1 }),
							limit: z
								.number()
								.int()
								.positive()
								.max(100)
								.optional()
								.openapi({ default: 100 }),
						})
						.openapi("MutasikuPullBody"),
				},
			},
		},
	},
	responses: {
		200: {
			description: "Mutations fetched.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							mutations: z.array(z.record(z.string(), z.unknown())),
							hasMore: z.boolean(),
						}),
					}),
				},
			},
		},
		401: {
			description: "Missing or invalid API key.",
			content: { "application/json": { schema: errorSchema } },
		},
		422: {
			description: "Mutasiku API key not configured or upstream error.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Unexpected error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

mutationsRouter.openapi(mutasikuPullRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	const body = c.req.valid("json");
	try {
		const cfg = (await resolveGatewayConfig("mutasiku", merchantId)) as {
			apiKey?: string;
		};
		if (!cfg.apiKey) {
			return c.json(
				{
					success: false,
					error: {
						code: "MUTASIKU_NOT_CONFIGURED",
						message: "Mutasiku API key not set for this merchant",
					},
				},
				422,
			);
		}
		const result = await pullMutasiku({
			apiKey: cfg.apiKey,
			startDate: body.startDate,
			endDate: body.endDate,
			accountId: body.accountId,
			page: body.page ?? 1,
			limit: body.limit ?? 100,
		});
		return c.json({ success: true, data: result }, 200);
	} catch (err: unknown) {
		if (err instanceof GatewayError) {
			return c.json(
				{
					success: false,
					error: { code: "GATEWAY_ERROR", message: err.message },
				},
				422,
			);
		}
		logger.error("Mutasiku pull route error", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false,
				error: { code: "INTERNAL", message: "Unexpected error" },
			},
			500,
		);
	}
});

// ── Moota: list accounts ─────────────────────────────────────────

const mootaAccountsRoute = createRoute({
	method: "get",
	path: "/moota/accounts",
	tags: ["Mutations"],
	summary: "List Moota connected bank accounts",
	description:
		"Returns bank accounts connected in the Moota dashboard. " +
		"Uses the merchant's stored Moota API token.",
	security: [{ ApiKeyAuth: [] }],
	responses: {
		200: {
			description: "Connected accounts list.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.array(z.record(z.string(), z.unknown())),
					}),
				},
			},
		},
		401: {
			description: "Missing or invalid API key.",
			content: { "application/json": { schema: errorSchema } },
		},
		422: {
			description: "Moota API token not configured or invalid.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Unexpected error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

mutationsRouter.openapi(mootaAccountsRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	try {
		const cfg = (await resolveGatewayConfig("moota", merchantId)) as {
			apiKey?: string;
		};
		if (!cfg.apiKey) {
			return c.json(
				{
					success: false,
					error: {
						code: "MOOTA_NOT_CONFIGURED",
						message: "Moota API token not set for this merchant",
					},
				},
				422,
			);
		}
		const accounts = (await listMootaAccounts(cfg.apiKey)) as Record<
			string,
			unknown
		>[];
		return c.json({ success: true, data: accounts }, 200);
	} catch (err: unknown) {
		if (err instanceof GatewayError) {
			return c.json(
				{
					success: false,
					error: { code: "GATEWAY_ERROR", message: err.message },
				},
				422,
			);
		}
		logger.error("Moota accounts route error", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false,
				error: { code: "INTERNAL", message: "Unexpected error" },
			},
			500,
		);
	}
});

// ── Moota: pull mutations ────────────────────────────────────────

const mootaPullRoute = createRoute({
	method: "post",
	path: "/moota/mutations",
	tags: ["Mutations"],
	summary: "Pull mutations from Moota",
	description:
		"Fetches bank mutations from Moota REST API for one bank account. " +
		"Moota requires a bank_id (accountId) — there is no global list.",
	security: [{ ApiKeyAuth: [] }],
	request: {
		body: {
			content: {
				"application/json": {
					schema: z
						.object({
							accountId: z.string().openapi({
								description: "Moota bank_id (from /moota/accounts).",
							}),
						})
						.openapi("MootaPullBody"),
				},
			},
		},
	},
	responses: {
		200: {
			description: "Mutations fetched.",
			content: {
				"application/json": {
					schema: z.object({
						success: z.literal(true),
						data: z.object({
							mutations: z.array(z.record(z.string(), z.unknown())),
							nextPageUrl: z.string().nullable(),
						}),
					}),
				},
			},
		},
		400: {
			description: "Missing accountId.",
			content: { "application/json": { schema: errorSchema } },
		},
		401: {
			description: "Missing or invalid API key.",
			content: { "application/json": { schema: errorSchema } },
		},
		422: {
			description: "Moota API token not configured or upstream error.",
			content: { "application/json": { schema: errorSchema } },
		},
		500: {
			description: "Unexpected error.",
			content: { "application/json": { schema: errorSchema } },
		},
	},
});

mutationsRouter.openapi(mootaPullRoute, async (c) => {
	const merchantId = c.get("merchantId") ?? "merch_default";
	const body = c.req.valid("json");
	try {
		const cfg = (await resolveGatewayConfig("moota", merchantId)) as {
			apiKey?: string;
		};
		if (!cfg.apiKey) {
			return c.json(
				{
					success: false,
					error: {
						code: "MOOTA_NOT_CONFIGURED",
						message: "Moota API token not set for this merchant",
					},
				},
				422,
			);
		}
		const result = await pullMoota({
			apiKey: cfg.apiKey,
			accountId: body.accountId,
		});
		return c.json({ success: true, data: result }, 200);
	} catch (err: unknown) {
		if (err instanceof GatewayError) {
			return c.json(
				{
					success: false,
					error: { code: "GATEWAY_ERROR", message: err.message },
				},
				422,
			);
		}
		logger.error("Moota pull route error", {
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(
			{
				success: false,
				error: { code: "INTERNAL", message: "Unexpected error" },
			},
			500,
		);
	}
});
