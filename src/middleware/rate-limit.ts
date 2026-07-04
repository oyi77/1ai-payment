/**
 * Rate limiting middleware — in-memory sliding window.
 *
 * Payment endpoints: 10 req/min.
 * Webhook endpoints: 60 req/min.
 */

import type { Context, Next } from 'hono';

interface RateLimitOptions {
  windowMs: number;
  max: number;
}

const counters = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(options: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    const key = c.req.header('X-Forwarded-For') || c.req.header('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const entry = counters.get(key);

    if (!entry || now > entry.resetAt) {
      counters.set(key, { count: 1, resetAt: now + options.windowMs });
      await next();
      return;
    }

    entry.count++;

    if (entry.count > options.max) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: 'Too many requests' }, 429);
    }

    await next();
  };
}
