/**
 * x402 Payment Module — micropayment payment requirement generation.
 *
 * Builds x402-compatible PaymentRequirements from CreatePaymentParams.
 * The paymentUrl returned IS the PaymentRequirements JSON, consumed
 * by wallets supporting x402 protocol.
 */

import { getConfig } from "../../config/env";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	PaymentMethod,
} from "../base";
import type { X402AcceptedPayment, X402PaymentRequirement } from "./types";
import {
	DEFAULT_USDC_ADDRESSES,
	X402_DEFAULT_TIMEOUT,
	X402_VERSION,
} from "./types";

/**
 * Pick the appropriate payment network for the given amount.
 * Defaults to eip155:8453 (Base) if X402_NETWORK not configured.
 */
function pickNetwork(amount: number): string {
	const cfg = getConfig();
	return cfg.X402_NETWORK || "eip155:8453";
}

/** Convert amount to USDC smallest unit (6 decimals) */
function toUSDCUnit(amount: number): string {
	return BigInt(Math.round(amount * 1_000_000)).toString();
}

/**
 * Build x402 PaymentRequirements for a CreatePaymentParams request
 */
export async function buildPaymentRequirement(
	params: CreatePaymentParams,
): Promise<CreatePaymentResult> {
	const network = pickNetwork(params.amount);
	const cfg = getConfig();
	const payTo = cfg.X402_WALLET_ADDRESS;
	const asset = cfg.X402_USDC_ADDRESS || DEFAULT_USDC_ADDRESSES[network] || "";
	const usdcAmount = toUSDCUnit(params.amount);

	if (!payTo) throw new Error("X402_WALLET_ADDRESS is not configured");
	if (!asset)
		throw new Error(`No USDC address configured for network: ${network}`);

	const accepts: X402AcceptedPayment[] = [
		{
			scheme: "exact",
			network,
			amount: usdcAmount,
			asset,
			payTo,
			maxTimeoutSeconds: X402_DEFAULT_TIMEOUT,
		},
	];

	const paymentRequirement: X402PaymentRequirement = {
		x402Version: X402_VERSION,
		resource: {
			url: `https://pay.berkahkarya.org/api/payments/${params.orderId}/status`,
			description: `Payment of ${params.amount} USDC`,
		},
		accepts,
	};

	return {
		gatewayReference: params.orderId,
		paymentUrl: JSON.stringify(paymentRequirement),
		expiresAt: new Date(Date.now() + X402_DEFAULT_TIMEOUT * 1000).toISOString(),
	};
}

/** Get available payment methods for x402 */
export function getPaymentMethods(): PaymentMethod[] {
	return [
		{
			code: "usdc_base",
			name: "USDC on Base",
			currencies: ["USD"],
		},
		{
			code: "usdc_ethereum",
			name: "USDC on Ethereum",
			currencies: ["USD"],
		},
	];
}
