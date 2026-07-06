# 1ai-payment

Payment gateway **aggregator** microservice for the 1ai-ecosystem.

**Purpose:** Unified API for creating payments across 10 gateways and routing callbacks to the correct project.

## Problem

Payment gateways have fragmented APIs, different callback formats, and typically allow registering **one callback URL** in their dashboard. With multiple projects needing payment (1ai-content, 1sub, 1ai-affiliate, future projects), each would need its own gateway account or callback URL — not scalable.

## Solution

1ai-payment provides a **single unified API** for all gateways:

```
Project → POST /api/payments (1ai-payment) → Gateway API → User pays → Callback → Forward to project
```

- One integration point for all gateways
- Centralized signature verification
- Normalized event format across all gateways
- Metadata preserved through full lifecycle

## Quick Start

```bash
# Install
bun install

# Configure
cp .env.example .env
# Edit .env with gateway credentials

# Dev
bun run dev

# Test
bun test

# Build
bun run build
```

## API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Service health + gateway config status |
| `/api/payments` | POST | API key | Create payment (returns payment_url) |
| `/api/payments/:id` | GET | API key | Get payment status |
| `/api/gateways` | GET | API key | List available gateways |
| `/api/gateways/:gateway/methods` | GET | API key | List payment methods for a gateway |
| `/webhook/:gateway` | POST | Signature | Receive gateway callback |

All `/api/*` endpoints require `X-API-Key` header.
Webhook endpoints are authenticated via per-gateway HMAC signature verification.

### Supported Gateways

| Gateway | Key | Currencies | Signature |
|---------|-----|------------|-----------|
| Midtrans | `midtrans` | IDR | SHA-512 |
| Tripay | `tripay` | IDR | HMAC-SHA256 |
| Duitku | `duitku` | IDR | MD5 |
| NOWPayments | `nowpayments` | USD, multi-crypto | HMAC-SHA512 |
| iPaymu | `ipaymu` | IDR | SHA-256 |
| Scalev | `scalev` | IDR | HMAC-SHA256 |
| Xendit | `xendit` | IDR | X-Callback-Token |
| Telegram Stars | `telegram_stars` | XTR | Telegram Bot API |
| Telegram Payments | `telegram_payments` | Multi-currency | Telegram Bot API |
| PayPal | `paypal` | USD, multi-currency | Webhook signature |

### Create Payment

```bash
curl -X POST http://localhost:3100/api/payments \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "gateway": "midtrans",
    "amount": 100000,
    "currency": "IDR",
    "payment_method": "qris",
    "callback_url": "https://your-app.com/payment/callback",
    "customer": { "name": "Budi Santoso", "email": "budi@example.com" },
    "metadata": { "user_id": "usr_789", "plan": "pro" }
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "pay_01j2k3l4m5n6",
    "gateway": "midtrans",
    "gateway_reference": "trx_abc123",
    "status": "pending",
    "amount": 100000,
    "currency": "IDR",
    "payment_method": "qris",
    "payment_url": "https://sandbox.midtrans.com/pay/abc123",
    "metadata": { "user_id": "usr_789", "plan": "pro" },
    "created_at": "2026-07-05T10:00:00.000Z",
    "updated_at": "2026-07-05T10:00:01.000Z"
  }
}
```

Redirect the end user to `data.payment_url` to complete payment.

### Idempotency

Pass `Idempotency-Key` header (or `idempotency_key` in body) to prevent duplicate orders on retries:

```bash
curl -X POST http://localhost:3100/api/payments \
  -H "X-API-Key: your-api-key" \
  -H "Idempotency-Key: order-usr789-1720180000" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Payment Gateways (10 providers)                    │
└─────────────────────────┬───────────────────────────┘
                          │ single callback per gateway
                          ▼
┌─────────────────────────────────────────────────────┐
│              1ai-payment (this service)              │
│                                                      │
│  API: POST /api/payments → Gateway.createPayment()  │
│                                                      │
│  Webhook Receiver → Signature Verify → Normalize    │
│                          │                           │
│                          ▼                           │
│              Order Registry (LibSQL)                │
│                          │                           │
│                          ▼                           │
│         Forwarder (async, 3-retry) → callback_url   │
└─────────────────────────┬───────────────────────────┘
                          │ normalized event (HTTP POST)
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
     1ai-content      1sub         1ai-affiliate
```

See [docs/01-architecture.md](docs/01-architecture.md) for full architecture.

## Tech Stack

- **Runtime:** Bun (TypeScript)
- **Framework:** Hono + @hono/zod-openapi (auto-generated OpenAPI from Zod schemas)
- **Database:** LibSQL/SQLite (local, no external DB needed)
- **Deploy:** Same VPS as other 1ai services

## API Reference

OpenAPI spec is **auto-generated from Zod schemas** in `src/schemas.ts` and route definitions. No manual YAML to maintain.

| Endpoint | Description |
|----------|-------------|
| `/reference` | Interactive Swagger UI (try-it-out, auth persistence) |
| `/doc` | Auto-generated OpenAPI 3.1 JSON spec |

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/00-overview.md](docs/00-overview.md) | System overview and goals |
| [docs/01-architecture.md](docs/01-architecture.md) | Architecture and data flow |
| [docs/02-api-reference.md](docs/02-api-reference.md) | API contracts and schemas |
| [docs/03-gateway-specs.md](docs/03-gateway-specs.md) | Per-gateway integration specs |
| [docs/04-rollout-plan.md](docs/04-rollout-plan.md) | Migration and rollout plan |
| [docs/05-product-roadmap.md](docs/05-product-roadmap.md) | Product roadmap: internal tool → SaaS (atomic steps) |

## Adding a New Gateway

1. Create `src/gateways/<name>/` — implement `PaymentGateway` interface from `base.ts`
2. Register in `src/gateways/index.ts`
3. Add gateway name to `GATEWAY_NAMES` in `src/schemas.ts`
4. Add env vars to `src/config/env.ts` and `.env.example`

## License

Proprietary — 1ai-ecosystem internal service.
