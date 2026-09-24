/**
 * x402 Payment Module — micropayment payment requirement generation.
 *
 * Builds x402-compatible PaymentRequirements from CreatePaymentParams.
 * The paymentUrl returned IS the PaymentRequirements JSON, consumed
 * by wallets supporting x402 protocol.
 */

import { getConfig, resolveGatewayConfig } from "../../config/env";
import { GatewayError } from "../../utils/errors";
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
function pickNetwork(_amount: number): string {
	return getConfig().X402_NETWORK || "eip155:8453";
}

/** Convert amount to USDC smallest unit (6 decimals).
 *
 * params.amount is MINOR units (cents) — same contract as PayPal/NOWPayments.
 * Divide by 100 first (Sweep112: the old code treated cents as dollars and
 * overcharged 100x — a $10 order billed 1000 USDC). IDR has no cents, but
 * x402 settles in USDC so IDR orders are rejected by the currency guard in
 * the gateway class (methods list USD only).
 */
function toUSDCUnit(amount: number): string {
	return BigInt(Math.round((amount / 100) * 1_000_000)).toString();
}

/**
 * Build x402 PaymentRequirements for a CreatePaymentParams request
 */
export async function buildPaymentRequirement(
	params: CreatePaymentParams,
): Promise<CreatePaymentResult> {
	// x402 settles in USDC (USD only per getPaymentMethods). An IDR amount
	// passed through unconverted would bill rupiah-nominal as USDC.
	if ((params.currency ?? "USD").toUpperCase() !== "USD") {
		throw new GatewayError(
			"x402",
			`x402 settles USDC only, got currency ${params.currency}`,
		);
	}
	const network = pickNetwork(params.amount);
	const cfg = getConfig();
	const mCfg = params.merchantId
		? ((await resolveGatewayConfig("x402", params.merchantId)) as unknown as {
				walletAddress?: string;
				usdcAddress?: string;
				network?: string;
				rpcUrl?: string;
			})
		: null;
	const payTo = mCfg?.walletAddress || cfg.X402_WALLET_ADDRESS;
	const asset =
		mCfg?.usdcAddress ||
		cfg.X402_USDC_ADDRESS ||
		DEFAULT_USDC_ADDRESSES[network] ||
		"";
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
			url: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/payments/${params.orderId}/status`,
			description: `Payment of ${(params.amount / 100).toFixed(2)} USDC`,
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
