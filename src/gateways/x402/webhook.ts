/**
 * x402 Webhook & On-Chain Verification
 *
 * x402 uses HTTP 402 with on-chain USDC micropayments.
 * Verification flow:
 *   1. Client pays USDC on-chain to the merchant's wallet
 *   2. Client sends POST /webhook/x402 with the tx hash and order id
 *   3. System verifies the on-chain transaction via RPC using viem
 *   4. If valid, marks order paid and forwards to callback_url
 *
 * Verification is REAL on-chain verification — the client's declared
 * asset/amount/payer fields are NOT trusted. The expected USDC contract
 * is resolved from config (X402_USDC_ADDRESS) or the per-chain default,
 * and the transfer must land in the configured merchant wallet
 * (X402_WALLET_ADDRESS) for at least the declared amount. Verified
 * results are cached (keyed by tx hash, 5-minute TTL) so that
 * normalizeEvent reports the actual on-chain amount instead of trusting
 * the client's `verified` flag.
 */

import {
	http,
	type Chain,
	createPublicClient,
	decodeEventLog,
	encodeEventTopics,
	erc20Abi,
	getAddress,
	isAddress,
} from "viem";
import { base, baseSepolia, mainnet } from "viem/chains";
import { getConfig } from "../../config/env";
import { logger } from "../../utils/logger";
import type { NormalizedPaymentEvent, PaymentStatus } from "../base";
import {
	DEFAULT_USDC_ADDRESSES,
	type X402PaymentSignature,
	type X402VerificationResult,
} from "./types";

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

/**
 * Resolve the expected USDC contract for a network.
 *
 * The client-supplied asset field is not trusted — the expected token
 * comes from X402_USDC_ADDRESS config, falling back to the per-network
 * default USDC address.
 */
function resolveAsset(network: string): string | undefined {
	const cfg = getConfig() as unknown as Record<string, string | undefined>;
	const configured = cfg.X402_USDC_ADDRESS;
	if (configured && isAddress(configured)) return getAddress(configured);
	const fallback = DEFAULT_USDC_ADDRESSES[network];
	if (fallback) return getAddress(fallback);
	return undefined;
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
 * the resolved USDC contract and the merchant's wallet, and checks the
 * amount meets the declared value. The client-supplied asset and payer
 * fields are not trusted for the transfer lookup — the expected token
 * comes from config, and the recipient must be the merchant wallet.
 */
export async function verifyPayment(
	signature: X402PaymentSignature,
): Promise<X402VerificationResult> {
	try {
		// The client's declared asset is not trusted — resolve the expected
		// USDC contract for the network from config / defaults.
		const expectedAsset = resolveAsset(signature.network);
		if (!expectedAsset) {
			return {
				verified: false,
				error: `No USDC asset configured for network: ${signature.network}`,
			};
		}

		// Declared amount must be a positive integer in smallest units.
		if (!/^\d+$/.test(signature.amount) || BigInt(signature.amount) <= 0n) {
			return { verified: false, error: "Invalid declared amount" };
		}

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
			if (log.address.toLowerCase() !== expectedAsset.toLowerCase()) continue;
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

				if (recipient !== expectedRecipient) continue;
				if (value < expectedAmount) continue;

				// If the client declared a payer, the on-chain sender must match.
				if (signature.payer && isAddress(signature.payer)) {
					if (sender !== signature.payer.toLowerCase()) {
						return {
							verified: false,
							error: "Payment sender does not match declared payer",
						};
					}
				}

				return {
					verified: true,
					txHash: signature.txHash,
					sender,
					amount: value.toString(),
				};
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

/** Cached on-chain verification result, keyed by lowercase tx hash */
interface CachedVerification {
	verified: boolean;
	amount?: string;
	sender?: string;
	txHash?: string;
	ts: number;
}

const VERIFICATION_TTL_MS = 300_000; // 5 minutes
const verificationCache = new Map<string, CachedVerification>();

/**
 * Verify a payment signature and cache the result on success so that
 * normalizeEvent (called later in the same webhook request) reports the
 * verified status and actual on-chain amount.
 */
export async function verifyAndCachePayment(
	signature: X402PaymentSignature,
): Promise<X402VerificationResult> {
	const result = await verifyPayment(signature);
	if (result.verified && result.txHash) {
		pruneVerificationCache();
		verificationCache.set(result.txHash.toLowerCase(), {
			verified: true,
			amount: result.amount,
			sender: result.sender,
			txHash: result.txHash,
			ts: Date.now(),
		});
	}
	return result;
}

/** Drop expired verification entries */
function pruneVerificationCache(): void {
	const now = Date.now();
	for (const [key, entry] of verificationCache) {
		if (now - entry.ts > VERIFICATION_TTL_MS) verificationCache.delete(key);
	}
}

/**
 * Look up a cached verification result for a tx hash.
 * Returns null when nothing is cached or the entry has expired.
 */
export function getCachedVerification(
	txHash: string,
): CachedVerification | null {
	if (!txHash) return null;
	const key = txHash.toLowerCase();
	const entry = verificationCache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.ts > VERIFICATION_TTL_MS) {
		verificationCache.delete(key);
		return null;
	}
	return entry;
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
 * The `verified` flag from the client is never trusted. Status comes from
 * the on-chain verification cache (populated by verifyAndCachePayment):
 * a verified transfer reports success with the actual on-chain amount
 * (converted from the smallest unit, e.g. 1_000_000 = 1 USDC); otherwise
 * the event stays pending with the declared amount.
 */
export function normalizeEvent(
	body: unknown,
	metadata?: Record<string, unknown> | null,
): NormalizedPaymentEvent {
	const data =
		typeof body === "string"
			? JSON.parse(body)
			: (body as Record<string, unknown>);
	const txHash = String(data.tx_hash || data.txHash || "");
	const cached = getCachedVerification(txHash);

	let status: PaymentStatus = "pending";
	let amount: number;
	let paidAt: string | null = null;

	if (cached?.verified && cached.amount) {
		status = "success";
		amount = Math.round(Number(cached.amount) / 1_000_000);
		paidAt = new Date().toISOString();
	} else {
		amount =
			typeof data.amount === "string"
				? Math.round(Number(data.amount) / 1_000_000)
				: typeof data.amount === "number"
					? data.amount
					: 0;
	}

	return {
		gateway: "x402",
		order_id: String(data.order_id || ""),
		gateway_reference: txHash,
		status,
		amount,
		currency: "USD",
		payment_method: String(data.network || "x402"),
		paid_at: paidAt,
		metadata: metadata || null,
	};
}
