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
import { listOrders, updateOrderPolled, updateOrderStatus } from "./order.service";
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

				// paygateme parity: scope the feed fetch per merchant and dedupe
				// consumed transactions so a settled tx never settles twice.
				const consumedTxIds = new Set<string>();
				const merchantIds = [
					...new Set(
						pendingOrders
							.map((o) => o.merchant_id)
							.filter((m): m is string => Boolean(m)),
					),
				];
				if (merchantIds.length === 0) merchantIds.push("merch_default");

				for (const merchantId of merchantIds) {
					const merchantOrders = pendingOrders.filter(
						(o) => (o.merchant_id ?? "merch_default") === merchantId,
					);
					if (merchantOrders.length === 0) continue;

					let transactions: MerchantTransaction[];
					try {
						transactions = await gw.fetchRecentTransactions({ merchantId });
					} catch (fetchErr: unknown) {
						logger.error("Poller: gateway fetchRecentTransactions failed", {
							gateway: name,
							merchantId,
							error:
								fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
						});
						continue;
					}

					const fresh = transactions.filter((t) => !consumedTxIds.has(t.transaction_id));
					polledCount += fresh.length;

					for (const tx of fresh) {
						const event: NormalizedPaymentEvent = {
							gateway: name,
							order_id: tx.transaction_id,
							gateway_reference: tx.transaction_id,
							status: "success",
							amount: tx.amount,
							real_amount: tx.real_amount,
							currency: "IDR",
							payment_method: name,
							paid_at: tx.created_at,
							metadata: null,
						};

						for (const order of merchantOrders) {
							if (order.status !== "pending") continue;
							if (!matchesPayment(order, event, { clockSkewMs })) continue;

							consumedTxIds.add(tx.transaction_id);
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
				}

				// Expiry sweep: paygateme runs matching BEFORE expiry. A payment is
				// only expired once expires_at + skew has passed — the exact moment
				// the matcher stops accepting transactions for it.
				const now = Date.now();
				for (const order of pendingOrders) {
					if (order.status !== "pending") continue;
					const expiresRaw =
						(order as Order & { expires_at?: string | null }).expires_at ??
						(order.metadata?.expires_at as string | undefined);
					if (!expiresRaw) continue;
					const exp = new Date(expiresRaw).getTime();
					if (!Number.isNaN(exp) && exp + clockSkewMs <= now) {
						try {
							await updateOrderStatus(order.id, "expired");
							logger.info("Poller: order expired", {
								order_id: order.id,
								status: order.status,
							});
						} catch (expErr: unknown) {
							logger.error("Poller: expire failed", {
								order_id: order.id,
								error: expErr instanceof Error ? expErr.message : String(expErr),
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
