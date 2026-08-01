/**
 * ERC-8183 Webhook Module
 *
 * Handles ERC-8183 escrow attestation webhook events.
 * ERC-8183 is the Agentic Commerce standard for AI agent job escrow
 * with evaluator attestation. The webhook receives attestation events
 * (evaluator approves/rejects work).
 *
 * Attestation signature scheme:
 *   The evaluator signs `JSON.stringify({ escrowId, evaluator, approved, notes })`
 *   with their wallet. The expected evaluator address is read from the
 *   ERC8183_EVALUATOR_ADDRESS env var (or ERC8183_EVALUATOR_PUBLIC_KEY).
 *   Verification recovers the signer from the signature (viem) and
 *   compares it to the configured evaluator using a timing-safe compare.
 *   Missing signature or missing configured evaluator => reject.
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-8183
 */

import { isAddress, recoverMessageAddress } from "viem";
import { getConfig } from "../../config/env";
import { timingSafeCompare } from "../../utils/crypto";
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
 * Get the configured evaluator address used to verify attestations.
 * Fails closed (undefined) when not configured — webhooks are rejected.
 */
function getEvaluatorAddress(): string | undefined {
	const cfg = getConfig();
	const evaluator =
		cfg.ERC8183_EVALUATOR_ADDRESS ||
		(process.env.ERC8183_EVALUATOR_PUBLIC_KEY ?? undefined);
	if (!evaluator || !isAddress(evaluator)) return undefined;
	return evaluator.toLowerCase();
}

/**
 * Build the canonical message an evaluator signs for an attestation.
 * The scheme is: JSON.stringify({ escrowId, evaluator, approved, notes })
 * with `notes` normalized to null when absent.
 */
export function buildAttestationMessage(
	attestation: EscrowAttestation,
): string {
	return JSON.stringify({
		escrowId: attestation.escrowId,
		evaluator: attestation.evaluator,
		approved: attestation.approved,
		notes: attestation.notes ?? null,
	});
}

/**
 * Verify an attestation's signature against the configured evaluator.
 *
 * Recovers the signer from the attestation signature and requires:
 *   1. a signature is present,
 *   2. an evaluator address is configured (fail closed otherwise),
 *   3. the recovered signer matches the configured evaluator (timing-safe),
 *   4. if the payload's evaluator is a valid address, it must also match.
 */
export async function verifyAttestationSignature(
	attestation: EscrowAttestation,
): Promise<boolean> {
	if (!attestation.signature) return false;

	const expectedEvaluator = getEvaluatorAddress();
	if (!expectedEvaluator) return false;

	try {
		const recovered = (
			await recoverMessageAddress({
				message: buildAttestationMessage(attestation),
				signature: attestation.signature as `0x${string}`,
			})
		).toLowerCase();

		if (!timingSafeCompare(recovered, expectedEvaluator)) return false;

		// If the payload declares an evaluator address, it must be the signer.
		if (isAddress(attestation.evaluator)) {
			if (recovered !== attestation.evaluator.toLowerCase()) return false;
		}

		return true;
	} catch {
		return false;
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
