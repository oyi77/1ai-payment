/**
 * Matcher service — pure, DB-free payment reconciliation.
 *
 * matchesPayment: amount equality + settled-status whitelist + time window with clock skew.
 * reconcile: sort pending by ascending unique_amount, greedy match, consume transactions.
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

const SETTLED_STATUSES: Record<string, true> = {
	success: true,
	paid: true,
	completed: true,
	settled: true,
};

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
	if (!SETTLED_STATUSES[event.status]) return false;

	const targetAmount = order.unique_amount ?? order.amount;
	if (event.amount > 0 && event.amount !== targetAmount) return false;

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
