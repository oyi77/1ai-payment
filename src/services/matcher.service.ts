/**
 * Matcher service — pure, DB-free payment reconciliation.
 *
 * Port of paygateme's payment/matcher.go:
 * - amount equality (accepts real_amount when present) + settled-status
 *   check with fail-open on unknown/empty statuses + time window w/ skew.
 * - reconcile: sort pending by ascending unique_amount, greedy match, consume txs.
 *
 * Fail-open rationale: feed variations add new status labels silently; only
 * known-bad statuses (pending/failed/cancelled/expired/refunded) reject.
 * ponytail: add `capture` to statuses if a provider uses it; ceiling = one-line whitelist.
 */

import type { NormalizedPaymentEvent } from "../gateways/base";
import type { Order } from "./order.service";

export interface MatchOptions {
	clockSkewMs?: number;
	now?: number;
}

export interface Match {
	order: Order;
	event: NormalizedPaymentEvent;
}

// paygateme fails OPEN on status: only known-bad labels reject; unknown or
// empty labels accept. Feeds add status labels silently, and providers emit
// provider-prefixed tags (e.g. "shopee:5") — whitelist-reject would strand
// genuinely-paid transactions forever.
const REJECTED_STATUSES = new Set([
	"pending",
	"failed",
	"cancelled",
	"expired",
	"refunded",
]);
function statusAllowsSettle(status: string): boolean {
	const s = status.toLowerCase().trim();
	return !REJECTED_STATUSES.has(s);
}

const DEFAULT_CLOCK_SKEW_MS = 30000;

function expiresAtMs(order: Order): number | null {
	const expiresRaw =
		(order as Order & { expires_at?: string | null }).expires_at ??
		(order.metadata?.expires_at as string | undefined) ??
		null;
	return expiresRaw ? new Date(expiresRaw).getTime() : null;
}

export function matchesPayment(
	order: Order,
	event: NormalizedPaymentEvent,
	options: MatchOptions = {},
): boolean {
	const skew = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
	if (!statusAllowsSettle(event.status)) return false;

	const targetAmount = order.unique_amount ?? order.amount;
	// paygateme: accept real_gross when present (GoPay reports both gross & real_gross)
	if (event.amount > 0 && event.amount !== targetAmount) {
		if (event.real_amount != null && event.real_amount === targetAmount) {
			// real_amount wins if gross doesn't match but real_gross does
		} else {
			return false;
		}
	}

	const createdAt = new Date(order.created_at).getTime();
	const expiresAt = expiresAtMs(order);
	const paidAt = event.paid_at
		? new Date(event.paid_at).getTime()
		: (options.now ?? createdAt);

	const lower = createdAt - skew;
	const upper = (expiresAt ?? createdAt) + skew;
	if (paidAt < lower || paidAt > upper) return false;
	return true;
}

export function reconcile(
	pending: Order[],
	transactions: NormalizedPaymentEvent[],
	clockSkew: number = DEFAULT_CLOCK_SKEW_MS,
): Match[] {
	const sorted = [...pending].sort((a, b) => {
		const aa = a.unique_amount ?? a.amount;
		const bb = b.unique_amount ?? b.amount;
		return aa - bb;
	});

	const consumed = new Set<number>();
	const matches: Match[] = [];

	for (const order of sorted) {
		let foundIndex = -1;
		for (let i = 0; i < transactions.length; i++) {
			if (consumed.has(i)) continue;
			const tx = transactions[i];
			if (matchesPayment(order, tx, { clockSkewMs: clockSkew })) {
				foundIndex = i;
				break;
			}
		}
		if (foundIndex >= 0) {
			consumed.add(foundIndex);
			matches.push({ order, event: transactions[foundIndex] });
		}
	}

	return matches;
}
