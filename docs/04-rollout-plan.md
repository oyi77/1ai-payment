# 04 — Rollout Plan

## Overview

1ai-payment replaces direct gateway integration in 1ai-content and 1sub. Rollout is phased to minimize risk — each phase has a rollback plan.

Status of this document: audited against `src/` on 2026-08-01. Every code fact below was verified by reading the source; test counts are from a fresh `bun test` run.

---

## Current Status

Phase 0 (Foundation) is **complete**. The in-repo pieces of Phase 5 (Commercialization) are **partially complete**. Phases 1–4 depend on consumer repos (1ai-content, 1sub) and remain open.

13 gateways registered (midtrans, tripay, duitku, nowpayments, ipaymu, scalev, xendit, telegram_stars, telegram_payments, paypal, x402, erc8183, saweria)

**Verification:**
- `bun test` — 315 pass / 0 fail (24 files, 625 expect calls)
- `bun x tsc --noEmit` — exit 0

**In-place production features (verified in source):**
- Webhook signature verification is mandatory — `src/routes/webhook.ts` returns 401 on any invalid signature
- Idempotent webhooks: partial `UNIQUE(order_id, gateway, status)` (`WHERE order_id IS NOT NULL`) on `webhook_events` plus `UNIQUE` `idempotency_key` on `orders` (`src/config/database.ts`); duplicate callbacks return 200 without re-forwarding. Events for unknown orders are deduped in the handler by payload fingerprint (manual SELECT-then-INSERT — non-atomic, TOCTOU accepted residual, `src/routes/webhook.ts`); `idempotency_key` is global, so reusing one across merchants returns 409 `DUPLICATE_ORDER` at creation (`src/routes/payment.ts`)
- Async forwarding with 3 retries (5s / 30s / 300s backoff), `forward_failures_total` metric; exhausted events land in `dead_letter_events` and can be re-forwarded via `replayDeadLetter(id)` (`src/services/forwarder.service.ts`)
- Forwarded events are signed with the project's webhook secret (`X-Payment-Signature` header)
- Merchant gateway credentials encrypted with AES-256-GCM via required `ENCRYPTION_KEY` (64-hex) (`src/config/env.ts`, `src/utils/crypto.ts`)
- Prometheus metrics at `GET /metrics` (admin-only, `X-Admin-Key`) — `payments_created_total`, `webhooks_received_total`, `forward_failures_total`, `errors_total`, `payment_creation_duration_seconds` (`src/middleware/metrics.ts`, `src/app.ts`)
- Rate limiting: register 5 req/hr/IP, API 60 req/min, webhook 120 req/min (`src/app.ts`); per-plan limits free 30/min, pro 120/min, enterprise 600/min (`src/middleware/rate-limit.ts`)
- Multi-tenant auth: `X-API-Key` → merchants table hash lookup → env `API_KEY` fallback; `X-Admin-Key` gates admin routes and `/metrics` but never bypasses merchant auth — merchant routes always require a valid `X-API-Key`; disabled merchants rejected with 403 (`src/middleware/auth.ts`, `src/middleware/admin-auth.ts`)
- Refund API (`POST` / `GET /api/refunds`), admin dashboard (`/dashboard` + admin routes), merchant portal, landing page
- Graceful shutdown: SIGTERM/SIGINT → stop cron → drain server → 10s force-exit (`src/index.ts`)
- Health endpoint `GET /health` reports status, DB state, per-gateway config (`configured` / `missing_key`)
- Schema migrations run at boot (`src/config/migrations.ts` — v001 baseline, v002 nexus tables, v003 forward status / dead-letter replay / refund dedup)

---

## Phase 0: Foundation (Week 1) — ✅ DONE

**Goal:** Build and test the aggregator service.

1. Install dependencies (`bun install`)
2. Implement gateway `createPayment()` methods
3. Write tests (unit + integration)
4. Verify compilation (`bun run typecheck`)
5. Verify health endpoint (`curl localhost:3100/health`)

**Acceptance:**
- `bun run typecheck` — zero errors ✅ (exit 0, verified 2026-08-01)
- `bun test` — all pass ✅ (315 pass / 0 fail, verified 2026-08-01)
- `curl localhost:3100/health` — 200 ✅ (route implemented in `src/routes/health.ts`)

**Rollback:** N/A (no production traffic)

---

## Phase 1: Internal Dogfood (Week 2) — REMAINS (consumer repo)

**Goal:** 1ai-content creates payments through 1ai-payment (read-only, no production traffic yet).

1. Register 1ai-payment in gateway dashboards (webhook URLs) — external ops work, still open
2. Create a test order via `POST /api/payments` with sandbox credentials
3. Verify full flow: create → pay → callback → forward
all 13 gateways

all 13 gateways

**Acceptance:**
- End-to-end flow works for all gateways in sandbox
- Webhook signature verification passes
- Forwarded event format matches docs/02-api-reference.md

**Rollback:** Stop using 1ai-payment API. No impact on production.

---

## Phase 2: Dual-Write (Week 3) — REMAINS (consumer repo)

**Goal:** 1ai-content uses 1ai-payment for new orders, but falls back to direct gateway if 1ai-payment is down.

1. Update 1ai-content to:
   - Create payments via `POST /api/payments` (primary)
   - Fall back to direct gateway API if 1ai-payment returns 5xx
   - Store `1ai_payment_order_id` alongside existing order data
2. Monitor for 1 week:
   - Success rate comparison (1ai-payment vs direct)
   - Latency comparison
   - Any failed forwards

**Acceptance:**
- 1ai-payment success rate ≥ 99.5%
- Latency increase < 100ms
- Zero duplicate charges

**Rollback:** Revert 1ai-content to direct gateway integration. 1ai-payment continues receiving webhooks but doesn't forward.

---

## Phase 3: Primary (Week 4) — REMAINS (consumer repo)

**Goal:** All new payments go through 1ai-payment. Direct gateway code in 1ai-content marked deprecated.

1. Remove fallback to direct gateway
2. 1ai-payment becomes primary path for all gateways
3. Monitor for 2 weeks

**Acceptance:**
- Zero payment failures attributable to 1ai-payment
- All callbacks forwarded successfully

**Rollback:** Re-enable direct gateway fallback in 1ai-content.

---

## Phase 4: Multi-Project (Week 5+) — REMAINS (consumer repo)

**Goal:** 1sub and future projects use 1ai-payment.

1. 1sub registers as project (gets API key + webhook secret)
2. 1sub creates payments via `POST /api/payments`
3. Remove iPaymu/Saweria direct integration from 1sub
4. Add more gateways as needed

**In-repo support already shipped (verified):** `POST /api/register` issues per-project API keys (rate-limited to 5/hr/IP), merchant isolation is enforced via `merchants.api_key_hash` lookup + per-merchant order scoping, and per-project webhook secrets are stored on the merchant row.

**Acceptance:**
- 1sub payment flow works end-to-end
- Project isolation verified (1sub can't see 1ai-content orders)

**Rollback:** 1sub reverts to iPaymu/Saweria direct integration.

---

## Phase 5: Commercialization — PARTIALLY DONE

**Goal:** Sell 1ai-payment as a payment aggregator SaaS.

- ✅ Multi-tenant API keys (per-project isolation) — merchants table + `authMiddleware` (verified)
- ✅ Admin dashboard (payment analytics, project management) — `/dashboard` + admin routes behind `ADMIN_API_KEY` (verified)
- ✅ Refund API — `POST` / `GET /api/refunds` with `refunds` table (verified)
- ⏳ Subscription lifecycle management — partial: nexus tables (v002 migration) + nexus cron/fulfillment exist; full billing lifecycle still open
- ⏳ Webhook secret rotation — not implemented
- ⏳ Payout API for affiliates — not implemented

**Not in scope until revenue justifies it.**

---

## Rollback Summary

| Phase | Rollback Action | Downtime |
|-------|-----------------|----------|
| 0 | N/A (complete) | None |
| 1 | Stop using API | None |
| 2 | Revert 1ai-content code | None |
| 3 | Re-enable direct fallback | < 5 min |
| 4 | 1sub reverts to direct | < 5 min |

---

## Monitoring

### Health Checks
- `GET /health` — returns gateway configuration status, DB state (implemented, `src/routes/health.ts`)
- PM2/systemd auto-restart on crash

### Metrics — ✅ implemented (app-side, `src/middleware/metrics.ts`)
- Prometheus endpoint `GET /metrics` (admin-only, `X-Admin-Key`): `payments_created_total`, `webhooks_received_total`, `forward_failures_total`, `errors_total`, `payment_creation_duration_seconds` (histogram)
- Payment creation success rate per gateway — derivable from `payments_created_total{gateway,status}` + latency histogram
- Forward success rate per project — partial: `forward_failures_total` shipped; per-project breakdown needs Prometheus scraping + dashboards (ops work, not in repo)
- Latency percentiles (p50, p95, p99) — histogram shipped; percentile queries need a Prometheus/Grafana deployment
- Revenue per gateway — not exposed as a metric; fee/net columns exist on orders (business reporting, open item)

### Alerts (future)
- Forward failure rate > 5% — triggerable from `forward_failures_total` once Prometheus is running
- Gateway API error rate > 10%
- Database write failures

Alerting infrastructure (Prometheus rules / Grafana / uptime monitoring) is not in this repo — open item.

---

## Security Checklist

- [x] No secrets in code (all in `.env`) — verified: `src/config/env.ts` is 100% externalized; only `.env.example` committed
- [x] Signature verification on all webhooks — verified: `src/routes/webhook.ts` returns 401 on invalid signature
- [x] API key authentication on all API endpoints — verified: `src/middleware/auth.ts`; `X-Admin-Key` gates admin routes and `/metrics` but never bypasses merchant auth — merchant routes require a valid `X-API-Key` (tested in `tests/unit/middleware/auth.test.ts`)
- [x] No raw webhook payloads logged — verified: webhook handler logs only gateway, order_id, status, gateway_reference. Note: raw payloads + headers ARE persisted to the `webhook_events` table (audit trail) — DB storage, not logs; confirm this is acceptable policy
- [x] Timing-safe signature comparison — verified: `crypto.timingSafeEqual` used for signature checks
- [x] Rate limiting on API endpoints — verified: `src/app.ts` + per-plan middleware
- [x] Input validation on all endpoints — verified: Zod schemas (`src/schemas.ts`) + default hook
- [x] Webhook secrets differ per project — verified: per-merchant `webhook_secret` used to sign forwards; fail-closed: if the merchant's secret is missing/empty the event is NOT forwarded (warned + skipped, `src/routes/webhook.ts`)
- [ ] HTTPS via Cloudflare — infra-level, not verifiable in repo
