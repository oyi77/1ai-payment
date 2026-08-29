# Case Study — GATE 6 Pre-Sale Hardening (1ai-payment)

## Problem
Two genuine defects threatened the `/api/payments` payment-creation path:

1. **Rate-limit caps stripped.** `src/middleware/rate-limit.ts` had lost the `planLimit` / `maxLimit` resolution lines (over-deletion). The pre-auth `/api/*` limiter was no longer differentiating merchant plan caps from the default, leaving `max` unbound to the intended 60/min ceiling. An attacker could fire unbounded wrong-key payments (each returning 401) and brute-force API keys or exhaust resources without a 429 gate.
2. **Body-parse failures → 500.** When `c.req.json()` threw, the error was a standard `SyntaxError` but the handler compared against a module-local shadow (re-exported `SyntaxError` const), so the branch was dead. Malformed request bodies surfaced as `500 INTERNAL ERROR` instead of `400 BAD_REQUEST` — leaking server-error semantics to unauthenticated callers.

## Solution
1. **Restored plan caps.** Re-added
   ```ts
   const planLimit = merchantPlan ? PLAN_LIMITS[merchantPlan] : undefined;
   const maxLimit = planLimit ?? options.max;
   ```
   in `src/middleware/rate-limit.ts`. Limiter now: `count=1` on new window → `next()`; else `count++`; `count > maxLimit` → `429`; else `next()`. With `max=60`, request #61 ⇒ `61 > 60` ⇒ `429`. `max` deliberately stays **60** (not 600) so the GATE 6 acceptance "429 at #61" holds.
2. **Hardened body-parse 400.** `src/app.ts` global `onError` now checks `err instanceof globalThis.SyntaxError` (avoids the module-local shadow) plus a `/JSON|parse|body/i` message fallback, returning `{ success:false, error:{code:"BAD_REQUEST", message:"Invalid request body"} }` at `400`. Covers all `c.req.json()` routes, no per-route try/catch, no payload leak.

## Real Data Flow (this session)
- 70× wrong-key `POST /api/payments` → `total 70 first_non_401 61 Counter({'401': 60, '429': 10})`.
- Empty / invalid-JSON / missing-amount bodies → `400` (3 distinct malformed shapes).
- Duplicate midtrans webhook → `200 / 200`, `webhook_events` count = `1`.

## Business Impact
A payment aggregator that returns `500` on bad input or lets key-brute-force run unthrottled is not sellable. After the fix: unauthenticated callers get clean `400`/`401`, brute-force is capped at 60/min (429 at #61), and duplicate provider callbacks never double-credit — exactly the security contract the GATE battery requires.

## How to Verify
```bash
bun run lint && bun run typecheck && bun test   # expect: clean / clean / 360 pass 0 fail
# then run the curl burst in curl/gate6-payments.md against an isolated 3105 server
```
