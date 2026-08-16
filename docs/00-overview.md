# 00 — Overview

## What is 1ai-payment?

Unified API for creating payments across 13 gateways (midtrans, tripay, duitku, nowpayments, ipaymu, scalev, xendit, telegram_stars, telegram_payments, paypal, x402, erc8183, saweria)

It also operates a **multi-tenant merchant platform**: any merchant can self-register, manage per-merchant API keys and per-gateway credentials, and control which gateways are enabled. One subsystem — **Nexus** — implements direct-to-customer fulfillment: Scalev checkout callbacks create subscription records and issue Telegram channel invites without any owning project in between.

Designed for internal use first, with commercialization as a payment aggregator SaaS in mind.

## Why does this exist?

### The Problem

Payment gateways have fragmented APIs, different callback formats, and single callback URL constraints. The 1ai-ecosystem has multiple projects needing payment:

| Project | Payment Need | Status |
|---------|--------------|--------|
| Nexus (1ai-product) | Direct checkout (Scalev) for Telegram bot / signal channel / terminal products; subscription delivery via channel invites | **Connected** — fulfillment wired into code (webhook → subscription → Telegram invite) |
| 1ai-content | Credit top-up, subscriptions | Planned — documented, no code integration yet |
| 1sub | Subscription sharing platform | Planned |
| 1ai-affiliate | Commission payouts | Planned — payout capability is also out of scope |
| Future projects | Various | TBD |

Without 1ai-payment, each project would need:
- Gateway-specific SDK integration (12 implementations per project at current gateway count)
- Its own merchant account per gateway
- Duplicated payment code across projects (DRY violation)
- Separate callback URL registration per project

### The Solution

1ai-payment acts as a **unified payment API**:

```
Merchant → POST /api/payments (1ai-payment) → Gateway API → User pays → Gateway callback
    → verify signature → normalize event → forward to merchant callback_url
```

**Single integration point** for all gateways. Projects don't need to know gateway-specific APIs.

Scalev callbacks additionally trigger the Nexus fulfillment path (product variant → subscription → Telegram channel invite), so the buying customer is served without a separate project backend.

## Design Principles

1. **Unified API** — One API for all gateways. Merchants use `POST /api/payments` regardless of gateway. Every API error returns a unified envelope: `{ success: false, error: { code, message } }`.
2. **Provider/Plugin pattern** — Each gateway implements the `PaymentGateway` interface (SOLID: depend on abstractions). Adding a gateway = implement + register.
3. **Idempotent operations** — Duplicate requests produce the same result. `idempotency_key` prevents duplicate orders (UNIQUE constraint); duplicate webhook events are deduplicated before updating an order.
4. **Fail-safe** — One gateway failure doesn't affect others. Event forwarding retries with backoff and falls back to a dead-letter queue. Unknown orders are recorded, not dropped.
5. **Metadata passthrough** — Merchants can attach arbitrary metadata, preserved through the full lifecycle (create → callback → forward).
6. **Multi-tenant by design** — Per-merchant API keys (hashed at rest), merchant-scoped data, per-plan rate limits, encrypted gateway credentials per merchant. The platform-level `API_KEY` remains as a backward-compatible default merchant.

## Scope

### In Scope (current)
- Payment creation (`POST /api/payments`) — idempotent; 201 created / 200 idempotent hit / 409 duplicate / 502 gateway error
- Payment status check (`GET /api/payments/:id`)
- Gateway and payment-method listing (`GET /api/gateways`, `GET /api/gateways/:gateway/methods`)
- Audit lists: transactions (`GET /api/transactions`) and webhook deliveries (`GET /api/webhook-deliveries`)
All 13 gateways are normalized
- Merchant platform: self-registration, merchant CRUD, API-key rotation, gateway credential management (encrypted at rest), per-gateway enable/disable
- Refunds (`POST /api/refunds`) — full and partial; cumulative guard ensures the sum of non-failed refunds never exceeds the order amount; a full refund marks the order `refunded`; gateway-supported refunds processed automatically, others recorded as pending manual handling
- Event forwarding to merchant callbacks — async, 3 retries with backoff, dead-letter queue with replay (`replayDeadLetter`)
- Admin: merchants list API + merchant dashboard
- Ops: admin-only Prometheus metrics (`/metrics`), health check (`/health`), OpenAPI spec (`/doc`) + Swagger UI (`/reference`), rate limiting per plan and per endpoint
- Nexus subsystem: Scalev direct checkout → product tier → Telegram channel invite; subscription expiry and renewal reminders via cron
- Versioned database migrations
- TypeScript SDK (`packages/sdk`)

### Out of Scope (current)
- Generic subscription billing / recurring charges — Nexus subscriptions are fulfillment records (Telegram access), not billing
- Payouts/disbursements to merchants or affiliates
- Business analytics / reporting dashboards — `/metrics` exposes operational Prometheus metrics, not business reporting
- KYC, compliance, banking relationships

### Future (v0.2+)
- Webhook secret rotation for merchant callbacks (merchant API-key rotation is implemented; callback-signing secrets are not)
- Subscription billing with recurring charges
- Payout API for affiliates and merchants
- Admin analytics dashboard
- Webhook retry management UI (dead-letter replay is implemented; the UI is not)
- Delivered renewal/expiry notifications for Nexus customers (currently logged only, not sent)

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
