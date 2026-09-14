/**
 * Payment routes — API endpoints for payment creation and management.
 *
 * - POST /api/payments — create payment (returns payment URL)
 * - GET /api/payments/:id — get payment status
 * - GET /api/gateways — list available gateways
 * - GET /api/gateways/:gateway/methods — list payment methods for a gateway
 *
 * All endpoints require API key authentication.
 * OpenAPI spec is auto-generated from route definitions.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { defaultHook } from "../schemas";
import { gatewaysRouter } from "./payments/gateways.routes";
import { paymentsRouter } from "./payments/payments.routes";
import { transactionsRouter } from "./payments/transactions.routes";
import { webhooksRouter } from "./payments/webhooks.routes";

type MerchantEnv = {
	Variables: { merchantId?: string; merchantName?: string };
};
export const paymentRoutes = new OpenAPIHono<MerchantEnv>({ defaultHook });

paymentRoutes.route("/", paymentsRouter);
paymentRoutes.route("/", gatewaysRouter);
paymentRoutes.route("/", transactionsRouter);
paymentRoutes.route("/", webhooksRouter);
