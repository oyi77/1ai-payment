/**
 * Mutation forwarder — bank-mutation events (Moota/Mutasiku) to projects.
 *
 * Payment gateways forward events tied to an order (and thus a single
 * merchant). Bank-mutation aggregators are different: a mutation belongs
 * to no order — it is a raw bank credit/debit observed on an account. We
 * therefore fan the mutation out to EVERY merchant that has the aggregator
 * enabled, using that merchant's default_callback_url and webhook secret.
 *
 * Signing: X-Mutation-Signature = HMAC-SHA256(payload, merchant webhook
 * secret), same envelope as payment forwards so projects verify with the
 * one secret they already hold.
 *
 * Delivery is fire-and-forget with a bounded retry; failures are recorded
 * in webhook_deliveries so ops can replay (per-merchant isolation: one
 * unreachable project never blocks another).
 */

import { randomUUID } from "node:crypto";

import { getDb } from "../config/database";
import type { NormalizedPaymentEvent } from "../gateways/base";
import { decryptWebhookSecret, signPayload } from "../utils/crypto";
import { logger } from "../utils/logger";
import { fetchPublic } from "../utils/ssrf";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 10_000];

interface MutationTarget {
	merchant_id: string;
	callback_url: string;
	webhook_secret: string; // decrypted
}

/**
 * Resolve every active merchant that has this aggregator gateway enabled
 * and a usable callback + secret. Merchants missing either are skipped
 * with a warn (their operator must configure them).
 */
async function resolveTargets(gateway: string): Promise<MutationTarget[]> {
	const db = getDb();
	const rows = await db.execute({
		sql: `SELECT m.id AS merchant_id, m.default_callback_url AS callback_url,
                     m.webhook_secret AS webhook_secret
              FROM merchant_gateways g
              JOIN merchants m ON m.id = g.merchant_id
              WHERE g.gateway = ? AND g.enabled = 1 AND m.active = 1`,
		args: [gateway],
	});

	const targets: MutationTarget[] = [];
	for (const row of rows.rows) {
		const r = row as Record<string, unknown>;
		const callbackUrl = String(r.callback_url ?? "");
		const secret = decryptWebhookSecret(r.webhook_secret);
		const merchantId = String(r.merchant_id ?? "");
		if (!callbackUrl || !secret) {
			logger.warn("Mutation forward: merchant missing callback or secret", {
				gateway,
				merchant_id: merchantId,
				has_callback: Boolean(callbackUrl),
				has_secret: Boolean(secret),
			});
			continue;
		}
		targets.push({
			merchant_id: merchantId,
			callback_url: callbackUrl,
			webhook_secret: secret,
		});
	}
	return targets;
}

/**
 * Build the project-facing payload for one mutation. Kept distinct from a
 * payment event so a project reconciles mutations by unique code without
 * conflating them with gateway callbacks.
 */
function buildMutationPayload(
	event: NormalizedPaymentEvent,
	merchantId: string,
): string {
	const meta = (event.metadata ?? {}) as Record<string, unknown>;
	const eventType = `mutation.${meta.direction === "DB" ? "debit" : "credit"}`;
	return JSON.stringify({
		event_id: `mutation_${event.gateway}_${event.gateway_reference}`,
		event: eventType,
		gateway: event.gateway,
		merchant_id: merchantId,
		reference: event.gateway_reference,
		status: event.status,
		amount: event.amount,
		currency: event.currency,
		direction: meta.direction ?? null,
		description: meta.description ?? null,
		bank: meta.bank ?? null,
		account_number: meta.account_number ?? null,
		observed_at: event.paid_at,
		mutation: meta.raw ?? null,
		timestamp: new Date().toISOString(),
	});
}

/**
 * Forward one mutation to one target with bounded retries. Returns the
 * outcome; never throws (a single project failure is isolated).
 */
async function forwardToTarget(
	event: NormalizedPaymentEvent,
	target: MutationTarget,
	payload: string,
): Promise<{ merchant_id: string; ok: boolean; status: number | null }> {
	const signature = signPayload(payload, target.webhook_secret);
	let lastStatus: number | null = null;

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			const guarded = await fetchPublic(target.callback_url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Mutation-Signature": signature,
					"X-Mutation-Event": `mutation.${event.gateway}`,
				},
				body: payload,
				signal: AbortSignal.timeout(20_000),
			});
			if (guarded.blocked) {
				lastStatus = null;
			} else {
				const response = guarded.response as Response;
				if (response.ok) {
					return {
						merchant_id: target.merchant_id,
						ok: true,
						status: response.status,
					};
				}
				lastStatus = response.status;
			}
		} catch {
			lastStatus = null;
		}
		if (attempt < MAX_ATTEMPTS - 1) {
			await new Promise<void>((resolve) =>
				setTimeout(resolve, BACKOFF_MS[attempt] ?? 10_000),
			);
		}
	}
	return { merchant_id: target.merchant_id, ok: false, status: lastStatus };
}

export interface MutationFanoutResult {
	fanout: number;
	delivered: number;
	failed: number;
	targets: { merchant_id: string; ok: boolean; status: number | null }[];
}

/**
 * Fan a mutation event out to every merchant that enabled the aggregator.
 * Records each delivery so ops can audit/replay.
 */
export async function fanoutMutation(
	event: NormalizedPaymentEvent,
): Promise<MutationFanoutResult> {
	const targets = await resolveTargets(event.gateway);
	if (targets.length === 0) {
		logger.warn("Mutation forward: no enabled merchants", {
			gateway: event.gateway,
			reference: event.gateway_reference,
		});
		return { fanout: 0, delivered: 0, failed: 0, targets: [] };
	}

	const results = await Promise.all(
		targets.map((target) =>
			forwardToTarget(
				event,
				target,
				buildMutationPayload(event, target.merchant_id),
			),
		),
	);

	const delivered = results.filter((r) => r.ok).length;
	const failed = results.length - delivered;

	// Persist delivery outcomes for audit/replay. Best-effort: a logging
	// failure must never fail the webhook (gateway would retry the whole
	// mutation otherwise).
	try {
		const db = getDb();
		for (const r of results) {
			const target = targets.find((t) => t.merchant_id === r.merchant_id);
			await db.execute({
				sql: `INSERT INTO mutation_deliveries
				        (id, gateway, gateway_reference, merchant_id, event_id, url, status_code, attempts, success)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				      ON CONFLICT(gateway, gateway_reference, merchant_id)
				      DO UPDATE SET status_code = excluded.status_code,
				        attempts = excluded.attempts,
				        success = excluded.success`,
				args: [
					`md_${event.gateway}_${event.gateway_reference}_${r.merchant_id}`.slice(
						0,
						128,
					),
					event.gateway,
					event.gateway_reference,
					r.merchant_id,
					`mutation_${event.gateway}_${event.gateway_reference}`,
					target?.callback_url ?? "",
					r.status,
					MAX_ATTEMPTS,
					r.ok ? 1 : 0,
				],
			});
		}
	} catch (err: unknown) {
		logger.error("Mutation forward: delivery log failed", {
			gateway: event.gateway,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Dead letter queue — persist permanently failed deliveries for operator review/replay
	if (failed > 0) {
		const db = getDb();
		try {
			await Promise.all(
				results
					.filter((r) => !r.ok)
					.map((result) =>
						db.execute({
							sql:
								"INSERT INTO dead_letter_queue (id, type, payload, error_reason, retry_count, first_seen, last_attempt)" +
								" VALUES (?, ?, ?, 'failed_delivery', 0, ?, ?)",
							args: [
								randomUUID(),
								"mutation_fanout",
								JSON.stringify({
									event_id: event.gateway_reference,
									gateway: event.gateway,
									merchant_id: result.merchant_id,
									reason:
										result.status === null
											? "connection_error"
											: `http_${result.status}`,
								}),
								new Date().toISOString(),
								new Date().toISOString(),
							],
						}),
					),
			);
			logger.warn("Mutation fanout failures recorded to DLQ", {
				failed_count: failed,
				gateway: event.gateway,
			});
		} catch (dlqErr) {
			logger.error("DLQ insert failed", {
				error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
			});
		}
	}

	logger.info("Mutation fanout complete", {
		gateway: event.gateway,
		reference: event.gateway_reference,
		targets: targets.length,
		delivered,
		failed,
	});

	return { fanout: targets.length, delivered, failed, targets: results };
}
