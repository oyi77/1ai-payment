/**
 * Merchant routes — CRUD for merchant accounts.
 *
 * - POST   /api/merchants           — create merchant (returns API key once)
 * - GET    /api/merchants           — get requester's own merchant account
 * - GET    /api/merchants/:id       — get merchant details (own merchant only)
 * - PATCH  /api/merchants/:id       — update merchant (own merchant only)
 * - POST   /api/merchants/:id/api-key — rotate API key (returns new key once)
 *
 * All endpoints require API key authentication. `:id` routes are scoped to the
 * authenticated merchant; plan/active changes are admin-only.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { defaultHook } from "../schemas";
import { accountsRouter } from "./merchants/accounts.routes";
import { merchantGatewaysRouter } from "./merchants/gateways.routes";

type MerchantEnv = {
	Variables: { merchantId?: string; merchantName?: string };
};
export const merchantRoutes = new OpenAPIHono<MerchantEnv>({ defaultHook });

merchantRoutes.route("/", accountsRouter);
merchantRoutes.route("/", merchantGatewaysRouter);
