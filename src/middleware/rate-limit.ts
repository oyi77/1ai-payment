/**
 * Rate limiting middleware — per-merchant with plan tiers.
 *
 * Keys by merchant_id (from auth context), falls back to IP.
 * Plan tiers: free=30/min, pro=120/min, enterprise=600/min (API).
 *
 * EVICTION: stale entries are deleted via setTimeout after windowMs.
 */

import type { Context, Next } from "hono";

interface RateLimitOptions {
	windowMs: number;
	max: number;
}

const PLAN_LIMITS: Record<string, number> = {
	free: 30,
	pro: 120,
	enterprise: 600,
};

const counters = new Map<string, { count: number; resetAt: number }>();

function scheduleEviction(key: string, delayMs: number): void {
	setTimeout(() => {
		counters.delete(key);
	}, delayMs).unref();
}

export function rateLimitMiddleware(options: RateLimitOptions) {
	return async (c: Context, next: Next) => {
		const merchantId = c.get("merchantId") as string | undefined;
		const merchantPlan = c.get("merchantPlan") as string | undefined;

		// Key by merchant if available, else by IP
		const ip =
			c.req.header("X-Forwarded-For") ||
			c.req.header("CF-Connecting-IP") ||
			"unknown";
		const key = merchantId || ip;

		// Use plan-based limit if available, else use configured max
		const planLimit = merchantPlan ? PLAN_LIMITS[merchantPlan] : undefined;
		const maxLimit = planLimit ?? options.max;

		const now = Date.now();
		const entry = counters.get(key);

		if (!entry || now > entry.resetAt) {
			counters.set(key, { count: 1, resetAt: now + options.windowMs });
			scheduleEviction(key, options.windowMs);
			await next();
			return;
		}

		entry.count++;

		if (entry.count > maxLimit) {
			c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
			return c.json(
				{
					success: false as const,
					error: { code: "RATE_LIMITED", message: "Too many requests" },
				},
				429,
			);
		}

		await next();
	};
}
