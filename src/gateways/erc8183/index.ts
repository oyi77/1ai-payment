/**
 * ERC-8183 Gateway — Agentic Commerce Escrow payments
 *
 * ERC-8183 enables AI agents to autonomously hire, verify, and settle
 * payments through trustless escrow with evaluator attestation.
 *
 * Flow:
 * 1. Employer creates payment via POST /api/payments with gateway=erc8183
 * 2. System creates escrow entry and returns escrow details
 * 3. Employer funds the escrow (on-chain)
 * 4. Provider completes the work
 * 5. Evaluator attests to completion
 * 6. Funds are released to provider, event forwarded to callback_url
 *
 * @module erc8183
 */

import type {
	CreatePaymentParams,
	CreatePaymentResult,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
} from "../base";

import { getConfig } from "../../config/env";
import { createEscrow, getPaymentMethods } from "./payment";
import { normalizeEvent, parseAttestation } from "./webhook";

/**
 * Simple in-memory store for escrow state.
 * In production, escrow state lives on-chain.
 */
const escrowStore = new Map<string, { status: string; updatedAt: string }>();

export class ERC8183Gateway implements PaymentGateway {
	readonly name = "erc8183";

	get enabled(): boolean {
		return Boolean(getConfig().ERC8183_TOKEN_ADDRESS);
	}

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		const result = await createEscrow(params);
		escrowStore.set(result.gatewayReference, {
			status: "pending",
			updatedAt: new Date().toISOString(),
		});
		return result;
	}

	getPaymentMethods(): PaymentMethod[] {
		return getPaymentMethods();
	}

	verifySignature(body: unknown, headers: Record<string, string>): boolean {
		// For ERC-8183, signature verification depends on the attestation signature
		// For MVP, we check structural validity
		const { attestation, error } = parseAttestation(body);
		if (error) return false;
		return Boolean(attestation.escrowId && attestation.evaluator);
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		return normalizeEvent(body, metadata);
	}
}
