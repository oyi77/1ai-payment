# 02 — API Reference

## Base URL

```
http://localhost:3100
```

Production: `https://pay.1ai.dev` (behind Cloudflare)

The port is configurable via the `PORT` environment variable (default `3100`).

---

## Authentication

Three separate authentication layers are used, depending on the endpoint.

| Layer | Method | Used by |
|-------|--------|---------|
| Merchant API key | `X-API-Key` header | `/api/*` endpoints (project → 1ai-payment) |
| Admin key | `X-Admin-Key` header | `/api/admin/*` endpoints, `/metrics` |
| Webhook signature | Per-gateway (see table below) | `/webhook/*` endpoints (gateway → 1ai-payment) |
| None | — | `/health`, `/doc`, `/reference`, static pages |

### Merchant API keys (`X-API-Key`)

- Issued when a merchant is created (`POST /api/register` or `POST /api/merchants`) or rotated (`POST /api/merchants/{id}/api-key`).
- Format: `1pay_` prefix followed by 64 hex characters. Only the SHA-256 hash of the key is stored — the raw key is shown **once** at issuance and cannot be recovered later.
- Send the raw key in the `X-API-Key` header on every `/api/*` request.
- If the merchant is disabled, the API returns `403 MERCHANT_DISABLED`.
- Legacy fallback: when the `API_KEY` environment variable is set and its value is sent as `X-API-Key`, the request is authenticated as the default merchant (`merch_default`, plan `free`). This exists for backward compatibility.

### Admin key (`X-Admin-Key`)

- Admin endpoints require the `X-Admin-Key` header, compared against the `ADMIN_API_KEY` environment variable using a timing-safe comparison. The same header also protects `GET /metrics`.
- The admin key only authenticates `/api/admin/*` and `/metrics`. It does **not** bypass merchant authentication: every `/api/*` request still requires a valid `X-API-Key`, even when `X-Admin-Key` is also present. Sending only `X-Admin-Key` to a `/api/*` endpoint returns `401 UNAUTHORIZED`.

### Rate limits

| Scope | Limit |
|-------|-------|
| `POST /api/register` | 5 requests / hour per IP |
| `/api/*` | 60 requests / min per API key; overridden by plan tier per window: `free` 30, `pro` 120, `enterprise` 600 |
| `/webhook/*` | 120 requests / min |

- Rate limiting is keyed by merchant (for authenticated requests) or by client IP (for unauthenticated requests, using `X-Forwarded-For` / `CF-Connecting-IP`).
- Legacy `API_KEY` fallback authenticates as `merch_default` (plan `free`), so those requests are limited to 30/min.
- When exceeded, the API returns `429 RATE_LIMITED` with a `Retry-After` header.

---

## Endpoints

### POST /api/register

Public self-service merchant registration. Creates a merchant and returns its API key (shown once). Rate limited to 5/hour per IP.

**Body:**
```typescript
{
  name: string;                    // 1–100 chars
  default_callback_url?: string;   // Optional URL
}
```

**Response (201):**
```typescript
{
  success: true,
  data: {
    merchant: Merchant,            // see Merchant shape below
    api_key: string;               // '1pay_…' — shown ONCE, store it securely
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields |
| 409 | `DUPLICATE` | Merchant name already in use |

---

### GET /health

Health check. No authentication required.

**Response (200):**
```typescript
{
  status: 'ok' | 'degraded';
  version: string;                 // e.g. '0.1.0'
  uptime: number;                  // Process uptime in seconds
  database: 'ok' | 'error';
  gateways: Record<string, 'configured' | 'missing_key'>;  // e.g. { midtrans: 'configured', tripay: 'missing_key' }
}
```

---

### POST /webhook/{gateway}

Gateway callback receiver. One route for all gateways; the `gateway` path segment selects the handler.

`gateway` is one of: `midtrans`, `tripay`, `duitku`, `nowpayments`, `ipaymu`, `scalev`, `xendit`, `telegram_stars`, `telegram_payments`, `paypal`, `x402`, `erc8183`.

**Headers:** per-gateway signature (see table below). No `X-API-Key` required.

**Body:** the gateway's callback payload (any JSON object).

**Flow:**

1. In production, require a TLS connection: if the request URL is not `https://` and the `x-forwarded-proto` header is not `https`, reject with `400 { error: 'HTTPS required' }`.
2. Lowercase-normalize headers, verify the gateway signature (reject with `401` on mismatch).
3. Normalize the payload into a `NormalizedPaymentEvent`.
4. Look up the order (by gateway reference, then by order id).
5. Record the webhook event; duplicate events (`UNIQUE(order_id, gateway, status)`) are acknowledged with `200` without reprocessing (idempotency).
6. Update the order status, then asynchronously forward the event to the project's callback URL.
7. Acknowledge with `200`.

An event for an **unknown order** is still acknowledged with `200` (and logged) so gateways do not retry forever.

**Response (200):**
```typescript
{ ok: true }
```

**Errors:**

| Status | Body | When |
|--------|------|------|
| 400 | `{ error: 'HTTPS required' }` | Plain-HTTP request in production |
| 400 | `{ error: 'Invalid JSON' }` | Body is not valid JSON |
| 400 | `{ error: 'Failed to normalize event' }` | Payload cannot be normalized |
| 401 | `{ error: 'Invalid signature' }` | Signature verification failed |
| 501 | `{ error: 'Unknown gateway', ok: false }` | Unknown gateway path segment |

An event for an **unknown order** is still acknowledged with `200` (and logged) so gateways do not retry forever.

If the owning merchant has no `webhook_secret` configured, the event is acknowledged (`200`) but **not** forwarded to the project — it is logged only.

#### Per-gateway signature verification

| Gateway | Algorithm | Signed data | Where the signature lives |
|---------|-----------|-------------|---------------------------|
| `midtrans` | SHA-512 hash | `order_id + status_code + gross_amount + server_key` | body field `signature_key` |
| `tripay` | HMAC-SHA256 | raw JSON body, key = `TRIPAY_PRIVATE_KEY` | header `X-Signature` (hex) |
| `duitku` | MD5 hash | `merchantCode + amount + merchantOrderId + apiKey` | body field `signature` |
| `nowpayments` | HMAC-SHA512 | raw JSON body, key = `NOWPAYMENTS_IPN_SECRET` | header `x-now-sig` (hex) |
| `ipaymu` | SHA-256 hash | `va + order_id + status + amount + apiKey` | body field `signature` |
| `scalev` | HMAC-SHA256 | raw JSON body, key = `SCALEV_WEBHOOK_SECRET` | header `X-Scalev-Signature` (hex) |
| `xendit` | Token match | — | header `X-Callback-Token` (timing-safe comparison) |
| `telegram_stars` | Token match | — | header `X-Telegram-Bot-Api-Secret-Token` vs `TELEGRAM_WEBHOOK_SECRET` |
| `telegram_payments` | Token match | — | header `X-Telegram-Bot-Api-Secret-Token` vs `TELEGRAM_WEBHOOK_SECRET` |
| `paypal` | PayPal Verify-Webhook-Signature API | `paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url` headers | verified via PayPal API |
| `x402` | On-chain | payment proof (`network`, `txHash`, `asset`, `amount`, `payer`) in body | verified against the blockchain |
| `erc8183` | Attestation signature (ECDSA) | `JSON.stringify({ escrowId, evaluator, approved, notes })` (signer = evaluator) | body field `signature` |

All local comparisons use timing-safe equality. `telegram_stars`/`telegram_payments` verify the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`; if that secret is not configured, verification fails and webhooks are rejected (fail closed). `erc8183` fails closed: the webhook is rejected unless the attestation parses (`escrowId` + `evaluator` present), a `signature` is present, and the recovered signer matches the configured evaluator address (`ERC8183_EVALUATOR_ADDRESS`, or `ERC8183_EVALUATOR_PUBLIC_KEY`). If that configuration is missing, verification fails and webhooks are rejected.

---

### POST /api/payments

Create a payment. Synchronous — waits for the gateway response and returns the payment URL. Requires `X-API-Key`.

**Headers:**
```
X-API-Key: <api_key>
Content-Type: application/json
Idempotency-Key: <unique_key>    # Optional (alternative to body idempotency_key)
```

**Body:**
```typescript
{
  gateway: 'midtrans' | 'tripay' | 'duitku' | 'nowpayments' | 'ipaymu' | 'scalev'
         | 'xendit' | 'telegram_stars' | 'telegram_payments' | 'paypal' | 'x402' | 'erc8183';
  amount: number;                  // Integer, positive, in smallest currency unit (IDR = full Rupiah)
  currency?: string;               // Default: 'IDR'
  payment_method?: string;         // Gateway-specific method code (e.g. 'qris', 'bca_va', 'gopay')
  callback_url: string;            // REQUIRED — URL the normalized event is forwarded to
  idempotency_key?: string;        // Client-generated key; body field OR Idempotency-Key header
  project_order_id?: string;       // Your own order/invoice ID, passed through to callbacks
  customer?: {
    name?: string;
    email?: string;                // Must be a valid email if provided
  };
  metadata?: Record<string, unknown>;  // Arbitrary metadata, preserved through the full lifecycle
}
```

**Response (201):**
```typescript
{
  success: true,
  data: {
    id: string;                    // 1ai-payment order ID
    gateway: string;
    gateway_reference: string | null;  // Gateway's transaction ID
    status: string;                // e.g. 'pending'
    amount: number;
    currency: string;
    payment_method: string | null;
    payment_url: string | null;    // Redirect the user here
    metadata: Record<string, unknown> | null;
    created_at: string;            // ISO timestamp
    updated_at: string;            // ISO timestamp
  }
}
```

Replaying a request with the same `idempotency_key` returns the original order with `200` (same shape) instead of creating a duplicate. The `idempotency_key` column is globally `UNIQUE` — reusing a key that a *different* merchant already used returns `409 DUPLICATE_ORDER` (lookups are scoped to the calling merchant, so a same-merchant replay returns the original order, while any other reuse hits the unique constraint).

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields, unsupported gateway |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `MERCHANT_DISABLED` | Merchant is disabled |
| 409 | `DUPLICATE_ORDER` | Idempotency key already used |
| 502 | `GATEWAY_ERROR` | Gateway API returned an error (order is marked `failed`) |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

### GET /api/payments/{id}

Get a single payment order. Requires `X-API-Key`.

**Response (200):** same shape as the `POST /api/payments` response (`data` only), `status` reflects the current lifecycle state (`pending` / `success` / `failed` / `expired` / `cancelled` / `refunded`).

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 404 | `ORDER_NOT_FOUND` | No order with that ID — including orders belonging to another merchant (existence is not leaked) |
| 500 | `INTERNAL_ERROR` | Failed to fetch order |

---

### GET /api/gateways

List available gateways and their runtime status. Requires `X-API-Key`.

**Response (200):**
```typescript
{
  success: true,
  data: [
    {
      gateway: string;                  // Gateway identifier
      enabled: boolean;
      currencies: string[];             // Supported currencies
      methods: Array<{
        code: string;                   // e.g. 'qris'
        name: string;                   // e.g. 'QRIS'
        currencies: string[];
      }>;
    }
  ]
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

### GET /api/gateways/{gateway}/methods

Get payment methods for a single gateway. Requires `X-API-Key`.

**Response (200):** same shape as one entry of `GET /api/gateways` (`data` is a single `GatewayInfo` object).

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 404 | `GATEWAY_NOT_FOUND` | No gateway with that name |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

### GET /api/transactions

List the authenticated merchant's transactions with pagination and filters. Requires `X-API-Key`.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | — | Filter by payment status |
| `gateway` | string | — | Filter by gateway |
| `from` | string | — | ISO date string, inclusive lower bound |
| `to` | string | — | ISO date string, inclusive upper bound |
| `limit` | integer | `50` | 1–100 |
| `offset` | integer | `0` | ≥ 0 |

**Response (200):**
```typescript
{
  success: true,
  data: {
    transactions: Array<{
      id: string;
      gateway: string;
      gateway_reference: string | null;
      status: string;
      amount: number;
      currency: string;
      payment_method: string | null;
      fee: number;
      net: number;
      created_at: string;
    }>,
    total: number,
    limit: number,
    offset: number
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

### GET /api/webhook-deliveries

List webhook events received for the authenticated merchant, with delivery metadata. Requires `X-API-Key`.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `order_id` | string | — | Filter by order id |
| `limit` | integer | `20` | 1–100 |
| `offset` | integer | `0` | ≥ 0 |

**Response (200):**
```typescript
{
  success: true,
  data: {
    deliveries: Array<{
      id: string;
      gateway: string;
      order_id: string | null;
      status: string | null;
      signature_valid: number;      // 1 if the gateway signature verified
      created_at: string;
    }>,
    total: number
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

### POST /api/webhook-deliveries/{id}/replay

Re-forward a dead-lettered delivery to the owning project's `callback_url`. Requires `X-API-Key`; only the merchant that owns the order may replay a delivery.

**Path parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | Dead-letter delivery id (e.g. `dl_abc123`) |

**Response (200):**
```typescript
{
  success: true,
  data: {
    id: string;                // Dead-letter delivery id
    replayed_at: string | null; // ISO timestamp of the re-forward (null if the stored row has no replay stamp)
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 404 | `NOT_FOUND` | Dead-letter delivery not found, or its order does not belong to the merchant |
| 502 | `REPLAY_FAILED` | Re-forward attempt failed (all retries exhausted) |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

### POST /api/refunds

Create a refund for an order. Requires `X-API-Key`.

**Body:**
```typescript
{
  order_id: string;                 // The 1ai-payment order ID
  amount?: number;                  // Integer, positive. Omit for a full refund.
  reason?: string;                  // Max 500 chars
}
```

**Response (201):**
```typescript
{
  success: true,
  data: {
    id: string;
    order_id: string;
    merchant_id: string;
    amount: number;
    gateway: string;
    gateway_refund_id: string | null;
    status: string;
    reason: string | null;
    created_at: string;
    updated_at: string;
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Invalid body (zod validation failed) |
| 400 | `GATEWAY_ERROR` | Refund rejected: order does not belong to the merchant, order not in a refundable status, amount exceeds the order amount, or the accumulated refund total (excluding `failed` refunds) exceeds the order amount |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 404 | `GATEWAY_ERROR` | Order not found (message contains "not found") |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

> Notes: the order is marked `refunded` only when the gateway actually confirms the refund (refund status `success`). If the gateway does not support refunds (or returns `REFUND_NOT_SUPPORTED`), the refund stays `pending` (manual handling) and the order stays `success`; a gateway rejection marks the refund `failed`. The request returns `201` in all of these cases — the only non-201 outcomes are the `GATEWAY_ERROR` cases above.

---

### GET /api/refunds

List the authenticated merchant's refunds with pagination. Requires `X-API-Key`.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | `20` | 1–100 |
| `offset` | integer | `0` | ≥ 0 |

**Response (200):**
```typescript
{
  success: true,
  data: {
    refunds: Refund[],              // Same shape as the POST /api/refunds response
    total: number,
    limit: number,
    offset: number
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |

---

### POST /api/merchants

Create a merchant. Returns the merchant record and its API key (shown once). Requires `X-API-Key`.

**Body:** same as `POST /api/register` (`name`, `default_callback_url?`). Merchants are always created on the `'free'` plan — there is no `plan` field in the body schema, and unknown fields are stripped by validation, so a `plan` field is silently dropped rather than rejected.

**Response (201):**
```typescript
{
  success: true,
  data: {
    merchant: Merchant,             // see Merchant shape below
    api_key: string;                // '1pay_…' — shown ONCE
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 409 | `DUPLICATE` | Merchant name already in use |

**Merchant shape:**
```typescript
{
  id: string;
  name: string;
  default_callback_url: string | null;
  active: boolean;
  plan: string;                     // 'free' | 'pro' | 'enterprise'
  created_at: string;
  updated_at: string;
}
```

---

### GET /api/merchants

Returns the authenticated merchant's own record (still as an array). Requires `X-API-Key`.

**Response (200):**
```typescript
{
  success: true,
  data: Merchant[]                  // Single-element array (own record only) — no pagination
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |

---

### GET /api/merchants/{id}

Get a single merchant. Requires `X-API-Key`.

**Response (200):** `{ success: true, data: Merchant }`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |
| 404 | `NOT_FOUND` | No merchant with that ID |

---

### PATCH /api/merchants/{id}

Update a merchant. Requires `X-API-Key`.

**Body:**
```typescript
{
  name?: string;                    // 1–100 chars
  default_callback_url?: string;    // URL
}
```

Only `name` and `default_callback_url` are applied — any `active`/`plan` fields in the body are ignored; plan/active changes are admin-only (see `PATCH /api/admin/merchants/{id}`).

**Response (200):** `{ success: true, data: Merchant }`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |
| 404 | `NOT_FOUND` | No merchant with that ID |

---

### POST /api/merchants/{id}/api-key

Rotate a merchant's API key. The previous key is invalidated immediately; the new key is returned once. Requires `X-API-Key`.

**Response (200):**
```typescript
{
  success: true,
  data: {
    merchant_id: string;
    api_key: string;                // New '1pay_…' key — shown ONCE
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |
| 404 | `NOT_FOUND` | No merchant with that ID |

---

### GET /api/merchants/{id}/gateways

List a merchant's gateway configurations. Requires `X-API-Key`.

**Response (200):**
```typescript
{
  success: true,
  data: Array<{
    id: string;
    merchant_id: string;
    gateway: string;
    environment: string;            // 'sandbox' | 'production'
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |
| 404 | `NOT_FOUND` | No merchant with that ID |

---

### PUT /api/merchants/{id}/gateways/{gateway}

Set (create or update) gateway credentials for a merchant. Requires `X-API-Key`.

**Body:**
```typescript
{
  credentials: Record<string, string>;  // e.g. { apiKey: '...', privateKey: '...', merchantCode: '...' }
  environment?: 'sandbox' | 'production';  // Default: 'sandbox'
}
```

Credentials are AES-256-GCM encrypted at rest (requires the `ENCRYPTION_KEY` env var, 64 hex chars).

**Response (200):** a single merchant gateway object (same shape as above).

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields, invalid gateway, encryption misconfigured |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |
| 404 | `NOT_FOUND` | No merchant with that ID |

---

### PATCH /api/merchants/{id}/gateways/{gateway}

Enable or disable a merchant's gateway configuration. Requires `X-API-Key`.

**Body:**
```typescript
{ enabled: boolean }
```

**Response (200):** a single merchant gateway object.

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |
| 404 | `NOT_FOUND` | Merchant or gateway config not found |

---

### DELETE /api/merchants/{id}/gateways/{gateway}

Delete a merchant's gateway configuration. Requires `X-API-Key`.

**Response (200):**
```typescript
{ success: true, data: { deleted: true } }
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |

---

### GET /api/admin/merchants

List all merchants (admin). Requires the `X-Admin-Key` header.

**Response (200):**
```typescript
{
  success: true,
  data: { merchants: Merchant[] }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing or invalid `X-Admin-Key` |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

> Note: these endpoints are registered as plain Hono handlers, not via the OpenAPI route builder, so they do **not** appear in the auto-generated OpenAPI spec at `GET /doc`.

---

### PATCH /api/admin/merchants/{id}

Update a merchant's plan and/or active status (admin). Requires the `X-Admin-Key` header.

**Body:**

```typescript
{
  plan?: 'free' | 'pro' | 'enterprise';
  active?: boolean;
}
```

**Response (200):**

```typescript
{
  success: true,
  data: { merchant: Merchant }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields |
| 401 | `UNAUTHORIZED` | Missing or invalid `X-Admin-Key` |
| 404 | `NOT_FOUND` | No merchant with that ID |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

> Note: like `GET /api/admin/merchants`, this endpoint is a plain Hono handler and does **not** appear in the OpenAPI spec at `GET /doc`.

---

### GET /metrics

Prometheus metrics endpoint. Requires the `X-Admin-Key` header. Not rate limited.

**Response (200):** Prometheus text format.

---

### Static pages & docs

| Path | Content |
|------|---------|
| `GET /` | Landing page (`src/landing/index.html`) |
| `GET /dashboard`, `GET /dashboard/` | Dashboard (`src/dashboard/index.html`, `Cache-Control: no-cache`) |
| `GET /favicon.svg` | Favicon |
| `GET /doc` | OpenAPI JSON spec (OpenAPI 3.1.0, title `1ai-payment`, version `0.1.0`) — always in sync with the code |
| `GET /reference` | Swagger UI (auto-generated). `persistAuthorization` is enabled when the URL contains `?key=` |

---

## Error Response Format

All `/api/*` errors follow a consistent envelope:

```typescript
{
  success: false,
  error: {
    code: string,                   // Machine-readable error code
    message: string                 // Human-readable message
  }
}
```

Webhook endpoints use a simpler shape instead: `{ error: string }` (e.g. `{ error: 'Invalid signature' }`), and the unknown-gateway response is `{ error: 'Unknown gateway', ok: false }`.

### Error codes

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields |
| 400 | `GATEWAY_ERROR` | Refund rejected (order not refundable, amount exceeds, not the merchant's order) |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 401 | `INVALID_SIGNATURE` | Webhook signature mismatch |
| 403 | `MERCHANT_DISABLED` | Merchant is disabled |
| 403 | `FORBIDDEN` | Merchant ID does not belong to the authenticated merchant |
| 404 | `ORDER_NOT_FOUND` | Order not found |
| 404 | `GATEWAY_NOT_FOUND` | Gateway not found |
| 404 | `NOT_FOUND` | Merchant / resource not found |
| 404 | `GATEWAY_ERROR` | Order not found on refund (message contains "not found") |
| 409 | `DUPLICATE` | Merchant name already in use |
| 409 | `DUPLICATE_ORDER` | Idempotency key already used |
| 429 | `RATE_LIMITED` | Rate limit exceeded (includes `Retry-After` header) |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 502 | `GATEWAY_ERROR` | Gateway API returned an error |

---

## Forwarded Event Format (1ai-payment → Project)

When a payment status changes, 1ai-payment POSTs the normalized event to the project's `callback_url`. Forwarding is asynchronous — the webhook returns `200` immediately and the forward happens in the background.

**Headers:**
```
Content-Type: application/json
X-Payment-Signature: <hmac_sha256>   # HMAC-SHA256 of the raw JSON payload, key = project's webhook_secret
X-Payment-Event: payment.success     # Event type
```

**Body:**
```typescript
{
  event: 'payment.success' | 'payment.pending' | 'payment.failed'
       | 'payment.expired' | 'payment.cancelled' | 'payment.refunded';
  gateway: string;
  order_id: string;                  // 1ai-payment order ID
  project_order_id: string | null;   // The project's own order/invoice ID (passthrough)
  gateway_reference: string | null;
  status: string;                    // 'success' | 'pending' | 'failed' | 'expired' | 'cancelled' | 'refunded'
  amount: number;
  currency: string;
  payment_method: string | null;
  paid_at: string | null;            // ISO timestamp
  metadata: Record<string, unknown> | null;  // Project metadata (passthrough)
  timestamp: string;                 // ISO timestamp of forwarding
}
```

**Project MUST:**
1. Verify `X-Payment-Signature` (HMAC-SHA256 over the raw request body, keyed with its `webhook_secret`) — reject anything that does not match.
2. Return 2xx within 30 seconds.
3. Be idempotent (the same `order_id` may arrive multiple times).

**Retry behavior:** on a non-2xx response or network failure, 1ai-payment retries with exponential backoff (`5s → 30s → 300s`, 3 attempts, 30s request timeout). On success the outcome is recorded on the order (`forward_status` HTTP code + `forward_attempts`) **without** changing the payment status. If all attempts fail, the event is written to the dead-letter store and no further retries are made. Dead-lettered deliveries can be re-forwarded via `POST /api/webhook-deliveries/{id}/replay` (merchant-scoped, stamps `replayed_at` on success) or the service-level `replayDeadLetter` helper: either re-forwards the stored event signed with the merchant's `webhook_secret`.

---

## TypeScript SDK (`packages/sdk`)

Published as `@1ai/payment` (TypeScript, built to `dist/`). Provides typed wrappers around the REST API.

**Install / import:**

```typescript
import { OneAIPayment, APIError } from '@1ai/payment';

const payment = new OneAIPayment({ apiKey: '1pay_xxxxx', baseUrl: 'https://pay.1ai.dev' });
```

- `apiKey` — required; sent as `X-API-Key` on every request.
- `baseUrl` — optional, defaults to `http://localhost:3100`.

**Errors:** any non-success envelope throws `APIError`, which extends `Error` and carries `code` (server error code, or `HTTP_ERROR` for non-JSON responses), `message`, and `status` (the HTTP status).

**Methods:**

| Method | API call | Returns |
|--------|----------|---------|
| `create(params)` | `POST /api/payments` | `Order` (incl. `payment_url`) |
| `get(orderId)` | `GET /api/payments/{id}` | `Order` |
| `listTransactions(params?)` | `GET /api/transactions` | `{ transactions, total, limit, offset }` |
| `refund(orderId, amount?, reason?)` | `POST /api/refunds` | `Refund` |
| `listRefunds(limit?, offset?)` | `GET /api/refunds` | `{ refunds, total }` |
| `listGateways()` | `GET /api/gateways` | `GatewayInfo[]` |
| `getGatewayMethods(gateway)` | `GET /api/gateways/{gateway}/methods` | `GatewayInfo` |
| `listWebhookDeliveries(params?)` | `GET /api/webhook-deliveries` | `{ deliveries, total }` |
| `register(params)` | `POST /api/register` (public, no API key needed) | `{ merchant, api_key }` |

`CreatePaymentParams` fields: `gateway`, `amount`, `callback_url` (required); `currency?`, `payment_method?`, `idempotency_key?`, `project_order_id?`, `customer?`, `metadata?` (optional).
