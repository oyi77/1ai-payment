/**
 * x402 Webhook & On-Chain Verification
 *
 * x402 uses HTTP 402 with on-chain USDC micropayments.
 * Verification flow:
 *   1. Client pays USDC on-chain to the merchant's wallet
 *   2. Client sends POST /webhook/x402 with the tx hash and order id
 *   3. System verifies the on-chain transaction via RPC using viem
 *   4. If valid, marks order paid and forwards to callback_url
 */

import {
	http,
	type Chain,
	createPublicClient,
	decodeEventLog,
	encodeEventTopics,
	erc20Abi,
	getAddress,
} from "viem";
import { base, baseSepolia, mainnet } from "viem/chains";
import { getConfig } from "../../config/env";
import { logger } from "../../utils/logger";
import type { NormalizedPaymentEvent } from "../base";
import type { X402PaymentSignature, X402VerificationResult } from "./types";

/** Map CAIP-2 network string to viem Chain */
function networkToChain(network: string): Chain {
	switch (network) {
		case "eip155:8453":
			return base;
		case "eip155:84532":
			return baseSepolia;
		case "eip155:1":
			return mainnet;
		default:
			throw new Error(`Unsupported x402 network: ${network}`);
	}
}

/** Get RPC URL for a network — falls back to public endpoints */
function getRpcUrl(network: string): string | undefined {
	const cfg = getConfig() as unknown as Record<string, string | undefined>;
	const urls: Record<string, string> = {
		"eip155:8453": cfg.X402_RPC_URL || "https://mainnet.base.org",
		"eip155:84532": cfg.X402_RPC_URL || "https://sepolia.base.org",
		"eip155:1": cfg.X402_RPC_URL || "https://cloudflare-eth.com",
	};
	return urls[network];
}

/** Get the merchant's configured wallet address for receiving payments */
function getMerchantWallet(): string {
	const cfg = getConfig() as unknown as Record<string, string | undefined>;
	const addr = cfg.X402_WALLET_ADDRESS;
	if (!addr) {
		throw new Error("X402_WALLET_ADDRESS is not configured");
	}
	return getAddress(addr);
}

/** Minimal shape needed from a transaction receipt log */
interface ReceiptLog {
	address: string;
	topics: [`0x${string}`, ...`0x${string}`[]];
	data: `0x${string}`;
}

/** Minimal shape needed from a transaction receipt */
interface ReceiptView {
	status: string;
	logs: ReceiptLog[];
}

/**
 * Verify a USDC transfer on-chain.
 *
 * Fetches the transaction receipt, finds the USDC Transfer log matching
 * the merchant's wallet, and checks the amount meets the expected value.
 */
export async function verifyPayment(
	signature: X402PaymentSignature,
): Promise<X402VerificationResult> {
	try {
		const chain = networkToChain(signature.network);
		const rpcUrl = getRpcUrl(signature.network);

		if (!rpcUrl) {
			return {
				verified: false,
				error: `No RPC URL for network: ${signature.network}`,
			};
		}

		const client = createPublicClient({
			chain,
			transport: http(rpcUrl),
		});

		// Get and cast the transaction receipt to access log details
		const tx = (await client.getTransactionReceipt({
			hash: signature.txHash as `0x${string}`,
		})) as unknown as ReceiptView;

		if (!tx) {
			return { verified: false, error: "Transaction not found" };
		}

		// Verify transaction status
		if (tx.status !== "success") {
			return { verified: false, error: "Transaction failed on-chain" };
		}

		// Encode the Transfer event topic to match against logs
		const transferTopic = encodeEventTopics({
			abi: erc20Abi,
			eventName: "Transfer",
		})[0];

		const expectedRecipient = getMerchantWallet().toLowerCase();
		const expectedAmount = BigInt(signature.amount);

		for (const log of tx.logs) {
			// Skip logs from non-target contracts
			if (log.address.toLowerCase() !== signature.asset.toLowerCase()) continue;
			// Skip non-Transfer events
			if (log.topics[0] !== transferTopic) continue;

			try {
				const decoded = decodeEventLog({
					abi: erc20Abi,
					data: log.data,
					topics: log.topics,
					eventName: "Transfer",
				});

				const args = decoded.args as {
					from: string;
					to: string;
					value: bigint;
				};
				const sender = args.from?.toLowerCase();
				const recipient = args.to?.toLowerCase();
				const value = args.value;

				if (recipient === expectedRecipient && value >= expectedAmount) {
					return {
						verified: true,
						txHash: signature.txHash,
						sender,
						amount: value.toString(),
					};
				}
			} catch {}
		}

		return {
			verified: false,
			error: "No matching USDC Transfer to merchant wallet found in tx",
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("x402 verification failed", { err: msg });
		return { verified: false, error: msg };
	}
}

/**
 * Decode a PaymentSignature from raw HTTP header/body.
 *
 * Accepts either a parsed object or a JSON string.
 * Returns the decoded signature plus an optional error message.
 */
export function decodePaymentSignature(raw: unknown): {
	signature: X402PaymentSignature;
	error?: string;
} {
	try {
		const data = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!data || typeof data !== "object") throw new Error("Invalid payload");

		const sig: X402PaymentSignature = {
			network: String(data.network || ""),
			txHash: String(data.tx_hash || data.txHash || ""),
			asset: String(data.asset || ""),
			amount: String(data.amount || "0"),
			payer: String(data.payer || data.sender || ""),
		};

		if (!sig.network) return { signature: sig, error: "Missing network" };
		if (!sig.txHash) return { signature: sig, error: "Missing tx_hash" };
		if (!sig.asset) return { signature: sig, error: "Missing asset" };

		return { signature: sig };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			signature: { network: "", txHash: "", asset: "", amount: "0", payer: "" },
			error: msg,
		};
	}
}

/**
 * Normalize x402 payment verification to our standard event format.
 *
 * Converts from the smallest unit (e.g. 1_000_000 = 1 USDC) to whole
 * currency units stored as a number on NormalizedPaymentEvent.
 */
export function normalizeEvent(
	body: unknown,
	metadata?: Record<string, unknown> | null,
): NormalizedPaymentEvent {
	const data =
		typeof body === "string"
			? JSON.parse(body)
			: (body as Record<string, unknown>);
	const amount =
		typeof data.amount === "string"
			? Math.round(Number(data.amount) / 1_000_000)
			: typeof data.amount === "number"
				? data.amount
				: 0;

	return {
		gateway: "x402",
		order_id: String(data.order_id || ""),
		gateway_reference: String(data.tx_hash || data.txHash || ""),
		status: data.verified ? "success" : "pending",
		amount,
		currency: "USD",
		payment_method: String(data.network || "x402"),
		paid_at: data.verified ? new Date().toISOString() : null,
		metadata: metadata || null,
	};
}
