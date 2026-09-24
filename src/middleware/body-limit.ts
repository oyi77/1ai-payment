/**
 * Request body size guard — DoS protection for JSON/raw parsing paths.
 *
 * Hono/Bun read request bodies fully into memory with no built-in cap, and
 * the webhook route stores the raw body in `webhook_events.raw_payload`.
 * Without a cap, a 100MB JSON POST (120/min webhook budget) OOMs the worker
 * or bloats the DB. Two layers:
 * 1. `bodyLimitMiddleware` — rejects declared Content-Length > cap with 413
 *    before auth/rate-limit/parse (cheap header check, catches honest giants).
 * 2. `readCappedText` — stream-reads the body with an early abort for
 *    chunked/lying clients (used by the webhook raw-body path).
 */
import type { Context, Next } from "hono";

/** 1MB — largest legitimate payload is a metadata-rich payment create (~2KB). */
export const MAX_BODY_BYTES = 1_000_000;

export async function bodyLimitMiddleware(c: Context, next: Next) {
	const len = c.req.header("content-length");
	if (len && Number(len) > MAX_BODY_BYTES) {
		return c.json(
			{
				success: false as const,
				error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" },
			},
			413,
		);
	}
	await next();
}
