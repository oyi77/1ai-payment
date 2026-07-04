# 02 — API Reference

## Base URL

```
http://localhost:3100
```

Production: `https://pay.1ai.dev` (behind Cloudflare)

## Authentication

| Layer | Method | When |
|-------|--------|------|
| Webhook endpoints (`/webhook/*`) | Signature per gateway | Gateway → 1ai-payment |
| API endpoints (`/api/*`) | `X-API-Key` header | Project → 1ai-payment |
| Health endpoint (`/health`) | None | Monitoring |

API key issued per-project. Internal use: single shared key via `PAYMENT_API_KEY` env var.

---

## Endpoints

### POST /api/payments

Create a payment. Returns a `payment_url` the user should be redirected to.

**Headers:**
```
X-API-Key: <api_key>
Content-Type: application/json
Idempotency-Key: <unique_key>    # Optional but recommended
```

**Body:**
```typescript
{
  gateway: 'midtrans' | 'tripay' | 'duitku' | 'nowpayments';
  amount: number;                  // In smallest currency unit (e.g., cents, IDR 1 = 1)
  currency?: string;               // Default: 'IDR'
  project_order_id?: string;       // Project's internal order ID
  callback_url?: string;           // Override project default callback URL
  payment_method?: string;         // Preferred method (gateway-specific). Omit for gateway default.
  metadata?: Record<string, unknown>; // Arbitrary data (max 4KB JSON)
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
}
```

**Response (201):**
```typescript
{
  success: true,
  data: {
    id: string;                    // 1ai-payment order ID (UUID)
    gateway: string;
    gateway_reference: string;     // Gateway's transaction ID
    status: 'pending';
    amount: number;
    currency: string;
    payment_url: string;           // Redirect user here
    payment_method: string | null;
    expires_at: string | null;     // ISO timestamp (gateway-dependent)
    created_at: string;            // ISO timestamp
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing/invalid fields |
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 409 | `DUPLICATE_ORDER` | Idempotency key already used (returns original order) |
| 502 | `GATEWAY_ERROR` | Gateway API returned error |
| 503 | `GATEWAY_UNAVAILABLE` | Gateway API unreachable |

---

### GET /api/payments/:id

Get payment status. Useful for polling when webhook hasn't arrived yet.

**Headers:**
```
X-API-Key: <api_key>
```

**Response (200):**
```typescript
{
  success: true,
  data: {
    id: string;
    gateway: string;
    gateway_reference: string | null;
    status: 'pending' | 'success' | 'failed' | 'expired' | 'cancelled';
    amount: number;
    currency: string;
    payment_method: string | null;
    payment_url: string | null;
    metadata: Record<string, unknown> | null;
    paid_at: string | null;
    created_at: string;
    updated_at: string;
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 404 | `ORDER_NOT_FOUND` | No order with that ID |

---

### GET /api/gateways

List available gateways and their status.

**Headers:**
```
X-API-Key: <api_key>
```

**Response (200):**
```typescript
{
  success: true,
  data: [
    {
      gateway: 'midtrans',
      enabled: true,
      currencies: ['IDR'],
      methods: ['bank_transfer', 'qris', 'gopay', 'shopeepay', 'credit_card', 'echannel']
    },
    {
      gateway: 'tripay',
      enabled: true,
      currencies: ['IDR'],
      methods: ['bank_transfer', 'qris', 'gopay', 'shopeepay', 'alfamart', 'indomaret']
    },
    {
      gateway: 'duitku',
      enabled: true,
      currencies: ['IDR'],
      methods: ['bank_transfer', 'qris', 'gopay', 'ovo', 'dana', 'shopeepay']
    },
    {
      gateway: 'nowpayments',
      enabled: true,
      currencies: ['USD', 'EUR', 'BTC', 'ETH', 'USDT', 'USDC'],
      methods: ['crypto']
    }
  ]
}
```

---

### GET /api/gateways/:gateway/methods

Get available payment methods for a specific gateway.

**Headers:**
```
X-API-Key: <api_key>
```

**Response (200):**
```typescript
{
  success: true,
  data: {
    gateway: 'midtrans',
    methods: [
      { code: 'bank_transfer', name: 'Bank Transfer', currencies: ['IDR'] },
      { code: 'qris', name: 'QRIS', currencies: ['IDR'] },
      { code: 'gopay', name: 'GoPay', currencies: ['IDR'] },
      { code: 'shopeepay', name: 'ShopeePay', currencies: ['IDR'] },
      { code: 'credit_card', name: 'Credit Card', currencies: ['IDR'] },
      { code: 'echannel', name: 'Mandiri Bill', currencies: ['IDR'] }
    ]
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing/invalid API key |
| 404 | `GATEWAY_NOT_FOUND` | No gateway with that ID |

---

### POST /webhook/midtrans

Midtrans notification callback. Verified with SHA-512 signature.

**Headers:**
```
Content-Type: application/json
```

**Body:** (Midtrans notification format — see gateway specs)

**Response (200):**
```typescript
{ ok: true }
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_BODY` | Missing required fields |
| 401 | `INVALID_SIGNATURE` | Signature mismatch |

---

### POST /webhook/tripay

Tripay callback. Verified with HMAC-SHA256.

**Headers:**
```
Content-Type: application/json
X-Signature: <hmac_sha256>
```

**Body:** (Tripay callback format — see gateway specs)

**Response (200):**
```typescript
{ ok: true }
```

---

### POST /webhook/duitku

Duitku callback. Verified with MD5 signature.

**Headers:**
```
Content-Type: application/json
```

**Body:** (Duitku callback format — see gateway specs)

**Response (200):**
```typescript
{ ok: true }
```

---

### POST /webhook/nowpayments

NOWPayments IPN. Verified with HMAC-SHA512.

**Headers:**
```
Content-Type: application/json
x-now-sig: <hmac_sha512>
```

**Body:** (NOWPayments IPN format — see gateway specs)

**Response (200):**
```typescript
{ ok: true }
```

---

### GET /health

Health check. No authentication required.

**Response (200):**
```typescript
{
  status: 'ok',
  version: '0.1.0',
  uptime: number,                    // Seconds since start
  database: 'ok' | 'error',
  gateways: {
    midtrans: 'ok' | 'misconfigured' | 'unknown',
    tripay: 'ok' | 'misconfigured' | 'unknown',
    duitku: 'ok' | 'misconfigured' | 'unknown',
    nowpayments: 'ok' | 'misconfigured' | 'unknown'
  }
}
```

---

## Error Response Format

All errors follow a consistent envelope:

```typescript
{
  success: false,
  error: {
    code: string,                     // Machine-readable error code
    message: string,                  // Human-readable message
    details?: Record<string, unknown> // Additional context (never secrets)
  }
}
```

## Forwarded Event Format (1ai-payment → Project)

When payment status changes, 1ai-payment POSTs to the project's `callback_url`:

**Headers:**
```
Content-Type: application/json
X-Payment-Signature: <hmac_sha256>   # Signed with project's webhook_secret
X-Payment-Event: payment.success     # Event type
```

**Body:**
```typescript
{
  event: 'payment.success' | 'payment.pending' | 'payment.failed' | 'payment.expired' | 'payment.cancelled';
  gateway: string;
  order_id: string;                  // 1ai-payment order ID
  gateway_reference: string | null;
  status: 'success' | 'pending' | 'failed' | 'expired' | 'cancelled';
  amount: number;
  currency: string;
  payment_method: string | null;
  paid_at: string | null;            // ISO timestamp
  metadata: Record<string, unknown> | null;  // Project's metadata (passthrough)
  timestamp: string;                 // ISO timestamp of forwarding
}
```

**Project MUST:**
1. Verify `X-Payment-Signature` using its `webhook_secret`
2. Return 2xx within 30 seconds
3. Be idempotent (same `order_id` may arrive multiple times)

**If project returns non-2xx:** Retry with exponential backoff (5s → 30s → 300s). After 3 failures, mark order as `forward_failed`.
