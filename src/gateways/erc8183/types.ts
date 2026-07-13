/**
 * ERC-8183 Types — Agentic Commerce Escrow
 *
 * ERC-8183 enables AI agents to autonomously hire, verify, and settle
 * payments through trustless escrow with evaluator attestation.
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-8183
 */

/** Escrow lifecycle status */
export type EscrowStatus = 'pending' | 'funded' | 'in_progress' | 'completed' | 'attested' | 'released' | 'disputed' | 'cancelled';

/** A party in the escrow */
export interface EscrowParty {
  address: string;
  role: 'employer' | 'provider' | 'evaluator';
}

/** Escrow job specification */
export interface EscrowJob {
  title: string;
  description?: string;
  budget: string;
  token: string;
  network: string;
  deliverables?: string;
}

/** Full escrow entry */
export interface EscrowEntry {
  id: string;
  status: EscrowStatus;
  employer: string;
  provider: string;
  evaluator: string;
  job: EscrowJob;
  tokenAmount: string;
  tokenAddress: string;
  network: string;
  /** Unix timestamp when escrow expires */
  timeoutAt?: number;
  /** Hash of attestation proof (by evaluator) */
  attestationHash?: string;
  createdAt: string;
  updatedAt: string;
}

/** Create escrow params (from merchant) */
export interface CreateEscrowParams {
  employer: string;
  provider: string;
  evaluator: string;
  job: EscrowJob;
  timeoutMinutes?: number;
}

/** Attestation payload */
export interface EscrowAttestation {
  escrowId: string;
  evaluator: string;
  approved: boolean;
  signature?: string;
  notes?: string;
}

/** Default timeout for escrows */
export const DEFAULT_ESCROW_TIMEOUT_MINUTES = 1440; // 24h
