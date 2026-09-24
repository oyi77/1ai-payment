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
import {
	normalizeEvent,
	parseAttestation,
	verifyAttestationSignature,
} from "./webhook";

export class ERC8183Gateway implements PaymentGateway {
	readonly name = "erc8183";

	get enabled(): boolean {
		return Boolean(getConfig().ERC8183_TOKEN_ADDRESS);
	}

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		// No in-memory escrow map: escrow state is returned to the caller in
		// the paymentUrl JSON and settled on-chain via attestation. (A prior
		// write-only Map grew unbounded and was never read — removed Sweep128.)
		return createEscrow(params);
	}

	getPaymentMethods(): PaymentMethod[] {
		return getPaymentMethods();
	}

	async verifySignature(
		body: unknown,
		_headers: Record<string, string>,
	): Promise<boolean> {
		// Fail closed: reject unless the attestation parses AND its signature
		// verifies against the configured evaluator address.
		const { attestation, error } = parseAttestation(body);
		if (error) return false;
		return verifyAttestationSignature(attestation);
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		return normalizeEvent(body, metadata);
	}
}
