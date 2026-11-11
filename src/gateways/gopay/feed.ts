/**
 * GoPay transaction-feed normalization — ported from paygateme/gopay/feed.go.
 *
 * ⚠️ EXPERIMENTAL: pure normalization only. Network fetch lives in provider.ts.
 */

import type { MerchantTransaction } from "../base";
import { TRANSACTION_AMOUNT_SCALE } from "./constants";

/** Raw feed transaction (merchant-analytics v2). */
export interface RawGoPayTransaction {
	id: string;
	order_id: string;
	merchant_id: string;
	transaction_status: string;
	payment_type: string;
	gross_amount: number;
	real_gross_amount: number;
	currency: string;
	transaction_time: string;
	settlement_time: string;
	transaction_source: string;
}

/**
 * toWholeRupiah — converts a feed amount from minor units to whole rupiah.
 * The feed sends 300100 for Rp 3.001. Division is exact: a value that is not
 * whole rupiah stays fractional and fails to match a whole-rupiah payment
 * intent, which is the safe outcome.
 */
export function toWholeRupiah(minorUnits: number): number {
	if (!Number.isFinite(minorUnits)) return 0;
	return Math.trunc(minorUnits / TRANSACTION_AMOUNT_SCALE);
}

/** parseTimeOrZero — RFC3339 parse; returns epoch-ms 0 when unparseable. */
function parseTimeOrZero(s: string): string {
	const t = Date.parse(s);
	return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

/**
 * normalizeGoPayTransaction — wire shape → normalized MerchantTransaction.
 * Amounts divided by 100 (minor units → whole rupiah); real_gross kept
 * alongside gross for the matcher's dual-amount acceptance.
 */
export function normalizeGoPayTransaction(
	raw: RawGoPayTransaction,
): MerchantTransaction {
	const currency = raw.currency || "IDR";
	return {
		transaction_id: raw.id,
		amount: toWholeRupiah(raw.gross_amount),
		real_amount: toWholeRupiah(raw.real_gross_amount),
		status: raw.transaction_status,
		created_at: parseTimeOrZero(raw.transaction_time),
		raw,
	};
}
