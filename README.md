# 1ai-payment

Payment gateway **aggregator** microservice for the 1ai-ecosystem.

**Purpose:** Unified API for creating payments across gateways (Midtrans, Tripay, Duitku, NOWPayments) and routing callbacks to the correct project.

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

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/midtrans` | POST | Midtrans callback receiver |
| `/webhook/tripay` | POST | Tripay callback receiver |
| `/webhook/duitku` | POST | Duitku callback receiver |
| `/webhook/nowpayments` | POST | NOWPayments callback receiver |
| `/api/payments` | POST | Create payment (returns payment_url) |
| `/api/payments/:id` | GET | Get payment status |
| `/api/gateways` | GET | List available gateways |
| `/api/gateways/:gateway/methods` | GET | List payment methods for a gateway |
| `/health` | GET | Health check |

### Create Payment Example

```bash
curl -X POST http://localhost:3100/api/payments \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-key-123" \
  -d '{
    "gateway": "midtrans",
    "amount": 100000,
    "currency": "IDR",
    "payment_method": "qris",
    "callback_url": "https://your-app.com/callback",
    "metadata": { "user_id": "123", "plan": "pro" }
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "pay_xyz789",
    "gateway": "midtrans",
    "gateway_reference": "trx_abc123",
    "status": "pending",
    "amount": 100000,
    "currency": "IDR",
    "payment_method": "qris",
    "payment_url": "https://sandbox.midtrans.com/pay/...",
    "created_at": "2026-07-04T10:00:00.000Z"
  }
}
```

## Architecture

See [docs/01-architecture.md](docs/01-architecture.md) for detailed architecture.

```
┌─────────────────────────────────────────────────────┐
│  Payment Gateways (Midtrans/Tripay/Duitku/etc)      │
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
│              Forwarder → Project Callback           │
└─────────────────────────┬───────────────────────────┘
                          │ internal HTTP webhook
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
     1ai-content      1sub         1ai-affiliate
```

## Tech Stack

- **Runtime:** Bun (TypeScript)
- **Framework:** Hono (lightweight, edge-ready)
- **Database:** LibSQL/SQLite (local, no external DB needed)
- **Deploy:** Same VPS as other 1ai services

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/00-overview.md](docs/00-overview.md) | System overview and goals |
| [docs/01-architecture.md](docs/01-architecture.md) | Architecture and data flow |
| [docs/02-api-reference.md](docs/02-api-reference.md) | API contracts and schemas |
| [docs/03-gateway-specs.md](docs/03-gateway-specs.md) | Per-gateway integration specs |
| [docs/04-rollout-plan.md](docs/04-rollout-plan.md) | Migration and rollout plan |

## License

Proprietary — 1ai-ecosystem internal service.