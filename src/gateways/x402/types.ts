/**
 * x402 Protocol Types
 *
 * x402 is an open payment standard using HTTP 402 for on-chain USDC micropayments.
 * Reference: https://x402.org/
 */

/** A payment option accepted by the merchant */
export interface X402AcceptedPayment {
  scheme: 'exact' | 'minimum' | 'maximum' | 'range';
  /** CAIP-2 network identifier, e.g. "eip155:8453" for Base mainnet */
  network: string;
  /** Amount in smallest token unit (e.g. "1000000" = 1 USDC) */
  amount: string;
  /** Token contract address on the specified chain */
  asset: string;
  /** Recipient wallet address */
  payTo: string;
  /** Max seconds before payment requirement expires */
  maxTimeoutSeconds: number;
  /** Protocol-specific extras (fee payer on Solana, etc.) */
  extra?: Record<string, unknown>;
}

/** 402 Payment Required response body (also serialized in payment-required header) */
export interface X402PaymentRequirement {
  x402Version: number;
  error?: string;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepts: X402AcceptedPayment[];
  extensions?: Record<string, unknown>;
}

/** Payment proof sent by client in PAYMENT-SIGNATURE header */
export interface X402PaymentSignature {
  /** Network where payment was made */
  network: string;
  /** Transaction hash */
  txHash: string;
  /** Token asset address */
  asset: string;
  /** Amount paid (string in smallest unit) */
  amount: string;
  /** Payer wallet address */
  payer: string;
  /** Block number for verification */
  blockNumber?: number;
}

/** Result of on-chain payment verification */
export interface X402VerificationResult {
  verified: boolean;
  txHash?: string;
  sender?: string;
  amount?: string;
  /** Reason if verification failed */
  error?: string;
}

/** Supported x402 environments */
export type X402Env = 'sandbox' | 'production';

/** Default x402 constants */
export const X402_VERSION = 2;
export const X402_DEFAULT_TIMEOUT = 300; // 5 min

/**
 * Default USDC addresses per chain (CAIP-2).
 * These are well-known. Production installations should override via env.
 */
export const DEFAULT_USDC_ADDRESSES: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Base mainnet USDC
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base sepolia test USDC
  'eip155:1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',    // Ethereum mainnet USDC
};
