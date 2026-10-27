/**
 * PollerService — background polling for FeedGateway-capable gateways.
 *
 * Scans each registered gateway implementing FeedGateway for recent
 * transactions, matches them against active pending orders using
 * clock-skew tolerance, and settles matching orders via settleOrder.
 */

import { isFeedGateway } from "../gateways/base";
import type {
	FeedGateway,
	MerchantTransaction,
	NormalizedPaymentEvent,
} from "../gateways/base";
import { getGateway, getGatewayNames } from "../gateways/index";
import { logger } from "../utils/logger";
import { matchesPayment } from "./matcher.service";
import { settleOrder } from "./order-settlement.service";
import { listOrders, updateOrderPolled } from "./order.service";
import type { Order } from "./order.service";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_CLOCK_SKEW_MS = 30_000;

export class PollerService {
	private timer: Timer | null = null;

	private getIntervalMs(): number {
		const raw = process.env.POLLER_INTERVAL_MS;
		if (raw) {
			const parsed = Number(raw);
			if (!Number.isNaN(parsed) && parsed > 0) return parsed;
		}
		return DEFAULT_INTERVAL_MS;
	}

	private getClockSkewMs(): number {
		const raw = process.env.POLLER_CLOCK_SKEW_MS;
		if (raw) {
			const parsed = Number(raw);
			if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
		}
		return DEFAULT_CLOCK_SKEW_MS;
	}

	startPoller(): void {
		if (this.timer) return;
		const interval = this.getIntervalMs();
		logger.info(`Poller: starting (interval=${interval}ms)`);
		this.tickPoller().catch((err: unknown) => {
			logger.error("Poller: initial tick failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
		const handle = setInterval(() => {
			this.tickPoller().catch((err: unknown) => {
				logger.error("Poller: interval tick failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, interval);
		if (typeof handle.unref === "function") {
			handle.unref();
		}
		this.timer = handle;
	}

	stopPoller(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			logger.info("Poller: stopped");
		}
	}

	async tickPoller(): Promise<{ polled: number; settled: number }> {
		const clockSkewMs = this.getClockSkewMs();
		let polledCount = 0;
		let settledCount = 0;

		const gatewayNames = getGatewayNames();
		for (const name of gatewayNames) {
			const gw = getGateway(name);
			if (!gw || !isFeedGateway(gw)) continue;

			try {
				const { orders: pendingOrders } = await listOrders({
					gateway: name,
					status: "pending",
					limit: 100,
				});

				if (pendingOrders.length === 0) continue;

				let transactions: MerchantTransaction[];
				try {
					transactions = await gw.fetchRecentTransactions();
				} catch (fetchErr: unknown) {
					logger.error("Poller: gateway fetchRecentTransactions failed", {
						gateway: name,
						error:
							fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
					});
					continue;
				}

				polledCount += transactions.length;

				for (const tx of transactions) {
					const event: NormalizedPaymentEvent = {
						gateway: name,
						order_id: tx.transaction_id,
						gateway_reference: tx.transaction_id,
						status: "success",
						amount: tx.amount,
						currency: "IDR",
						payment_method: name,
						paid_at: tx.created_at,
						metadata: null,
					};

					for (const order of pendingOrders) {
						if (order.status !== "pending") continue;
						const matched = matchesPayment(order, event, { clockSkewMs });
						if (!matched) continue;

						try {
							await settleOrder({ order, event, gatewayName: name });
							settledCount++;
							order.status = "success";
						} catch (settleErr: unknown) {
							logger.error("Poller: settleOrder failed", {
								order_id: order.id,
								error:
									settleErr instanceof Error
										? settleErr.message
										: String(settleErr),
							});
						}

						try {
							await updateOrderPolled(order.id);
						} catch (updateErr: unknown) {
							logger.error("Poller: updateOrderPolled failed", {
								order_id: order.id,
								error:
									updateErr instanceof Error
										? updateErr.message
										: String(updateErr),
							});
						}
					}
				}
			} catch (gwErr: unknown) {
				logger.error("Poller: gateway execution failed", {
					gateway: name,
					error: gwErr instanceof Error ? gwErr.message : String(gwErr),
				});
			}
		}

		return { polled: polledCount, settled: settledCount };
	}
}

const defaultPoller = new PollerService();

export function startPoller(): void {
	defaultPoller.startPoller();
}

export function stopPoller(): void {
	defaultPoller.stopPoller();
}

export async function tickPoller(): Promise<{
	polled: number;
	settled: number;
}> {
	return defaultPoller.tickPoller();
}
