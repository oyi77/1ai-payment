# 00 — Overview

## What is 1ai-payment?

1ai-payment is a **payment gateway aggregation service** for the 1ai-ecosystem. It provides a unified API for creating payments across multiple gateways (Midtrans, Tripay, Duitku, NOWPayments) and handles callback routing to the correct owning project.

**Internal use only** — designed for future commercialization as a payment aggregator SaaS.

## Why does this exist?

### The Problem

Payment gateways have fragmented APIs, different callback formats, and single callback URL constraints. The 1ai-ecosystem has multiple projects needing payment:

| Project | Payment Need | Gateways |
|---------|--------------|----------|
| 1ai-content | Credit top-up, subscriptions | Midtrans, Tripay, Duitku, NOWPayments |
| 1sub | Subscription sharing platform | iPaymu, Saweria |
| 1ai-affiliate | Commission payouts | Future |
| Future projects | Various | TBD |

Without 1ai-payment, each project would need:
- Gateway-specific SDK integration (4+ implementations per project)
- Its own merchant account per gateway
- Duplicated payment code across projects (DRY violation)
- Separate callback URL registration per project

### The Solution

1ai-payment acts as a **unified payment API**:

```
Project → POST /api/payments (1ai-payment) → Gateway API → User pays → Callback → Forward to project
```

**Single integration point** for all gateways. Projects don't need to know gateway-specific APIs.

## Design Principles

1. **Unified API** — One API for all gateways. Projects use `POST /api/payments` regardless of gateway.
2. **Provider/Plugin pattern** — Each gateway implements `PaymentGateway` interface (SOLID: depend on abstractions).
3. **Idempotent operations** — Duplicate requests produce same result. Use `idempotency_key`.
4. **Fail-safe** — One gateway failure doesn't affect others. Unknown orders logged, not dropped.
5. **Metadata passthrough** — Projects can attach arbitrary metadata, returned in callbacks.
6. **Internal-first** — API key auth for now. Multi-tenant with project isolation designed for future.

## Scope

### In Scope (v0.1 — Internal)
- Payment creation API (`POST /api/payments`)
- Payment status check (`GET /api/payments/:id`)
- Payment methods listing (`GET /api/gateways/:gateway/methods`)
- Webhook receiver for 4 gateways
- Signature verification (centralized, timing-safe)
- Order registry with metadata
- Event forwarding to project callbacks
- Health monitoring

### Out of Scope (v0.1)
- Multi-tenant isolation (single API key for all projects)
- Payment refunds
- Subscription management
- Payouts/disbursements
- Admin dashboard
- Payment analytics/reporting

### Future (v0.2+)
- Multi-tenant API keys (per-project isolation)
- Webhook secret rotation
- Payment refund API
- Subscription lifecycle management
- Payout API for affiliates
- Admin dashboard with analytics
- Rate limiting per project

## Non-Goals

- **Not a payment processor** — We don't hold funds. Gateway handles settlement.
- **Not a wallet** — No balance management. Credits managed by owning projects.
- **Not a bank** — No KYC, no compliance (yet).

## Success Criteria

1. Single API integration → all gateways accessible
2. Zero double-charge incidents (idempotency)
3. <200ms payment creation latency
4. 99.9% uptime (payment is critical path)
5. Zero signature verification bypasses
6. Metadata preserved through full lifecycle (create → callback → forward)
