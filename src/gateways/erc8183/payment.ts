import { randomUUID } from "node:crypto";
import { getConfig, resolveGatewayConfig } from "../../config/env";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	PaymentMethod,
} from "../base";
import type { CreateEscrowParams, EscrowEntry, EscrowJob } from "./types";
import { DEFAULT_ESCROW_TIMEOUT_MINUTES } from "./types";

/**
 * Extract escrow params from CreatePaymentParams.metadata
 */
function extractEscrowParams(params: CreatePaymentParams): CreateEscrowParams {
	const meta = (params.metadata || {}) as Record<string, unknown>;

	return {
		employer: String(meta.employer || meta.employer_address || ""),
		provider: String(meta.provider || meta.provider_address || ""),
		evaluator: String(meta.evaluator || meta.evaluator_address || ""),
		job: {
			title: String(meta.job_title || meta.title || "ERC-8183 Escrow"),
			description: String(meta.job_description || meta.description || ""),
			budget: String(params.amount),
			token: String(meta.token_address || ""),
			network: String(meta.network || "eip155:8453"),
			deliverables: String(meta.deliverables || ""),
		},
		timeoutMinutes:
			Number(meta.timeout_minutes) || DEFAULT_ESCROW_TIMEOUT_MINUTES,
	};
}

/**
 * Build the escrow entry - for MVP we create a local record
 * In production, this would deploy/use an ERC-8183 escrow contract
 */
export async function createEscrow(
	params: CreatePaymentParams,
): Promise<CreatePaymentResult> {
	const escrowParams = extractEscrowParams(params);
	// Merchant-owned treasury overrides (platform wallets are the fallback)
	const mCfg = params.merchantId
		? ((await resolveGatewayConfig(
				"erc8183",
				params.merchantId,
			)) as unknown as {
				walletAddress?: string;
				tokenAddress?: string;
				network?: string;
				evaluatorAddress?: string;
			})
		: null;
	if (mCfg?.tokenAddress && !escrowParams.job.token)
		escrowParams.job.token = mCfg.tokenAddress;
	if (mCfg?.network) escrowParams.job.network = mCfg.network;
	const escrowId = params.orderId || `escrow-${randomUUID().slice(0, 8)}`;

	const escrow: EscrowEntry = {
		id: escrowId,
		status: "pending",
		employer: escrowParams.employer,
		provider: escrowParams.provider,
		evaluator: escrowParams.evaluator,
		job: escrowParams.job,
		tokenAmount: String(params.amount),
		tokenAddress: escrowParams.job.token,
		network: escrowParams.job.network,
		timeoutAt: escrowParams.timeoutMinutes
			? Math.floor(Date.now() / 1000) + escrowParams.timeoutMinutes * 60
			: undefined,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	// Return as payment URL (escrow details for the client)
	return {
		gatewayReference: escrowId,
		paymentUrl: JSON.stringify(escrow),
		expiresAt: escrow.timeoutAt
			? new Date(escrow.timeoutAt * 1000).toISOString()
			: undefined,
	};
}

/** Get available payment methods for ERC-8183 */
export function getPaymentMethods(): PaymentMethod[] {
	return [
		{
			code: "erc8183_escrow",
			name: "ERC-8183 Agentic Commerce Escrow",
			currencies: ["USD"],
		},
	];
}
