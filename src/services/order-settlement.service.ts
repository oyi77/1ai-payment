/**
 * Order settlement service — shared path for webhook and poller.
 * Handles order status updates, nexus fulfillment, and merchant forwarding.
 */

import { getDb } from "../config/database";
import type { NormalizedPaymentEvent } from "../gateways/base";
import { decryptWebhookSecret } from "../utils/crypto";
import { logger } from "../utils/logger";
import { forwardEvent, trackForward } from "./forwarder.service";
import { handleNexusPayment } from "./nexus-fulfillment";
import { updateOrderStatus } from "./order.service";
import type { Order } from "./order.service";

export interface SettleOrderOptions {
	order: Order;
	event: NormalizedPaymentEvent;
	gatewayName?: string;
	body?: unknown;
	webhookSecret?: string | null;
}

/**
 * Settle an order: updates DB status, runs gateway-specific fulfillment
 * (e.g. Nexus Scalev), resolves merchant secret, and triggers forwardEvent.
 */
export async function settleOrder(options: SettleOrderOptions): Promise<void> {
	const { order, event, gatewayName = event.gateway, body } = options;

	// 1. Update order status and gateway reference
	await updateOrderStatus(order.id, event.status, event.gateway_reference);

	// 2. Nexus fulfillment for Scalev API-created orders on success
	if (gatewayName === "scalev" && event.status === "success" && body) {
		const meta = order.metadata ?? {};
		const rawBody = body as Record<string, unknown>;
		const bodyWithMetadata: Record<string, unknown> =
			rawBody.metadata === undefined ? { ...rawBody, metadata: meta } : rawBody;

		const result = await handleNexusPayment(
			gatewayName,
			bodyWithMetadata,
			String(rawBody.customer_email ?? ""),
			String(rawBody.customer_name ?? ""),
			typeof meta.telegram_username === "string"
				? meta.telegram_username
				: undefined,
		);

		if (result.success) {
			logger.info("Nexus: fulfillment complete for API order", {
				order_id: order.id,
				subId: result.subscriptionId,
			});
		}
	}

	// 3. Resolve merchant webhook secret if not provided
	let secret = options.webhookSecret;
	if (secret === undefined) {
		try {
			const db = getDb();
			const merchantResult = await db.execute({
				sql: "SELECT webhook_secret FROM merchants WHERE id = ?",
				args: [order.merchant_id],
			});
			if (merchantResult.rows.length > 0) {
				secret = decryptWebhookSecret(merchantResult.rows[0].webhook_secret);
			}
		} catch {
			secret = null;
		}
	}

	if (!secret || secret.length === 0) {
		logger.warn("Webhook: merchant webhook_secret missing, skipping forward", {
			gateway: gatewayName,
			order_id: order.id,
			status: event.status,
		});
		return;
	}

	// 4. Forward event to merchant callback URL
	trackForward(
		forwardEvent(event, order, secret).catch((err: unknown) => {
			logger.error("Async forward failed", {
				order_id: order?.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}),
		order,
		event,
	);
}
