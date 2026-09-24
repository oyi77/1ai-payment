/**
 * Webhook routes — receives callbacks from payment gateways.
 *
 * Each gateway has its own endpoint:
 * - POST /webhook/midtrans
 * - POST /webhook/tripay
 *
 * Flow: receive → verify signature → normalize → lookup order → forward to project
 * Returns 200 immediately. Forwarding happens asynchronously with retries.
 *
 * OpenAPI spec is auto-generated from route definitions.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDb } from "../config/database";
import { MERCHANT_CREDENTIAL_KEYS, getConfig } from "../config/env";
import { getGateway } from "../gateways";
import type { NormalizedPaymentEvent } from "../gateways/base";
import { MAX_BODY_BYTES } from "../middleware/body-limit";
import { webhooksReceivedCounter } from "../middleware/metrics";
import {
	GATEWAY_NAMES,
	defaultHook,
	webhookAckSchema,
	webhookErrorSchema,
} from "../schemas";
import { forwardEvent, trackForward } from "../services/forwarder.service";
import {
	handleNexusPayment,
	revokeNexusAccess,
} from "../services/nexus-fulfillment";
import {
	getOrderByGatewayRef,
	getOrderById,
	updateOrderStatus,
} from "../services/order.service";
import type { Order } from "../services/order.service";
import { generateEventId } from "../utils/crypto";
import { logger } from "../utils/logger";

export const webhookRoutes = new OpenAPIHono({ defaultHook });

const webhookAckJson = {
	"application/json": { schema: webhookAckSchema },
} as const;
const errorJson = {
	"application/json": { schema: webhookErrorSchema },
} as const;

/**
 * Determine whether an incoming webhook request was transported over TLS.
 * Behind Cloudflare the app sees plain HTTP, so the edge signal decides.
 *
 * Trust order (Sweep125):
 * 1. Direct https URL — true.
 * 2. CF-Visitor (Cloudflare edge writes this; clients cannot forge it
 *    through the edge): https → true, anything else → FALSE, stop.
 * 3. X-Forwarded-Proto — honored ONLY when TRUST_PROXY is set (a
 *    non-Cloudflare reverse proxy the operator controls). Otherwise an
 *    attacker could slip "https" into a comma chain (`.some()` matches
 *    any hop) and bypass enforcement.
 */
export function isHttpsRequest(
	url: string,
	xForwardedProto?: string,
	cfVisitor?: string,
): boolean {
	if (url.startsWith("https://")) return true;
	if (cfVisitor !== undefined) {
		try {
			const parsed: unknown = JSON.parse(cfVisitor);
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				"scheme" in parsed &&
				parsed.scheme === "https"
			)
				return true;
		} catch {
			// malformed header — fall through to false
		}
		return false;
	}
	if (getConfig().TRUST_PROXY) {
		if (xForwardedProto?.split(",").some((p) => p.trim() === "https"))
			return true;
	}
	return false;
}

/**
 * Merchant-key verification fallback. Runs AFTER the platform-key check
 * fails for the event's owning merchant(s). First True wins.
 *
 * Candidate merchants: the order the event resolves to (by gateway
 * reference, then order id), plus — when the DB lookup found no order —
 * every merchant with an enabled row for this gateway.
/**
 * Gateways whose verifySignature honors opts.merchantId (derived from the
 * merchant-credential contract, minus saweria: its verify is credential-free
 * reconciliation, so per-merchant retry always returns the same verdict).
 * Platform-credential gateways (paypal, telegram x2, x402, erc8183) verify
 * against platform config only — retrying per merchant would repeat the
 * identical check (worst case: N remote PayPal API calls per webhook).
 */
export const MERCHANT_VERIFY_GATEWAYS: Record<string, true> =
	Object.fromEntries(
		Object.keys(MERCHANT_CREDENTIAL_KEYS)
			.filter((g) => g !== "saweria")
			.map((g) => [g, true as const]),
	);
async function verifyAgainstMerchantKeys(
	gateway: {
		verifySignatureRaw?: (
			raw: string,
			h: Record<string, string>,
			o?: { merchantId?: string },
		) => boolean | Promise<boolean>;
		verifySignature: (
			b: unknown,
			h: Record<string, string>,
			o?: { merchantId?: string },
		) => boolean | Promise<boolean>;
		normalizeEvent: (
			b: unknown,
			m?: Record<string, unknown> | null,
		) => {
			order_id: string;
			gateway_reference: string;
		};
	},
	gatewayName: string,
	rawBody: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<boolean> {
	if (!MERCHANT_VERIFY_GATEWAYS[gatewayName]) return false;
	const { getDb } = await import("../config/database");
	const { getOrderByGatewayRef, getOrderById } = await import(
		"../services/order.service"
	);
	const db = getDb();

	// Resolve candidate events → orders (no metadata yet)
	let orderId: string | undefined;
	let gatewayRef: string | undefined;
	try {
		const evt = gateway.normalizeEvent(body, null);
		orderId = evt.order_id;
		gatewayRef = evt.gateway_reference;
	} catch {
		return false;
	}

	// Collect candidate merchant ids: owning order first, else all enabled
	// merchant rows for this gateway.
	const candidates: string[] = [];
	let order: { merchant_id: string; project_id?: string } | null = null;
	try {
		if (gatewayName === "scalev" && orderId) {
			order = await getOrderById(orderId);
		}
		if (!order && gatewayRef) {
			order = await getOrderByGatewayRef(gatewayRef);
		}
		if (!order && orderId) {
			order = await getOrderById(orderId);
		}
	} catch {
		// fall through: try all merchant rows below
	}
	if (order) {
		candidates.push(order.merchant_id);
	} else {
		const rows = await db.execute({
			sql: "SELECT DISTINCT merchant_id FROM merchant_gateways WHERE gateway = ? AND enabled = 1",
			args: [gatewayName],
		});
		for (const row of rows.rows) {
			candidates.push(String((row as Record<string, unknown>).merchant_id));
		}
	}

	for (const merchantId of candidates) {
		try {
			const ok = gateway.verifySignatureRaw
				? await gateway.verifySignatureRaw(rawBody, headers, { merchantId })
				: await gateway.verifySignature(body, headers, { merchantId });
			if (ok) {
				logger.info(`Webhook ${gatewayName}: merchant-key signature match`, {
					merchant_id: merchantId,
				});
				return true;
			}
		} catch (err: unknown) {
			logger.error(`Webhook ${gatewayName}: merchant-key verification error`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return false;
}

for (const gatewayName of GATEWAY_NAMES) {
	const route = createRoute({
		method: "post",
		path: `/${gatewayName}` as string,
		tags: ["Webhooks"],
		summary: `Receive ${gatewayName} callback`,
		description: `Called by ${gatewayName}, not by API clients. Verifies signature, normalizes event, updates order, forwards to project callback_url asynchronously.`,
		security: [],
		request: {
			body: {
				content: {
					"application/json": {
						schema: z.record(z.string(), z.unknown()).openapi({
							description:
								"Gateway-specific payload. Schema varies per gateway.",
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: "Webhook accepted. Forwarding happens asynchronously.",
				content: webhookAckJson,
			},
			400: {
				description: "Invalid JSON body or malformed event.",
				content: errorJson,
			},
			401: {
				description: "Signature verification failed.",
				content: errorJson,
			},
			413: {
				description: "Payload too large.",
				content: errorJson,
			},
			501: { description: "Gateway not yet implemented.", content: errorJson },
		},
	});

	webhookRoutes.openapi(route, async (c) => {
		const gateway = getGateway(gatewayName);
		if (!gateway) {
			return c.json({ error: `Gateway not implemented: ${gatewayName}` }, 501);
		}

		// Parse headers (normalize to lowercase keys)
		const headers: Record<string, string> = {};
		c.req.raw.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});

		// HTTPS enforcement (configurable; defaults to production-only)
		if (
			getConfig().REQUIRE_HTTPS &&
			!isHttpsRequest(
				c.req.url,
				headers["x-forwarded-proto"],
				headers["cf-visitor"],
			)
		) {
			logger.warn(`Webhook ${gatewayName}: non-HTTPS request rejected`);
			return c.json({ error: "HTTPS required" }, 400);
		}

		// Parse body — read raw text first so HMAC gateways verify over raw bytes.
		// Length gate: giants are cut here (413) before HMAC/DB ever see them.
		// c.req.text() reuses Hono's cached body (safe after OpenAPI parsing).
		let rawBody: string;
		let body: unknown;
		try {
			rawBody = await c.req.text();
			if (rawBody.length > MAX_BODY_BYTES) {
				return c.json({ error: "Payload too large" }, 413);
			}
			body = rawBody ? JSON.parse(rawBody) : {};
		} catch {
			logger.warn(`Webhook ${gatewayName}: invalid JSON body`);
			return c.json({ error: "Invalid JSON" }, 400);
		}

		// Verify signature — platform keys first (no DB). On fail, retry against
		// each platform-configured merchant row that could own this event.
		// Merchant keys are tried; first True wins. Fall closed.
		let signatureValid = false;
		try {
			signatureValid = gateway.verifySignatureRaw
				? await gateway.verifySignatureRaw(rawBody, headers)
				: await gateway.verifySignature(body, headers);
			if (!signatureValid) {
				signatureValid = await verifyAgainstMerchantKeys(
					gateway,
					gatewayName,
					rawBody,
					body,
					headers,
				);
			}
		} catch (err: unknown) {
			logger.error(`Webhook ${gatewayName}: signature verification error`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (!signatureValid) {
			// Forgery triage context: order_ref lets ops distinguish gateway
			// retries for a real order (actionable) from blind probes (noise).
			// Only IDs — never the body, signature, or headers (Sweep93 rule).
			const b = body as Record<string, unknown> | null;
			const orderRef =
				typeof b?.order_id === "string"
					? b.order_id
					: typeof b?.merchant_ref === "string"
						? b.merchant_ref
						: typeof b?.external_id === "string"
							? b.external_id
							: typeof b?.merchantOrderId === "string"
								? b.merchantOrderId
								: typeof b?.message === "string"
									? b.message
									: "none";
			logger.warn(`Webhook ${gatewayName}: invalid signature`, {
				order_ref: orderRef,
			});
			return c.json({ error: "Invalid signature" }, 401);
		}

		// Normalize event (no metadata yet — we'll look up the order)
		let event: NormalizedPaymentEvent;
		try {
			event = gateway.normalizeEvent(body, null);
		} catch (err: unknown) {
			logger.error(`Webhook ${gatewayName}: normalization error`, {
				error: err instanceof Error ? err.message : String(err),
			});
			return c.json({ error: "Failed to normalize event" }, 400);
		}

		// Log event (no raw payload — security rule)
		logger.info("Webhook received", {
			gateway: gatewayName,
			order_id: event.order_id,
			status: event.status,
			gateway_reference: event.gateway_reference,
		});

		webhooksReceivedCounter.inc({ gateway: gatewayName, status: event.status });

		// Look up order — try by gateway_reference first, then order_id
		let order: Order | null = null;

		// For Scalev, the order_id extracted from notes field is our internal order_id
		if (gatewayName === "scalev" && event.order_id) {
			order = await getOrderById(event.order_id);
		}

		// Try by gateway_reference (for gateways that provide it)
		if (!order && event.gateway_reference) {
			order = await getOrderByGatewayRef(event.gateway_reference);
		}

		// Try by order_id (for gateways that use our order_id directly)
		if (!order && event.order_id) {
			order = await getOrderById(event.order_id);
		}

		if (!order) {
			logger.warn("Webhook received for unknown order", {
				gateway: gatewayName,
				order_id: event.order_id,
				gateway_reference: event.gateway_reference,
			});
			try {
				const db = getDb();
				// order_id is NULL for unknown orders, so the UNIQUE index
				// (order_id, gateway, status) cannot dedupe — guard manually.
				const fingerprint =
					event.order_id ||
					event.gateway_reference ||
					JSON.stringify({
						gateway: event.gateway,
						order_id: event.order_id,
						gateway_reference: event.gateway_reference,
						status: event.status,
						amount: event.amount,
						currency: event.currency,
						payment_method: event.payment_method,
						paid_at: event.paid_at,
					});
				const existing = await db.execute({
					sql: "SELECT id FROM webhook_events WHERE gateway = ? AND (order_id = ? OR gateway_reference = ?)",
					args: [gatewayName, fingerprint, fingerprint],
				});
				if (existing.rows.length > 0) {
					logger.info("Duplicate webhook for unknown order, skipping", {
						gateway: gatewayName,
						order_id: event.order_id,
						status: event.status,
					});
					return c.json({ ok: true as const }, 200);
				}
				await db.execute({
					sql: `INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status, raw_payload, headers, signature_valid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						generateEventId(),
						gatewayName,
						event.order_id,
						event.gateway_reference || fingerprint,
						event.status,
						rawBody,
						JSON.stringify(headers),
						signatureValid ? 1 : 0,
					],
				});
			} catch (dbErr: unknown) {
				// The SELECT above is only a fast path — two concurrent identical
				// callbacks can both pass it. The partial UNIQUE index from
				// migration v004 is the atomic dedupe; a violation means this
				// exact event was already processed, so skip quietly (no nexus
				// fulfillment, no double-credit).
				if (
					dbErr instanceof Error &&
					dbErr.message.includes("UNIQUE constraint")
				) {
					logger.info("Duplicate webhook for unknown order, skipping", {
						gateway: gatewayName,
						order_id: event.order_id,
						status: event.status,
					});
					return c.json({ ok: true as const }, 200);
				}
				logger.error("Failed to log webhook for unknown order", {
					error: String(dbErr),
				});
				// Non-dedupe DB failure: the event was NOT recorded, so it
				// must NOT be processed further — Nexus fulfillment below
				// would create a subscription with no audit row. Still 200
				// per the webhook contract (no gateway retry on poison).
				return c.json({ ok: true as const }, 200);
			}

			// B2: Try nexus fulfillment for direct Scalev checkout (no order in DB)
			if (gatewayName === "scalev" && event.status === "success") {
				const result = await handleNexusPayment(
					gatewayName,
					body as Record<string, unknown>,
					String((body as Record<string, unknown>).customer_email ?? ""),
					String((body as Record<string, unknown>).customer_name ?? ""),
				);
				if (result.success) {
					logger.info("Nexus: fulfillment complete for direct checkout", {
						subId: result.subscriptionId,
					});
				}
			}
			// B2-revoke (Sweep145): a terminal-negative Scalev event
			// (cancelled/expired/failed/refunded) for a fulfilled order must end
			// paid access — otherwise a refunded customer keeps Telegram access
			// until expires_at. No-op when no active subscription matches.
			if (
				gatewayName === "scalev" &&
				(event.status === "cancelled" ||
					event.status === "expired" ||
					event.status === "failed" ||
					event.status === "refunded")
			) {
				const scalevOrderId =
					event.gateway_reference ||
					String(
						(body as Record<string, unknown>).id ??
							(body as Record<string, unknown>).order_id ??
							"",
					);
				const { revoked } = await revokeNexusAccess(
					scalevOrderId,
					event.status,
				);
				if (revoked > 0) {
					logger.info("Nexus: access revoked on terminal event", {
						scalev_order_id: scalevOrderId,
						status: event.status,
						revoked,
					});
				}
			}
			return c.json({ ok: true as const }, 200);
		}

		// Saweria has no webhook signature: anyone who knows an order_id can
		// forge a success callback. Amount-match is the reconciliation floor —
		// reject underpay forgeries (paid X, claim Y>X). Overpay passes
		// (donors tip extra; amount_raw includes fees). Residue: exact-amount
		// forgery with zero payment is still possible — full mitigation needs
		// a Saweria transaction-status API, which does not exist publicly.
		// 200-skip (not 4xx): the fact will not change on retry; log the warn.
		if (gatewayName === "saweria" && event.amount < order.amount) {
			logger.warn("Saweria: underpay forgery rejected", {
				order_id: order.id,
				order_amount: order.amount,
				claimed_amount: event.amount,
			});
			return c.json({ ok: true as const }, 200);
		}

		// Re-normalize with metadata from order
		const fullEvent = gateway.normalizeEvent(body, order.metadata);

		// INSERT into webhook_events FIRST — UNIQUE constraint catches duplicates
		const eventId = generateEventId();
		try {
			const db = getDb();
			await db.execute({
				sql: `INSERT INTO webhook_events (id, gateway, order_id, gateway_reference, status, raw_payload, headers, signature_valid)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					eventId,
					gatewayName,
					order.id,
					fullEvent.gateway_reference,
					fullEvent.status,
					rawBody,
					JSON.stringify(headers),
					signatureValid ? 1 : 0,
				],
			});
		} catch (dbErr: unknown) {
			// UNIQUE(order_id, gateway, status) violation = duplicate webhook
			if (
				dbErr instanceof Error &&
				dbErr.message.includes("UNIQUE constraint")
			) {
				logger.info("Duplicate webhook, skipping", {
					order_id: order.id,
					status: fullEvent.status,
					gateway: gatewayName,
				});
				return c.json({ ok: true as const }, 200);
			}
			// Unexpected DB error — still return 200 per webhook contract
			logger.error("Failed to log webhook event, skipping forward", {
				order_id: order.id,
				error: dbErr instanceof Error ? dbErr.message : String(dbErr),
			});
			return c.json({ ok: true as const }, 200);
		}

		// New event — update order and forward
		await updateOrderStatus(
			order.id,
			fullEvent.status,
			fullEvent.gateway_reference,
		);

		// Look up merchant's webhook_secret for signing — no fallback. Only
		// forward when a real secret exists; signing with anything else would
		// make verification fail on the project side.
		let webhookSecret: string | null = null;
		try {
			// merchant_id first: it is the canonical owner (project_id is a
			// legacy alias, kept equal at creation but not guaranteed).
			const merchantResult = await getDb().execute({
				sql: "SELECT webhook_secret FROM merchants WHERE id = ?",
				args: [order.merchant_id],
			});
			if (merchantResult.rows.length > 0) {
				webhookSecret = merchantResult.rows[0].webhook_secret as string;
			}
		} catch {
			/* treat as missing secret */
		}

		if (!webhookSecret || webhookSecret.length === 0) {
			logger.warn(
				"Webhook: merchant webhook_secret missing, skipping forward",
				{
					gateway: gatewayName,
					order_id: order.id,
					status: fullEvent.status,
				},
			);
			return c.json({ ok: true as const }, 200);
		}

		// Tracked for shutdown drain (Sweep141): a restart mid-forward no
		// longer loses the event silently — drain writes a replayable dead
		// letter for anything still in flight past the budget.
		trackForward(
			forwardEvent(fullEvent, order, webhookSecret).catch((err: unknown) => {
				logger.error("Async forward failed", {
					order_id: order?.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}),
			order,
			fullEvent,
		);

		return c.json({ ok: true as const }, 200);
	});
}

// Catch-all for unknown gateways — webhook error shape ({ error }), not the
// /api/* envelope: gateway callers key retries off this contract.
webhookRoutes.all("*", (c) => {
	return c.json({ error: "Unknown gateway" }, 501);
});
