import { describe, expect, test } from "bun:test";

import type { NormalizedPaymentEvent } from "../../src/gateways/base";
import type { Order } from "../../src/services/order.service";
import { matchesPayment, reconcile } from "../../src/services/matcher.service";

const order = (overrides: Partial<Order> = {}): Order => ({
	id: "ord_1",
	project_id: "proj_1",
	merchant_id: "merch_1",
	project_order_id: null,
	callback_url: "https://example.com/webhook",
	gateway: "shopee",
	gateway_reference: null,
	amount: 50000,
	currency: "IDR",
	payment_method: "bank_transfer",
	payment_url: null,
	status: "pending",
	metadata: null,
	idempotency_key: null,
	unique_amount: null,
	last_polled_at: null,
	forward_attempts: 0,
	forward_status: null,
	created_at: "2026-10-27T10:00:00Z",
	updated_at: "2026-10-27T10:00:00Z",
	...overrides,
});

const event = (overrides: Partial<NormalizedPaymentEvent> = {}): NormalizedPaymentEvent => ({
	gateway: "shopee",
	order_id: "ord_1",
	gateway_reference: "ref_1",
	status: "success",
	amount: 50000,
	currency: "IDR",
	payment_method: "bank_transfer",
	paid_at: "2026-10-27T10:00:00Z",
	metadata: null,
	...overrides,
});

describe("matchesPayment", () => {
	test("matches on exact amount, settled status, in-window time", () => {
		expect(
			matchesPayment(order(), event()),
		).toBe(true);
	});

	test("unique_amount wins over base amount", () => {
		const o = order({ unique_amount: 50012 });
		expect(matchesPayment(o, event({ amount: 50012 }))).toBe(true);
		expect(matchesPayment(o, event({ amount: 50000 }))).toBe(false);
	});

	test("rejects short-money (event amount < target)", () => {
		expect(
			matchesPayment(order(), event({ amount: 40000 })),
		).toBe(false);
	});

	test("rejects overpay (strict equality)", () => {
		expect(matchesPayment(order(), event({ amount: 60000 }))).toBe(
			false,
		);
	});


test("rejects pending / failed / cancelled statuses", () => {
	for (const status of [
		"pending",
		"failed",
		"cancelled",
		"expired",
		"refunded",
	]) {
		expect(
			matchesPayment(
				order(),
				event({ status: status as NormalizedPaymentEvent["status"] }),
			),
		).toBe(false);
	}
});

	test("rejects paid outside time window", () => {
		const o = order({ created_at: "2026-10-27T09:00:00Z" });
		const e = event({ paid_at: "2026-10-27T10:30:00Z" });
		expect(matchesPayment(o, e, { clockSkewMs: 30000 })).toBe(false);
	});

	test("accepts paid within clock skew at window edges", () => {
		const o = order({ created_at: "2026-10-27T10:00:00Z" });
		// exactly skew seconds after creation
		const e = event({ paid_at: "2026-10-27T10:00:30.000Z" });
		expect(matchesPayment(o, e, { clockSkewMs: 30000 })).toBe(true);
	});

	test("uses now override for determinism", () => {
		const e = event({ paid_at: null });
		// now inside the window → match; now far outside → no match
		expect(
			matchesPayment(order(), e, {
				now: new Date("2026-10-27T10:00:10.000Z").getTime(),
			}),
		).toBe(true);
		expect(
			matchesPayment(order(), e, {
				now: new Date("2026-10-27T10:05:00.000Z").getTime(),
			}),
		).toBe(false);
	});

	test("allows custom clock skew", () => {
		const o = order({ created_at: "2026-10-27T10:00:00Z" });
		const e = event({ paid_at: "2026-10-27T10:01:00.000Z" });
		expect(matchesPayment(o, e, { clockSkewMs: 60000 })).toBe(true);
		expect(matchesPayment(o, e, { clockSkewMs: 1000 })).toBe(false);
	});

	test("rejects stale paid_at before creation", () => {
		const o = order({ created_at: "2026-10-27T10:00:00Z" });
		const e = event({ paid_at: "2026-10-27T09:55:00.000Z" });
		expect(matchesPayment(o, e)).toBe(false);
	});
});

describe("reconcile", () => {
	test("greedy match sorts by ascending unique_amount and consumes transactions", () => {
		const o1 = order({ id: "o1", unique_amount: 50001 });
		const o2 = order({ id: "o2", unique_amount: 50002 });
		const txs = [
			event({ order_id: "o2", amount: 50002 }),
			event({ order_id: "o1", amount: 50001 }),
		];
		const matches = reconcile([o1, o2], txs);
		expect(matches).toHaveLength(2);
		expect([matches[0].order.id, matches[1].order.id]).toEqual([
			"o1",
			"o2",
		]);
	});

	test("each transaction consumed once", () => {
		const o1 = order({ id: "o1", unique_amount: 50001 });
		const o2 = order({ id: "o2", unique_amount: 50001 });
		const txs = [event({ order_id: "o1", amount: 50001 })];
		const matches = reconcile([o1, o2], txs);
		expect(matches).toHaveLength(1);
		expect(matches[0].order.id).toBe("o1");
	});

	test("no matches when no pending orders", () => {
		expect(reconcile([], [event()])).toHaveLength(0);
	});

	test("no matches when no transactions", () => {
		expect(reconcile([order()], [])).toHaveLength(0);
	});

	test("reconcile respects clock skew default", () => {
		const o = order({
			created_at: "2026-10-27T10:00:00Z",
		});
		const e = event({ paid_at: "2026-10-27T10:00:45.000Z" });
		expect(reconcile([o], [e])).toHaveLength(0); // default 30s skew
		const matches = reconcile([o], [e], 60000);
		expect(matches).toHaveLength(1);
	});
});
