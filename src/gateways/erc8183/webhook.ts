/**
 * ERC-8183 Webhook Module
 *
 * Handles ERC-8183 escrow attestation webhook events.
 * ERC-8183 is the Agentic Commerce standard for AI agent job escrow
 * with evaluator attestation. The webhook receives attestation events
 * (evaluator approves/rejects work).
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-8183
 */

import { getConfig } from "../../config/env";
import { logger } from "../../utils/logger";
import type { NormalizedPaymentEvent } from "../base";
import type {
	CreateEscrowParams,
	EscrowAttestation,
	EscrowStatus,
} from "./types";

/**
 * Parse and verify an escrow attestation
 */
export function parseAttestation(body: unknown): {
	attestation: EscrowAttestation;
	error?: string;
} {
	try {
		const data =
			typeof body === "string"
				? JSON.parse(body)
				: (body as Record<string, unknown>);

		const attestation: EscrowAttestation = {
			escrowId: String(data.escrow_id || data.escrowId || ""),
			evaluator: String(data.evaluator || data.evaluator_address || ""),
			approved: Boolean(
				data.approved ||
					data.status === "approved" ||
					data.status === "completed",
			),
			signature: data.signature ? String(data.signature) : undefined,
			notes: data.notes ? String(data.notes) : undefined,
		};

		if (!attestation.escrowId)
			return { attestation, error: "Missing escrow_id" };
		if (!attestation.evaluator)
			return { attestation, error: "Missing evaluator" };

		return { attestation };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			attestation: { escrowId: "", evaluator: "", approved: false },
			error: msg,
		};
	}
}

/**
 * Map escrow status to PaymentStatus
 */
export function escrowStatusToPaymentStatus(
	status: EscrowStatus,
): "success" | "pending" | "failed" | "expired" | "cancelled" | "refunded" {
	switch (status) {
		case "released":
			return "success";
		case "pending":
		case "funded":
		case "in_progress":
		case "completed":
		case "attested":
			return "pending";
		case "disputed":
			return "failed";
		case "cancelled":
			return "cancelled";
		default:
			return "pending";
	}
}

/**
 * Normalize ERC-8183 event to standard payment event
 */
export function normalizeEvent(
	body: unknown,
	metadata?: Record<string, unknown> | null,
): NormalizedPaymentEvent {
	const data =
		typeof body === "string"
			? JSON.parse(body)
			: (body as Record<string, unknown>);
	const status = String(data.status || "pending") as EscrowStatus;
	const amount = typeof data.amount === "number" ? data.amount : 0;

	return {
		gateway: "erc8183",
		order_id: String(data.escrow_id || data.order_id || ""),
		gateway_reference: String(
			data.tx_hash || data.attestation_hash || data.gateway_reference || "",
		),
		status: escrowStatusToPaymentStatus(status),
		amount,
		currency: "USD",
		payment_method: "erc8183_escrow",
		paid_at: data.released_at ? String(data.released_at) : null,
		metadata: metadata || null,
	};
}
