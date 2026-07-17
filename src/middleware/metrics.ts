/**
 * Prometheus metrics middleware —
 * counters for payments, webhooks, errors, and latency histograms.
 *
 * Exposed at GET /metrics (no auth, no rate limit).
 */

import client from "prom-client";
import { getConfig } from "../config/env";

const register = new client.Registry();

client.collectDefaultMetrics({ register });

// --- Counters ---

export const paymentsCreatedCounter = new client.Counter({
	name: "payments_created_total",
	help: "Total payment orders created",
	labelNames: ["gateway", "status"] as const,
	registers: [register],
});

export const webhooksReceivedCounter = new client.Counter({
	name: "webhooks_received_total",
	help: "Total webhook callbacks received",
	labelNames: ["gateway", "status"] as const,
	registers: [register],
});

export const forwardFailuresCounter = new client.Counter({
	name: "forward_failures_total",
	help: "Total forward attempts that failed",
	labelNames: ["gateway"] as const,
	registers: [register],
});

export const errorsCounter = new client.Counter({
	name: "errors_total",
	help: "Total application errors by type",
	labelNames: ["type"] as const,
	registers: [register],
});

// --- Histograms ---

export const paymentCreationDuration = new client.Histogram({
	name: "payment_creation_duration_seconds",
	help: "Latency of payment creation calls",
	labelNames: ["gateway"] as const,
	buckets: [0.1, 0.5, 1, 2, 5, 10],
	registers: [register],
});

export async function metricsHandler(): Promise<Response> {
	if (getConfig().NODE_ENV === "test") return new Response("", { status: 200 });
	return new Response(await register.metrics(), {
		status: 200,
		headers: { "Content-Type": register.contentType },
	});
}
