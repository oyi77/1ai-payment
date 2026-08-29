/**
 * Rate limiting middleware — per-merchant with plan tiers.
 *
 * Keys by merchant_id (from auth context), falls back to IP.
 * Plan tiers: free=30/min, pro=120/min, enterprise=600/min (API).
 *
 * EVICTION: stale entries are deleted via setTimeout after windowMs.
 * Counters are per-middleware-instance, so separate `app.use` mounts
 * (register / api / webhook) do not share or clobber each other's state.
 */

import type { Context, Next } from "hono";

interface RateLimitOptions {
	windowMs: number;
	max: number;
}

interface CounterEntry {
	count: number;
	resetAt: number;
}

const PLAN_LIMITS: Record<string, number> = {
	free: 30,
	pro: 120,
	enterprise: 600,
};

/**
 * Best-effort client IP extraction.
 *
 * - If TRUST_PROXY is enabled, honor the leftmost hop of X-Forwarded-For
 *   (the client, since the aggregator is behind a proxy/load balancer).
 * - Otherwise prefer the platform-provided CF-Connecting-IP header, then
 *   the remote address resolved by the server runtime.
 * - Never fail the request over IP detection: fall back to "unknown"
 *   (per-instance map makes it per-instance, so it only throttles requests
 *   that reached the same middleware instance without an identifiable key).
 */
function getClientIp(c: Context): string {
	const trustProxy = (process.env.TRUST_PROXY ?? "").toLowerCase();
	if (["1", "true", "yes"].includes(trustProxy)) {
		const forwarded = c.req.header("X-Forwarded-For");
		if (forwarded) {
			const firstHop = forwarded.split(",")[0]?.trim();
			if (firstHop) return firstHop;
		}
	}
	const cfIp = c.req.header("CF-Connecting-IP");
	if (cfIp) return cfIp;
	try {
		const server = (
			c.env as {
				server?: { requestIP?: (req: Request) => { address: string } | null };
			}
		).server;
		const ip = server?.requestIP?.(c.req.raw);
		if (ip?.address) return ip.address;
	} catch {
		// fall through to "unknown"
	}
	return "unknown";
}

export function rateLimitMiddleware(options: RateLimitOptions) {
	const counters = new Map<string, CounterEntry>();

	function scheduleEviction(
		key: string,
		entry: CounterEntry,
		delayMs: number,
	): void {
		setTimeout(() => {
			// Only evict if this entry is still the current one — a stale timer
			// must not delete a newer entry for the same key.
			if (counters.get(key) === entry) counters.delete(key);
		}, delayMs).unref();
	}

	return async (c: Context, next: Next) => {
		const merchantId = c.get("merchantId") as string | undefined;
		const merchantPlan = c.get("merchantPlan") as string | undefined;

		// Key by merchant if available, else by IP
		const key = merchantId || getClientIp(c);

		const planLimit = merchantPlan ? PLAN_LIMITS[merchantPlan] : undefined;
		const maxLimit = planLimit ?? options.max;

		const now = Date.now();
		const entry = counters.get(key);

		if (!entry || now > entry.resetAt) {
			const fresh: CounterEntry = { count: 1, resetAt: now + options.windowMs };
			counters.set(key, fresh);
			scheduleEviction(key, fresh, options.windowMs);
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
