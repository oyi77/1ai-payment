# 04 — Rollout Plan

## Overview

1ai-payment replaces direct gateway integration in 1ai-content and 1sub. Rollout is phased to minimize risk — each phase has a rollback plan.

---

## Phase 0: Foundation (Week 1) — CURRENT

**Goal:** Build and test the aggregator service.

1. Install dependencies (`bun install`)
2. Implement gateway `createPayment()` methods
3. Write tests (unit + integration)
4. Verify compilation (`bun run typecheck`)
5. Verify health endpoint (`curl localhost:3100/health`)

**Acceptance:**
- `bun run typecheck` — zero errors
- `bun test` — all pass
- `curl localhost:3100/health` — 200

**Rollback:** N/A (no production traffic)

---

## Phase 1: Internal Dogfood (Week 2)

**Goal:** 1ai-content creates payments through 1ai-payment (read-only, no production traffic yet).

1. Register 1ai-payment in gateway dashboards (webhook URLs)
2. Create a test order via `POST /api/payments` with sandbox credentials
3. Verify full flow: create → pay → callback → forward
4. Test all 4 gateways individually

**Acceptance:**
- End-to-end flow works for all gateways in sandbox
- Webhook signature verification passes
- Forwarded event format matches docs/02-api-reference.md

**Rollback:** Stop using 1ai-payment API. No impact on production.

---

## Phase 2: Dual-Write (Week 3)

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

## Phase 3: Primary (Week 4)

**Goal:** All new payments go through 1ai-payment. Direct gateway code in 1ai-content marked deprecated.

1. Remove fallback to direct gateway
2. 1ai-payment becomes primary path for all gateways
3. Monitor for 2 weeks

**Acceptance:**
- Zero payment failures attributable to 1ai-payment
- All callbacks forwarded successfully

**Rollback:** Re-enable direct gateway fallback in 1ai-content.

---

## Phase 4: Multi-Project (Week 5+)

**Goal:** 1sub and future projects use 1ai-payment.

1. 1sub registers as project (gets API key + webhook secret)
2. 1sub creates payments via `POST /api/payments`
3. Remove iPaymu/Saweria direct integration from 1sub
4. Add more gateways as needed

**Acceptance:**
- 1sub payment flow works end-to-end
- Project isolation verified (1sub can't see 1ai-content orders)

**Rollback:** 1sub reverts to iPaymu/Saweria direct integration.

---

## Phase 5: Commercialization (Future)

**Goal:** Sell 1ai-payment as a payment aggregator SaaS.

1. Multi-tenant API keys (per-project isolation)
2. Admin dashboard (payment analytics, project management)
3. Webhook secret rotation
4. Refund API
5. Subscription lifecycle management
6. Payout API for affiliates

**Not in scope until revenue justifies it.**

---

## Rollback Summary

| Phase | Rollback Action | Downtime |
|-------|-----------------|----------|
| 0 | N/A | None |
| 1 | Stop using API | None |
| 2 | Revert 1ai-content code | None |
| 3 | Re-enable direct fallback | < 5 min |
| 4 | 1sub reverts to direct | < 5 min |

---

## Monitoring

### Health Checks
- `GET /health` — returns gateway configuration status
- PM2/systemd auto-restart on crash

### Alerts (future)
- Forward failure rate > 5%
- Gateway API error rate > 10%
- Database write failures

### Metrics (future)
- Payment creation success rate per gateway
- Forward success rate per project
- Latency percentiles (p50, p95, p99)
- Revenue per gateway

---

## Security Checklist

- [ ] No secrets in code (all in `.env`)
- [ ] Signature verification on all webhooks
- [ ] API key authentication on all API endpoints
- [ ] No raw webhook payloads logged
- [ ] Timing-safe signature comparison
- [ ] Rate limiting on API endpoints
- [ ] Input validation on all endpoints
- [ ] HTTPS via Cloudflare
- [ ] Webhook secrets differ per project
