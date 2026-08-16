# 05 — Product Roadmap: Internal Tool → Payment Aggregator SaaS

## Guiding Principle

**Every step must be independently deployable.** The service works correctly after
each merge. No step breaks existing API consumers. No step requires a "big bang"
migration. If we stop at any step, the service is in a valid, better state.

Statuses below are audited against the current codebase (`git log` + `src/` + `tests/`).
✅ = fully shipped, 🟡 = partially shipped (gap listed), ⬜ = not started.

## Current State (v0.1 — Multi-Tenant)

```
Multi-tenant: merchants table + per-merchant API keys (SHA-256 hashed)
Public merchant self-registration (POST /api/register)
Merchant CRUD + API-key rotation + gateway credential management APIs
Gateway creds from env, with per-merchant overrides stored (encrypted)
   — stored, but NOT yet used by the payment-creation path
Per-plan API rate limits (free 30 / pro 120 / enterprise 600 per min)
Transactions, refunds (manual), webhook-delivery log endpoints
Merchant portal dashboard (/dashboard)
TypeScript SDK (@1ai/payment)
Prometheus metrics (/metrics)
Webhook events + dead-letter tracking
13 gateways
Nexus: Scalev direct-checkout fulfillment + Telegram delivery cron
No billing, no fee computation, no webhook-secret rotation yet
```

**What works:** Payment creation, webhook processing, signature verification
(timing-safe), per-merchant idempotent lookups, forwarding with merchant
`webhook_secret` + 3-retry backoff, transaction history, refunds, webhook
13 gateways
auto-generated OpenAPI docs (`/doc`, `/reference`).

---

## Phase 1: Multi-Tenant Foundation

> **Goal:** Multiple projects can use 1ai-payment with isolated API keys,
> own callback URLs, and own order namespaces. Existing single-key usage
> continues to work unchanged.

### Step 1.1 — Add `merchants` table (DB-only, zero behavior change)

**Status: ✅ Done**

**Files:** `src/config/database.ts`

**Shipped:**
- `merchants` table: `id` (`merch_xxxxx`), `name`, `api_key_hash UNIQUE`,
  `webhook_secret`, `default_callback_url`, `active`, `plan` (`free|pro|enterprise`),
  timestamps; `idx_merchants_api_key` on `api_key_hash`.
- `merchant_gateways`, `refunds`, `webhook_events`, `dead_letter_events` and
  Nexus tables (`nexus_customers`, `nexus_subscriptions`) also live here now.
- Default merchant seeded from env `API_KEY` when no merchants exist
  (`INSERT OR IGNORE ... 'merch_default'`) — backward compatible with the old
  single-key setup.

**Verified:** `bun run typecheck` passes; DB boots via `initDatabase()`; existing
API key still authenticates (now via the seeded `merch_default` row).

**Rollback:** Drop the table (was never needed in production — schema only).

---

### Step 1.2 — Auth middleware reads from `merchants` table (backward-compatible)

**Status: ✅ Done**

**Files:** `src/middleware/auth.ts`

**Shipped:**
- `X-API-Key` → `sha256` → `SELECT ... FROM merchants WHERE api_key_hash = ?`.
- Inactive merchant → `403 MERCHANT_DISABLED`; missing/invalid → `401 UNAUTHORIZED`.
- Sets `merchantId`, `merchantName`, `merchantPlan` on context for downstream handlers.
- Fallback: env `API_KEY` maps to `merch_default` / `Default` / `free`.
- Admin auth is separate: admin routes use `src/middleware/admin-auth.ts`
  (`X-Admin-Key`); merchant routes always require a valid `X-API-Key` —
  `X-Admin-Key` alone is rejected (401).

**Verified:** Merchant-scoped tests cover auth; env-key fallback preserved.

**Rollback:** Revert to env-only comparison.

---

### Step 1.3 — Order creation uses merchant context (no API change)

**Status: ✅ Done**

**Files:** `src/routes/payment.ts`, `src/services/order.service.ts`

**Shipped:**
- `orderParams.project_id = merchant_id = c.get('merchantId') ?? 'merch_default'`
  (was hardcoded `'1ai-content'`).
- `orders` table gained `merchant_id` (plus `fee`, `net` columns — see 4.3).
- Order creation is a DB-level duplicate check on idempotency keys (see 1.6 for
  the scoping caveat).

**Verified:** Orders created with the env key have `merchant_id = 'merch_default'`;
new merchant keys get their own `merch_xxxxx`.

**Rollback:** Hardcode the fallback again.

---

### Step 1.4 — Webhook forwarding uses merchant's webhook_secret

**Status: ✅ Done**

**Files:** `src/routes/webhook.ts`, `src/services/forwarder.service.ts`

**Shipped:**
- Webhook handler resolves `webhook_secret` via
  `SELECT webhook_secret FROM merchants WHERE id = order.project_id`, falling back
  to `order.id` when the merchant row is missing.
- `forwarder.service.ts` signs forwarded payloads with that secret
  (`X-Payment-Signature` header), retries 3× (5s / 30s / 300s backoff, 30s
  timeout), writes failures to `dead_letter_events`, and increments
  `forward_failures_total`.
- Webhook dedup via `webhook_events` `UNIQUE(order_id, gateway, status)`; raw
  payload stored (not logged) for audit; never emitted to logs.

**Verified:** Duplicate gateway callbacks produce one `webhook_events` row and one
forward; project receives correctly signed payload.

**Rollback:** Use `order.id` as secret again.

---

### Step 1.5 — Merchant CRUD API

**Status: ✅ Done** (plus a public registration endpoint not in the original plan)

**Files:** `src/routes/merchant.ts`, `src/routes/register.ts` (new), `src/schemas.ts`, `src/index.ts`

**Shipped:**
- `POST /api/merchants` — create merchant, returns raw API key **once**
  (`1pay_` + random hex), stores SHA-256 hash.
- `GET /api/merchants` — own record (returned as an array);
  `GET/PATCH /api/merchants/{id}` — detail/update
  (name, `default_callback_url`, `active`); `POST /api/merchants/{id}/api-key` —
  rotate (old key dies, new key returned once).
- **Bonus:** `POST /api/register` (public, no auth, rate-limited 5/hr per IP) —
  self-serve merchant registration; returns API key once + merchant profile.
  Merely a convenience wrapper over merchant creation.

**Verified:** Create → use new key → payment creation works; rotate → old key 401s.

**Rollback:** Remove routes.

---

### Step 1.6 — Per-merchant idempotency scope

**Status: 🟡 Partial**

**Files:** `src/routes/payment.ts`, `src/services/order.service.ts`, `src/config/database.ts`

**Shipped:**
- Lookup path is merchant-scoped: `getOrderByIdempotencyKey(key, merchantId)` —
  same key from the same merchant returns the existing order (200, unchanged).
- `idx_orders_merchant_idempotency` added on `(merchant_id, idempotency_key)`.

**Gap:** The **global** `UNIQUE(idempotency_key)` constraint is still on
`orders` (it predates merchants), and the new index is **not unique** (it was
meant to replace the global constraint). Consequence: the same idempotency key
used by **two different merchants** still fails at the DB layer with
`409 DUPLICATE_ORDER` instead of creating two separate orders — exactly the
cross-tenant collision the roadmap wanted to eliminate.

**Target:** drop the global UNIQUE and recreate the constraint as
`CREATE UNIQUE INDEX ... ON orders(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
(needs a small migration that first de-dupes existing rows).

**Rollback:** Keep the current state (global UNIQUE still active).

---

## Phase 2: Transaction History & Refunds

> **Goal:** Merchants can query their transaction history and issue refunds.

### Step 2.1 — Transaction history endpoint

**Status: ✅ Done**

**Files:** `src/routes/payment.ts` (route), `src/services/order.service.ts` (query)

**Shipped:**
- `GET /api/transactions?status=&gateway=&from=&to=&limit=&offset=` — scoped to
  the authenticated merchant (`orders.merchant_id`), `limit` capped at 100
  (default 50). Returns `fee`/`net` from the order row (currently always 0 — see 4.3).

**Verified:** Merchant A sees only A's rows; filters + pagination tested.

**Rollback:** Remove route.

---

### Step 2.2 — Refund API

**Status: 🟡 Partial**

**Files:** `src/routes/refund.ts`, `src/services/refund.service.ts`, `src/config/database.ts`, `src/schemas.ts`

**Shipped:**
- `refunds` table: `order_id`, `merchant_id`, `amount`, `gateway`,
  `gateway_refund_id`, `status` (`pending|success|failed`), `reason`, timestamps.
- `POST /api/refunds` — order must exist **and belong to the merchant**
  (`merchant_id` or `project_id` match), status must be `success`, amount optional
  (defaults to full, must be ≤ `order.amount`). Full refund flips the order to
  `refunded`. `GET /api/refunds` lists with pagination, merchant-scoped.

**Gaps:**
- **No gateway implements `refundPayment`** — the optional method exists on the
  `PaymentGateway` interface (`src/gateways/base.ts`), the service checks it, but
  no concrete gateway provides one. Every refund falls through to
  `status = 'pending'` (manual processing). Gateway-initiated refunds are
  effectively dead code.
- **No refund idempotency** — every `POST /api/refunds` call inserts a new row;
  retrying the same refund double-creates entries.

**Target:** implement `refundPayment` per gateway (or a clear
`REFUND_NOT_SUPPORTED`), add an `idempotency_key` to `refunds` with a UNIQUE
constraint.

**Rollback:** Drop `refunds` table, remove routes.

---

### Step 2.3 — Webhook delivery log endpoint

**Status: ✅ Done**

**Files:** `src/routes/payment.ts` (route), `src/config/database.ts` (`webhook_events`)

**Shipped:**
- `GET /api/webhook-deliveries?order_id=&limit=` — joins `webhook_events` +
  `orders`, scoped to `orders.merchant_id`; returns `id`, `gateway`, `order_id`,
  `status`, `signature_valid`, `created_at`. No raw payload or headers exposed
  (raw data stays in the DB row, never in API responses or logs).

**Verified:** Shows forward attempts + signature validity for the merchant's orders.

**Rollback:** Remove route.

---

## Phase 3: Per-Merchant Gateway Config

> **Goal:** Merchants can use their own gateway credentials, or fall back to
> platform-shared credentials.

### Step 3.1 — Add `merchant_gateways` table

**Status: ✅ Done**

**Files:** `src/config/database.ts`

**Shipped:**
- `merchant_gateways`: `merchant_id`, `gateway`, `credentials` (**encrypted** JSON,
  AES-256-GCM via `src/utils/crypto.ts`), `environment`, `enabled`,
  `UNIQUE(merchant_id, gateway)`, timestamps.

**Verified:** Table created at boot; zero behavior change to existing flows.

**Rollback:** Drop table.

---

### Step 3.2 — Gateway config resolution (merchant-first, fallback to env)

**Status: 🟡 Partial**

**Files:** `src/config/env.ts` (`getGatewayConfigForMerchant`)

**Shipped:**
- `getGatewayConfigForMerchant(gateway, merchantId)` implemented exactly as
  planned: reads `merchant_gateways` (enabled=1), decrypts credentials, falls
  back to env config.

**Gap:** **Nothing calls it.** `POST /api/payments` builds the gateway instance
from platform env config and calls `gw.createPayment(...)` directly — merchant
credentials can be stored and managed via the API (3.3) but are never resolved
during payment creation (or refunds/webhooks). The helper is currently dead code.

**Target:** pass `merchantId` into the config resolution in `src/routes/payment.ts`
(create flow) and in `refund.service.ts`.

**Rollback:** Revert to env-only config (i.e., current behavior).

---

### Step 3.3 — Merchant gateway management API

**Status: ✅ Done**

**Files:** `src/routes/merchant.ts` (endpoints)

**Shipped:**
- `GET /api/merchants/{id}/gateways` — list configured gateways
- `PUT /api/merchants/{id}/gateways/{gateway}` — set credentials (encrypted at rest)
- `PATCH /api/merchants/{id}/gateways/{gateway}` — enable/disable
- `DELETE /api/merchants/{id}/gateways/{gateway}` — remove config (falls back to platform)

**Verified:** CRUD + enable/disable tested; credentials stored encrypted.

**Rollback:** Remove endpoints.

---

## Phase 4: Rate Limiting & Billing Prep

> **Goal:** Per-merchant rate limits and transaction fee tracking.

### Step 4.1 — Per-merchant rate limiting

**Status: ✅ Done**

**Files:** `src/middleware/rate-limit.ts`

**Shipped:**
- Rate limiter keys on `c.get('merchantId')`, falling back to
  `X-Forwarded-For` / `CF-Connecting-IP` / `'unknown'` for unauthenticated
  requests. In-memory `Map` counters with setTimeout eviction; excess →
  `429 RATE_LIMITED`.
- Applied per-route-group in `src/app.ts`: `/api/register` 5/hr per IP,
  `/api/*` 60/min default, `/webhook/*` 120/min flat (see 4.2).

**Verified:** Merchant A hitting the limit does not throttle merchant B.

**Note:** In-memory state means limits are per-process — multi-instance
deployments need a shared store (see Backlog).

**Rollback:** Revert to IP-only keying.

---

### Step 4.2 — Add `plan` rate limit tiers

**Status: 🟡 Partial**

**Files:** `src/middleware/rate-limit.ts`, `src/app.ts`

**Shipped:**
- Plan tiers applied to **API** routes via `PLAN_LIMITS`:
  `free=30/min`, `pro=120/min`, `enterprise=600/min` (env-key fallback = free).

**Gap:** **Webhook endpoints stay flat** (`/webhook/*` 120/min for everyone).
The roadmap's webhook tiers (free 60 / pro 300 / enterprise 1200) were never
added. Webhook processing is also plan-unaware on ingress.

**Target:** plan-aware webhook limits (gateway webhooks are unauthenticated, so
tiering requires resolving the owning merchant before rate-limiting — a
lookup-then-limit ordering change).

**Rollback:** Revert to flat rate.

---

### Step 4.3 — Transaction fee tracking (no billing yet)

**Status: 🟡 Partial**

**Files:** `src/config/database.ts`, `src/services/order.service.ts`

**Shipped:**
- `orders.fee` and `orders.net` columns added (`INTEGER DEFAULT 0`); surfaced in
  `GET /api/transactions` responses; `mapRow` defaults them to 0.

**Gap:** **No code computes them.** The planned fee formula
(enterprise 1% / pro 2% / free 2.5% on success) does not exist anywhere — no
success-webhook hook writes `fee`/`net`. Every transaction reports
`fee=0, net=0`; the values are columns-only.

**Target:** compute on successful payment webhook using the merchant's `plan`
(stored, not env), keeping existing rows at 0.

**Rollback:** Drop columns.

---

## Phase 5: Dashboard & Polish

> **Goal:** Merchant-facing dashboard, API docs per merchant, SDK.

### Step 5.1 — Dashboard scaffold

**Status: ✅ Done**

**Files:** `src/dashboard/index.html` (single-file SPA), served from `src/app.ts`

**Shipped:**
- `/dashboard` serves a self-contained static app (no React build step; plain
  HTML/CSS/JS).
- Flows: landing → API-key login → dashboard shell with sidebar
  (**Overview** with stats + recent transactions, **Transactions**, **Refunds**,
  **Gateways**, **Settings**) and a plan badge.
- Uses the same authenticated API endpoints (`/api/transactions`, `/api/refunds`,
  `/api/merchants/:id/gateways`, ...) with the merchant's key.
- Includes sign-out and API-key reveal-on-registration UX.

**Gap vs. original plan:** no dedicated **Webhooks** page (delivery logs are not
exposed in the UI, though the API exists) and no search/filter controls beyond
what the API offers.

**Verified:** `/dashboard` loads; login + data rendering work against the API.

**Rollback:** Remove the route + file.

---

### Step 5.2 — Per-merchant API docs

**Status: 🟡 Partial**

**Files:** `src/index.ts` (Swagger `/reference`)

**Shipped:**
- `/reference` accepts `?key=`; Swagger UI is configured with
  `persistAuthorization: true`.

**Gap:** The key is **not injected** into Swagger's authorization state — the
query param only persists the UI toggle. "Try it out" requests still need the
user to manually paste the key into the Authorize dialog. The original goal
("Swagger pre-fills the API key") is unmet.

**Target:** seed `localStorage`/Swagger auth with the `?key=` value on load.

**Rollback:** Remove key handling (keep `/reference` open).

---

### Step 5.3 — TypeScript SDK

**Status: ✅ Done**

**Files:** `packages/sdk/` (`src/index.ts`, `dist/`, `package.json`)

**Shipped:**
- `@1ai/payment` `v0.1.0` (private), built via `tsc` to `dist/`.
- `OneAIPayment` class (`apiKey`, configurable `baseUrl`):
  `register()`, `create()`, `get()`, `listTransactions()`, `refund()`,
  `listRefunds()`, `listGateways()`, `listWebhookDeliveries()`,
  `getGatewayMethods()`; `APIError` class for typed errors.

**Gap:** no SDK tests yet (`"test": "echo 'TODO: add tests'"`) and the package is
unpublished/private.

**Verified:** `bun run typecheck` passes; SDK methods mirror the REST API surface.

**Rollback:** Remove package.

---

## Summary: Dependency Graph

Statuses: ✅ done · 🟡 partial · ⬜ not started.

```
1.1 ✅ merchants table
 └─► 1.2 ✅ auth reads merchants
      ├─► 1.3 ✅ order uses merchant_id
      │    └─► 1.6 🟡 per-merchant idempotency (global UNIQUE still present)
      ├─► 1.4 ✅ forwarding uses merchant secret
      └─► 1.5 ✅ merchant CRUD API (+ public registration, bonus)
           ├─► 2.1 ✅ transaction history
           ├─► 2.2 🟡 refunds (no gateway impl, no idempotency)
           ├─► 2.3 ✅ webhook delivery logs
           ├─► 3.1 ✅ merchant_gateways table
           │    └─► 3.2 🟡 merchant-first config (helper exists, unwired)
           │         └─► 3.3 ✅ gateway management API
           ├─► 4.1 ✅ per-merchant rate limiting
           │    └─► 4.2 🟡 plan tiers (API only, webhooks flat)
           └─► 4.3 🟡 fee tracking (columns only, never computed)
                └─► 5.1 ✅ dashboard
                     ├─► 5.2 🟡 per-merchant docs (key not pre-filled)
                     └─► 5.3 ✅ SDK
```

Each leaf is independently deployable. Each parent works without its children.

## Shipped Beyond the Original Roadmap

Shipped items the roadmap did not plan (audited — all present in code):

| Item | Where | Notes |
|------|-------|-------|
| Public merchant registration | `POST /api/register` (`src/routes/register.ts`) | Self-serve onboarding, 5/hr per IP |
| Admin API | `GET /api/admin/merchants` + `PATCH /api/admin/merchants/{id}` (`src/routes/admin.ts`, `X-Admin-Key`) | List + plan/active updates (no web UI) |
| Prometheus metrics | `GET /metrics` (`src/middleware/metrics.ts`) | Counters + `payment_creation_duration_seconds` histogram; admin auth required (`X-Admin-Key`) |
| Webhook events + dead letters | `webhook_events`, `dead_letter_events` (`src/config/database.ts`) | Dedup + audit + failed-forward queue |
| Gateways 11–12 | `x402` (micropayments), `erc8183` (agentic-commerce escrow) | Registry: 12 total |
| Nexus (1ai-product delivery) | `src/services/nexus-fulfillment.ts`, `nexus-cron.ts` | Scalev direct-checkout fulfillment + Telegram invite delivery; 6h maintenance cron; `nexus_customers` / `nexus_subscriptions` |

## Future Work / Backlog

Genuinely-future items, roughly by dependency order. None block current use.

1. **Complete 1.6** — drop global `UNIQUE(idempotency_key)`; migrate to
   `UNIQUE(merchant_id, idempotency_key)`. Cross-merchant key reuse is the only
   remaining multi-tenant correctness gap.
2. **Complete 3.2** — wire `getGatewayConfigForMerchant` into payment creation
   (and refund) paths so stored merchant credentials actually take effect.
3. **Refund hardening** — per-gateway `refundPayment` implementations (or explicit
   `REFUND_NOT_SUPPORTED`), plus refund idempotency (`idempotency_key` + UNIQUE).
4. **Complete 4.3 — billing foundation** — compute `fee`/`net` on successful
   webhooks from the merchant's `plan`. This is the prerequisite for billing.
5. **Webhook secret rotation API** — per-merchant endpoint to rotate
   `merchants.webhook_secret` (API-key rotation already exists; secret rotation
   does not).
6. **Plan-aware webhook rate limits** — per-merchant tiers on `/webhook/*`
   (currently flat 120/min).
7. **Billing** — plan payments, overage, dunning. Depends on 4/5. No billing
   code exists yet.
8. **Admin dashboard expansion** — web UI + detail/disable/plan-change actions
   (API lists merchants and can update plan/active; no web UI / detail actions
   yet).
9. **Dashboard Webhooks page** — surface `webhook-deliveries` in the portal.
10. **Complete 5.2** — inject `?key=` into Swagger authorization on load.
11. **SDK maturity** — test suite (`bun test`), CI publish (currently private).
12. **Distributed rate limiting** — replace the in-memory `Map` with a shared
    store (Redis/libSQL) so limits hold across instances.

## Status & Estimated Effort

| Phase | Steps | Status | Est. Time (original) | Priority |
|-------|-------|--------|----------------------|----------|
| Phase 1: Multi-tenant | 6 steps | 5 done, 1 partial | 2-3 weeks | **P0** — blocks everything |
| Phase 2: History & Refunds | 3 steps | 2 done, 1 partial | 1-2 weeks | **P1** — merchant needs |
| Phase 3: Merchant Gateways | 3 steps | 2 done, 1 partial | 1-2 weeks | **P1** — platform differentiation |
| Phase 4: Rate & Billing | 3 steps | 1 done, 2 partial | 1 week | **P2** — monetization |
| Phase 5: Dashboard & SDK | 3 steps | 2 done, 1 partial | 2-3 weeks | **P2** — adoption |

**Remaining to finish all 18 steps:** the four 🟡 gaps (1.6 migration, 3.2 wiring,
2.2 gateway refunds + idempotency, 4.3 fee computation) and the two 🟡 polish
items (4.2 webhook tiers, 5.2 docs pre-fill) — roughly 1-2 focused weeks.
Everything after that (billing, rotation, admin UI) is net-new backlog.
