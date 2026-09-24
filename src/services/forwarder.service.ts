/**
 * Forwarder service — sends normalized payment events to project callbacks.
 *
 * SECURITY: Signs forwarded events with project's webhook_secret.
 * RETRIES: 3 attempts with exponential backoff (5s, 30s, 300s).
 */

import { getDb } from "../config/database";
import type { NormalizedPaymentEvent } from "../gateways/base";
import { forwardFailuresCounter } from "../middleware/metrics";
import {
	decryptWebhookSecret,
	generateEventId,
	signPayload,
} from "../utils/crypto";
import { logger, upstreamPreview } from "../utils/logger";
import { fetchPublic } from "../utils/ssrf";
import { getOrderById, markForwarded } from "./order.service";
import type { Order } from "./order.service";
interface ForwardResult {
	success: boolean;
	statusCode: number;
	attempts: number;
}

const MAX_RETRIES = 3;
const BACKOFF_MS = [5_000, 30_000, 300_000];

/**
 * In-flight forward tracking for graceful shutdown (Sweep141).
 *
 * The webhook route fires forwardEvent without awaiting (webhook must 200
 * fast). A restart mid-forward previously killed the promise silently: no
 * delivery, no dead letter, order left success with a blind merchant.
 * Tracked forwards are drained on shutdown; ones still sleeping in backoff
 * past the drain budget get a dead letter ("interrupted by shutdown") so
 * they stay replayable instead of vanishing.
 */
interface InflightForward {
	promise: Promise<unknown>;
	order: Order;
	event: NormalizedPaymentEvent;
}
const inflight = new Set<InflightForward>();

export function trackForward(
	promise: Promise<unknown>,
	order: Order,
	event: NormalizedPaymentEvent,
): Promise<unknown> {
	const entry: InflightForward = { promise, order, event };
	inflight.add(entry);
	void promise.finally(() => {
		inflight.delete(entry);
	});
	return promise;
}

export async function drainForwards(
	// Default fits inside the live PM2 kill_timeout (5000ms, Sweep143):
	// callers without an explicit budget inherit the safe one.
	timeoutMs = 3000,
): Promise<{ settled: number; deadLettered: number }> {
	if (inflight.size === 0) return { settled: 0, deadLettered: 0 };
	const entries = [...inflight];
	await Promise.race([
		Promise.allSettled(entries.map((e) => e.promise)),
		sleep(timeoutMs),
	]);
	let deadLettered = 0;
	for (const e of entries) {
		// Still present = did not settle within budget. The original promise
		// may settle later (harmless duplicate dead letter at worst —
		// replays share the stable event_id, so merchants dedupe).
		if (inflight.has(e)) {
			inflight.delete(e);
			await writeDeadLetter(
				e.order,
				e.event,
				"interrupted by server shutdown (replay to retry)",
				0,
			).catch(() => {});
			deadLettered++;
		}
	}
	return { settled: entries.length - deadLettered, deadLettered };
}
/**
 * Forward a normalized payment event to a project callback URL.
 * Returns immediately (async) — does not block webhook response.
 *
 * Uses order.metadata to include project's original data in forwarded event.
 */
export async function forwardEvent(
	event: NormalizedPaymentEvent,
	order: Order,
	webhookSecret: string,
): Promise<ForwardResult> {
	const status = event.status;
	const eventType = `payment.${status}`;
	// Stable dedupe ID (Sweep119): retries of THIS call reuse the payload
	// object below, and replays re-derive the same ID — merchants dedupe on
	// event_id across attempts, replays, and gateway retransmissions.
	// timestamp stays per-call (observability), never for identity.
	const eventId = `evt_${order.id}_${eventType}`;

	const payload = JSON.stringify({
		event_id: eventId,
		event: eventType,
		gateway: event.gateway,
		order_id: order.id,
		project_order_id: order.project_order_id,
		gateway_reference: event.gateway_reference,
		status,
		amount: event.amount,
		currency: event.currency,
		payment_method: event.payment_method,
		paid_at: event.paid_at,
		metadata: order.metadata,
		timestamp: new Date().toISOString(),
	});

	const signature = signPayload(payload, webhookSecret);

	let lastError: Error | null = null;
	let lastStatus: number | null = null;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			// SSRF guard: DNS-validate the merchant URL per attempt and
			// validate every redirect hop (Sweep77). Blocked = fail the
			// attempt like a network error (retry → dead letter on exhaust).
			const guarded = await fetchPublic(order.callback_url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Payment-Signature": signature,
					"X-Payment-Event": eventType,
				},
				body: payload,
				signal: AbortSignal.timeout(30_000),
			});
			if (guarded.blocked) {
				lastError = new Error(`SSRF-blocked callback: ${guarded.reason}`);
				lastStatus = null;
			} else {
				const response = guarded.response as Response;

				if (response.ok) {
					await markForwarded(order.id, response.status, attempt + 1);
					return {
						success: true,
						statusCode: response.status,
						attempts: attempt + 1,
					};
				}

				lastError = new Error(
					`HTTP ${response.status}: ${upstreamPreview(await response.text().catch(() => "unknown"))}`,
				);
				lastStatus = response.status;
			}
		} catch (err: unknown) {
			lastError = err instanceof Error ? err : new Error(String(err));
		}

		if (attempt < MAX_RETRIES - 1) {
			const backoff = BACKOFF_MS[attempt] || 30_000;
			await sleep(backoff);
		}
	}

	logger.error("Forward failed after all retries", {
		order_id: order.id,
		callback_url: order.callback_url,
		error: lastError?.message,
		attempts: MAX_RETRIES,
	});

	forwardFailuresCounter.inc({ gateway: order.gateway || "unknown" });

	await writeDeadLetter(
		order,
		event,
		lastError?.message ?? "Unknown error",
		MAX_RETRIES,
	);
	await markForwarded(order.id, 0, MAX_RETRIES);
	return { success: false, statusCode: lastStatus ?? 0, attempts: MAX_RETRIES };
}
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function writeDeadLetter(
	order: Order,
	event: NormalizedPaymentEvent,
	errorMessage: string,
	attempts: number,
): Promise<void> {
	try {
		const db = getDb();
		const eventData = JSON.stringify({
			event: { ...event },
			order_id: order.id,
			callback_url: order.callback_url,
			payload: JSON.stringify({
				gateway: event.gateway,
				order_id: order.id,
				status: event.status,
				amount: event.amount,
				currency: event.currency,
			}),
		});
		await db.execute({
			sql: `INSERT INTO dead_letter_events (id, order_id, gateway, event_data, error, attempts)
            VALUES (?, ?, ?, ?, ?, ?)`,
			args: [
				generateEventId(),
				order.id,
				event.gateway,
				eventData,
				errorMessage,
				attempts,
			],
		});
		logger.error("Wrote dead letter for failed forward", {
			order_id: order.id,
			gateway: event.gateway,
			error: errorMessage,
		});
	} catch (dbErr: unknown) {
		logger.error("Failed to write dead letter entry", { error: String(dbErr) });
	}
}

export interface ReplayResult {
	ok: boolean;
	error?: string;
}

/**
 * Re-forward a previously failed webhook delivery stored in the dead-letter
 * table. Uses the merchant's webhook_secret to sign the event (same as the
 * original forward). Marks the dead-letter row as replayed on success.
 *
 * @param id dead_letter_events.id
 * @param expectedMerchantId optional owner check (defense in depth — the
 * route already 404s cross-merchant, but the service must never forward
 * another merchant's event even if a future caller forgets). Mismatch
 * returns the same "Order not found" as a missing order (indistinguishable).
 */
export async function replayDeadLetter(
	id: string,
	expectedMerchantId?: string,
): Promise<ReplayResult> {
	const db = getDb();

	const result = await db.execute({
		sql: "SELECT * FROM dead_letter_events WHERE id = ?",
		args: [id],
	});
	if (result.rows.length === 0) {
		return { ok: false, error: "Dead letter not found" };
	}
	const row = result.rows[0] as Record<string, unknown>;

	const orderId = row.order_id != null ? String(row.order_id) : "";
	if (!orderId) {
		return { ok: false, error: "Dead letter has no order" };
	}

	const order = await getOrderById(orderId);
	if (!order) {
		return { ok: false, error: "Order not found" };
	}
	if (
		expectedMerchantId &&
		order.merchant_id !== expectedMerchantId &&
		order.project_id !== expectedMerchantId
	) {
		return { ok: false, error: "Order not found" };
	}
	if (!order) {
		return { ok: false, error: "Order not found" };
	}

	// Signing secret lives on the merchant row (encrypted at rest, Sweep154)
	// — never logged. Undecryptable rows fail the replay loudly.
	const merchant = await db.execute({
		sql: "SELECT webhook_secret FROM merchants WHERE id = ?",
		args: [order.merchant_id],
	});
	if (merchant.rows.length === 0) {
		return { ok: false, error: "Merchant not found" };
	}
	const webhookSecret = decryptWebhookSecret(
		(merchant.rows[0] as Record<string, unknown>).webhook_secret,
	);
	if (!webhookSecret) {
		return { ok: false, error: "No webhook secret for merchant" };
	}

	let stored: { event?: NormalizedPaymentEvent };
	try {
		stored = JSON.parse(String(row.event_data ?? "{}")) as {
			event?: NormalizedPaymentEvent;
		};
	} catch {
		return { ok: false, error: "Invalid event data in dead letter" };
	}
	if (!stored.event) {
		return { ok: false, error: "Missing event in dead letter" };
	}

	const forward = await forwardEvent(stored.event, order, webhookSecret);
	if (!forward.success) {
		logger.error("Replay failed", {
			id,
			order_id: order.id,
			statusCode: forward.statusCode,
		});
		return {
			ok: false,
			error: `Re-forward failed (HTTP ${forward.statusCode})`,
		};
	}

	await db.execute({
		sql: "UPDATE dead_letter_events SET replayed_at = datetime('now') WHERE id = ?",
		args: [id],
	});

	logger.info("Dead letter replayed", { id, order_id: order.id });
	return { ok: true };
}
