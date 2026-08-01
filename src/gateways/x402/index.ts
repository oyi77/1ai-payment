/**
 * x402 Gateway — on-chain USDC micropayments via HTTP 402 protocol
 *
 * Flow:
 * 1. Merchant creates payment via POST /api/payments with gateway=x402
 * 2. System returns x402 PaymentRequirements (wallet address, amount, chain info)
 * 3. Client pays USDC on-chain to the provided wallet
 * 4. Client calls POST /webhook/x402 with { order_id, tx_hash, network, asset, amount, payer }
 * 5. System verifies on-chain via RPC
 * 6. If valid, order marked success and event forwarded to merchant's callback_url
 *
 * @module x402
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
import { buildPaymentRequirement, getPaymentMethods } from "./payment";
import type { X402PaymentSignature } from "./types";
import {
	decodePaymentSignature,
	normalizeEvent,
	verifyAndCachePayment,
} from "./webhook";

export class X402Gateway implements PaymentGateway {
	readonly name = "x402";

	get enabled(): boolean {
		return Boolean(getConfig().X402_WALLET_ADDRESS);
	}

	async createPayment(
		params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		return buildPaymentRequirement(params);
	}

	getPaymentMethods(): PaymentMethod[] {
		return getPaymentMethods();
	}

	async verifySignature(
		body: unknown,
		headers: Record<string, string>,
	): Promise<boolean> {
		// x402 payments are verified ON-CHAIN — a payload is only accepted
		// when a real USDC transfer to the merchant wallet is confirmed via
		// RPC. The client's declared verified/asset/amount fields are not
		// trusted, and missing credentials always fail closed.
		const { signature, error } = decodePaymentSignature(body);
		if (error) return false;

		// Verify environment matches
		if (signature.network && !signature.network.includes("eip155:")) {
			return false;
		}

		// Fail closed without credentials — nothing to verify against.
		const cfg = getConfig() as unknown as Record<string, string | undefined>;
		if (!cfg.X402_WALLET_ADDRESS) return false;

		const result = await verifyAndCachePayment(signature);
		return result.verified;
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		return normalizeEvent(body, metadata);
	}
}
