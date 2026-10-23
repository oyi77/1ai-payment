# 1ai-payment

Payment gateway **aggregator** microservice for the 1ai-ecosystem.

**Purpose:** Unified API for creating payments across 14 payment gateways plus 2 bank-mutation aggregators — 16 registered, 15 selectable (`scalev` parked, hidden from API/UI surfaces) — routing callbacks to the correct project.

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
- Multi-tenant: merchants self-register via `/api/register`, receive an API key (shown once), and can attach their own encrypted gateway credentials with fallback to platform keys
- Refund, transaction-log, and webhook-delivery-log endpoints
- Landing page, dashboard, admin API (`X-Admin-Key`), and Prometheus-style `/metrics`
- SQLite database and schema migrations run automatically on startup
- TypeScript SDK in `packages/sdk` (`@1ai/payment`)

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

On first start the SQLite database is created and schema migrations run automatically — no manual DB setup.

## API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Service health + gateway config status |
| `/metrics` | GET | Admin key | Prometheus-style metrics |
| `/api/register` | POST | — | Create merchant; returns API key (shown once) |
| `/api/payments` | POST | API key | Create payment (returns payment_url) |
| `/api/payments/:id` | GET | API key | Get payment status |
| `/api/gateways` | GET | API key | List available gateways |
| `/api/gateways/:gateway/methods` | GET | API key | List payment methods for a gateway |
| `/api/transactions` | GET | API key | List transactions (status/gateway/date filters, paginated) |
| `/api/webhook-deliveries` | GET | API key | List webhook deliveries + forward status |
| `/api/webhook-deliveries/:id/replay` | POST | API key | Replay a dead-lettered delivery |
| `/api/saved-methods` | GET / POST | API key | List / vault reusable gateway tokens |
| `/api/saved-methods/:methodId` | GET / PATCH / DELETE | API key | Get / update / remove a saved method |
| `/api/merchants` | POST / GET | API key | Create / list merchants |
| `/api/merchants/:id` | GET / PATCH | API key | Get / update merchant |
| `/api/merchants/:id/api-key` | POST | API key | Rotate merchant API key |
| `/api/merchants/:id/gateways` | GET / PUT / PATCH / DELETE | API key | Manage per-merchant gateway credentials |
| `/api/admin/merchants` | GET | Admin key | Admin: list all merchants (in OpenAPI since Sweep49) |
| `/api/admin/merchants/:id` | PATCH | Admin key | Admin: set plan / active (in OpenAPI since Sweep49) |
| `/api/admin/merchants/:id/api-key` | POST | Admin key | Admin: recovery key reset (in OpenAPI since Sweep49) |
| `/webhook/:gateway` | POST | Signature | Receive gateway callback |
| `/`, `/dashboard` | GET | — | Landing page + dashboard (static) |

Auth:

- All `/api/*` endpoints require the `X-API-Key` header, except `/api/register` (public).
- `/api/admin/*` endpoints require the `X-Admin-Key` header instead. The admin key never bypasses merchant auth: `/api/*` routes still require a valid `X-API-Key` and always scope to the authenticated merchant.
- Webhook endpoints are authenticated per gateway via timing-safe signature comparison (HMAC/hash), gateway-native verification (PayPal Verification API), an on-chain transaction check for x402, or an escrow attestation signature for ERC-8183 (`ERC8183_EVALUATOR_ADDRESS`).

### Supported Gateways

| Gateway | Key | Currencies | Signature |
|---------|-----|------------|-----------|
| Midtrans | `midtrans` | IDR | SHA-512 |
| Tripay | `tripay` | IDR | HMAC-SHA256 |
| Duitku | `duitku` | IDR | MD5 |
| NOWPayments | `nowpayments` | USD, EUR, multi-crypto | HMAC-SHA512 |
| iPaymu | `ipaymu` | IDR | SHA-256 |
| Scalev | `scalev` | IDR | HMAC-SHA256 — parked (quota exhausted, hidden from UI) |
| Xendit | `xendit` | IDR | X-Callback-Token |
| Telegram Stars | `telegram_stars` | XTR | Telegram Bot API |
| Telegram Payments | `telegram_payments` | USD, EUR, GBP, IDR | Telegram Bot API |
| PayPal | `paypal` | USD, EUR, GBP, CAD, AUD | PayPal Verification API (SHA256withRSA) |
| x402 | `x402` | USD (USDC) | On-chain tx verification via RPC |
| ERC-8183 | `erc8183` | USD | Escrow attestation signature |
| Lynk.id | `lynk` | IDR | HMAC-SHA256 / merchant-key header match |
| Mutasiku | `mutasiku` | IDR | HMAC-SHA256 over compact JSON (mutation aggregator, no payment creation) |
| Moota | `moota` | IDR | HMAC-SHA256 over raw body (mutation aggregator, no payment creation) |
| Saweria | `saweria` | IDR | Webhook inbound disabled (unsigned callbacks answered `501`); payment creation only |
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

Errors use a uniform envelope: `{ "success": false, "error": { "code", "message" } }` (e.g. `INVALID_BODY`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `GATEWAY_ERROR`), returned with the appropriate HTTP status. Cross-tenant access to another merchant's `:id` resources returns `404 NOT_FOUND`, not `403`, so resource existence is not disclosed. Client faults raised inside the router keep their status and envelope: an unsupported or missing `Content-Type` on a JSON route returns `415 BAD_REQUEST` and an oversized body returns `413 PAYLOAD_TOO_LARGE` — neither degrades to `500 INTERNAL_ERROR`. This matters behind Cloudflare, which replaces 5xx origin bodies with its own error page, so a 5xx would hide the JSON contract from the caller.

### Idempotency

Pass `Idempotency-Key` header (or `idempotency_key` in body) to prevent duplicate orders on retries:

```bash
curl -X POST http://localhost:3100/api/payments \
  -H "X-API-Key: your-api-key" \
  -H "Idempotency-Key: order-usr789-1720180000" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

Retrying with the same key returns the existing order (`200`) instead of creating a duplicate; a different key with conflicting order data returns `409`. Idempotency keys are unique globally, so reusing another merchant's key also returns `409` (cross-tenant collision is rejected, not served).

### Forwarding & Refunds

- Callback forwarding is async: the webhook responds `200` immediately, then the forwarder posts the normalized event to the project's `callback_url` with `5s → 30s → 300s` backoff (3 attempts). Success records `forward_status`/`forward_attempts` on the order without touching payment status; after 3 failures the event goes to the dead-letter store. Dead-lettered deliveries can be re-forwarded via `POST /api/webhook-deliveries/:id/replay` or the service-level `replayDeadLetter(id)` helper.
- Direct checkouts (Lynk.id / Scalev links created outside the API) arrive as webhooks with no prior order row. For `lynk`, the webhook handler now persists the order (via `createOrder`, then `updateOrderStatus`) before forwarding, so the forward's `markForwarded()` has a target: `forward_status`, `forward_attempts`, `forwarded_at` land on a real row and dead letters reference an order that exists. If persisting fails, the handler logs and returns `200` without forwarding rather than delivering an untracked event. `scalev` direct checkouts still forward without a row (nexus fulfillment path).
- Refunds are cumulative: a refund that would push total refunded amount past the order amount is rejected. A full refund marks the order `refunded` only when the gateway confirms the refund (refund status `success`); gateway rejection marks the refund `failed` (order stays `success`); gateways that don't support refunds create the refund as `pending` for manual handling (order stays `success`).
- Replay protection is split across two layers. A gateway-supplied request id (`X-Request-Id`, PayPal-Request-Id, etc.) is claimed in `webhook_requests` **only after** every pre-persist gate has passed — signature, order lookup, amount reconciliation. A callback skipped at one of those gates (underpaid success, unknown order) returns `200` without claiming the id, so the gateway's retry with the same id is still processed; claiming earlier made a withdrawn event permanently unprocessable, since the retry matched its own stale row and got a "duplicate" `200` for a payment that was never recorded. The atomic dedupe stays the `UNIQUE` index on `webhook_events(order_id, gateway, status)`: an exact event replay is stopped there and returns the same `200`. The claim is written before the `webhook_events` INSERT, so a **non-duplicate** persistence failure deletes the claim before returning `200` — that attempt recorded nothing, and the retry has to be processable. A duplicate rejection keeps the claim, which is correct: the event it guards is already recorded. Request ids longer than 128 characters are ignored rather than rejected (the event is still recorded and forwarded, the id is simply not stored), so a malformed correlation header cannot turn a valid payment callback into a permanent gateway retry loop.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Payment Gateways (16 registered)                   │
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
│              Merchant Registry (multi-tenant)       │
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
- **SDK:** TypeScript SDK in `packages/sdk` (`@1ai/payment`) — `OneAIPayment` class with `createPayment`, `getPayment`, `register`, `listWebhookDeliveries`, `getGatewayMethods`, and refund helpers; throws typed `APIError { code, message, status }`.
- **Deploy:** Same VPS as other 1ai services

## API Reference

OpenAPI spec is **auto-generated from Zod schemas** in `src/schemas.ts` and route definitions. No manual YAML to maintain.

| Endpoint | Description |
|----------|-------------|
| `/reference` | Interactive Swagger UI (try-it-out, auth persistence always on) |
| `/doc` | OpenAPI 3.1 JSON spec with unique deterministic `operationId`s; paths/tags/servers decorated in `src/services/openapi-document.ts` — see [docs/06-openapi-derivation.md](docs/06-openapi-derivation.md) |

Open `/reference`, click Authorize, paste your API key as the `X-API-Key` header value. `persistAuthorization` keeps it across reloads. API keys are never accepted in query params (they leak into access logs and browser history).

## Documentation

| Doc | Description |
|-----|-------------|
| [docs/00-overview.md](docs/00-overview.md) | System overview and goals |
| [docs/01-architecture.md](docs/01-architecture.md) | Architecture and data flow |
| [docs/02-api-reference.md](docs/02-api-reference.md) | API contracts and schemas |
| [docs/03-gateway-specs.md](docs/03-gateway-specs.md) | Per-gateway integration specs |
| [docs/04-rollout-plan.md](docs/04-rollout-plan.md) | Migration and rollout plan |
| [docs/05-product-roadmap.md](docs/05-product-roadmap.md) | Product roadmap: internal tool → SaaS (atomic steps) |
| [docs/06-openapi-derivation.md](docs/06-openapi-derivation.md) | `/doc` contract: operationId derivation, tag/path ordering, servers |

## Adding a New Gateway

1. Create `src/gateways/<name>/` — implement `PaymentGateway` interface from `base.ts` (single file, or a directory with `payment.ts` / `webhook.ts` / `index.ts`)
2. Register in `src/gateways/index.ts`
3. Add gateway name to `GATEWAY_NAMES` in `src/schemas.ts` — this auto-generates the `POST /webhook/:gateway` route
4. Add env vars to `src/config/env.ts` and `.env.example`

## License

Proprietary — 1ai-ecosystem internal service.
