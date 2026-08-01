# 03 — Gateway Specifications

## Overview

Each payment gateway has unique APIs, callback formats, signature algorithms, and status mappings. This document specifies how 1ai-payment handles each gateway for both **payment creation** and **webhook processing**.

---

## Common Interface

Each gateway implements:

```typescript
type PaymentStatus =
  | "success"
  | "pending"
  | "failed"
  | "expired"
  | "cancelled"
  | "refunded";

interface PaymentGateway {
  readonly name: string;

  /** Create a payment via gateway API */
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;

  /** List available payment methods */
  getPaymentMethods(): PaymentMethod[];

  /**
   * Verify webhook signature. MUST use timing-safe comparison
   * (crypto.timingSafeEqual). May be async — some gateways verify
   * via an external API (e.g. PayPal).
   */
  verifySignature(
    body: unknown,
    headers: Record<string, string>,
  ): boolean | Promise<boolean>;

  /**
   * Normalize gateway-specific payload to the standard event format.
   * Throws if the payload is malformed.
   */
  normalizeEvent(
    body: unknown,
    metadata?: Record<string, unknown> | null,
  ): NormalizedPaymentEvent;

  /**
   * Refund a payment. Optional — gateways without refund support
   * should throw GatewayError('REFUND_NOT_SUPPORTED').
   */
  refundPayment?(gatewayRef: string, amount: number): Promise<RefundResult>;
}

interface CreatePaymentParams {
  orderId: string;          // 1ai-payment order ID
  amount: number;           // In smallest currency unit
  currency: string;
  paymentMethod?: string;
  customerName?: string;
  customerEmail?: string;
  metadata?: Record<string, unknown>;
}

interface CreatePaymentResult {
  gatewayReference: string; // Gateway's transaction ID
  paymentUrl: string;       // URL to redirect user to (JSON document for x402 / erc8183)
  expiresAt?: string;       // ISO timestamp
}

interface NormalizedPaymentEvent {
  gateway: string;
  order_id: string;
  gateway_reference: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  payment_method: string;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface PaymentMethod {
  code: string;
  name: string;
  currencies: string[];
}

interface RefundResult {
  gatewayRefundId: string;
  status: "success" | "pending" | "failed";
}
```

### Webhook Routing (shared)

All gateways share one receiver. For every entry in `GATEWAY_NAMES` (`src/schemas.ts` — 12 gateways) the route `POST /webhook/{gateway}` is auto-registered in `src/routes/webhook.ts`, and all headers are lowercased before the gateway handler runs. The shared flow is:

1. **Verify** — the raw request body is read as text before parsing, so HMAC gateways verify over the exact received bytes: nowpayments, tripay, and scalev implement `verifySignatureRaw` and are verified over the unmodified body; all others use `gateway.verifySignature(body, headers)`. Reject with 401 if invalid.
2. **Normalize** — `gateway.normalizeEvent(body, null)` → `NormalizedPaymentEvent`.
3. **Resolve order** — for scalev, `order_id` is first recovered from `notes`; then lookup tries `gateway_reference`, then `order_id`.
4. **Insert webhook event** — `webhook_events` table with `UNIQUE(order_id, gateway, status)`; a duplicate callback hits the constraint and returns 200 (idempotency).
5. **Update order status** — `order.service.updateOrderStatus(...)`.
6. **Forward to owning project** — `forwarder.service.forwardEvent(...)` runs async with retries; the webhook returns 200 immediately (forwarding is not awaited).

If the order cannot be found, the event is still recorded and 200 is returned (for scalev, a direct-checkout Nexus fulfillment is also attempted).

In production (`NODE_ENV === "production"`), webhook requests are rejected with 400 unless the request URL starts with `https://` or the `x-forwarded-proto` header is `https`.

---

## Midtrans

### Payment Creation
```typescript
POST https://api.sandbox.midtrans.com/v2/charge   // sandbox
POST https://api.midtrans.com/v2/charge           // production
Authorization: Basic base64(SERVER_KEY:)
```

**Request:**
```json
{
  "payment_type": "bank_transfer",
  "transaction_details": {
    "order_id": "pay_xxx",
    "gross_amount": 100000
  },
  "bank_transfer": {
    "bank": "bca"
  },
  "customer_details": {
    "first_name": "John",
    "email": "john@example.com"
  },
  "callbacks": {
    "finish": "https://example.com/payment/finish"
  }
}
```

- `payment_type` is derived from the requested method: `bca`/`bni`/`bri`/`permata` → `bank_transfer`, `mandiri` → `echannel`, anything else (e.g. `gopay`, `qris`, `shopeepay`, `credit_card`) passes through as-is (default `bank_transfer`).
- **QRIS / e-Wallet / ShopeePay use the Snap API instead:** `POST https://api.sandbox.midtrans.com/snap/v1/transactions` (sandbox) / `https://api.midtrans.com/snap/v1/transactions` (production), same auth, with `callbacks.finish`.
- For bank-transfer payments with no `redirect_url`, `paymentUrl` is built from the virtual account response: `https://app.sandbox.midtrans.com/snap/v2/vtweb/{orderId}` (sandbox) / `https://app.midtrans.com/snap/v2/vtweb/{orderId}` (production).

**Response:**
```json
{
  "status_code": "201",
  "transaction_id": "abc123",
  "order_id": "pay_xxx",
  "redirect_url": "https://sandbox.midtrans.com/v2/...",
  "payment_type": "bank_transfer",
  "transaction_status": "pending",
  "expiry_time": "2026-07-05 10:00:00"
}
```

**Result:** `gatewayReference` = `transaction_id`, `paymentUrl` = `redirect_url` (or the vtweb URL above), `expiresAt` = `expiry_time`.

### Callback URL
```
POST /webhook/midtrans
```

### Signature Verification
```typescript
signature = SHA-512(order_id + status_code + gross_amount + server_key)
```
- Fields from request body: `order_id`, `status_code`, `gross_amount`
- `server_key` from env: `MIDTRANS_SERVER_KEY`
- Compared with body field `signature_key` using timing-safe comparison.

### Status Mapping
| Midtrans Status | Mapped To |
|-----------------|-----------|
| `capture` (fraud_status: accept) | success |
| `settlement` | success |
| `pending` | pending |
| `deny` | failed |
| `cancel` | cancelled |
| `expire` | expired |
| `refund` | failed |

**Note:** `normalizeEvent` sets `gateway_reference` to the payload `order_id` (not `transaction_id`) — see code suggestions.

### Callback Payload (relevant fields)
```json
{
  "order_id": "pay_xxx",
  "status_code": "200",
  "gross_amount": "100000.00",
  "signature_key": "abc123...",
  "transaction_status": "settlement",
  "payment_type": "bank_transfer",
  "transaction_time": "2026-07-04 10:00:00",
  "fraud_status": "accept"
}
```

### Environment Variables
```
MIDTRANS_SERVER_KEY=...
MIDTRANS_CLIENT_KEY=...
MIDTRANS_ENVIRONMENT=sandbox|production
```

---

## Tripay

### Payment Creation
```typescript
POST https://tripay.co.id/api/transaction/create            // production
POST https://tripay.co.id/api-sandbox/transaction/create    // sandbox
Authorization: Bearer TRIPAY_API_KEY
```

**Request:**
```json
{
  "method": "BCA",
  "merchant_ref": "pay_xxx",
  "amount": 100000,
  "customer_name": "John",
  "customer_email": "john@example.com",
  "order_items": [
    {
      "sku": "PAYMENT",
      "name": "Payment",
      "price": 100000,
      "quantity": 1
    }
  ],
  "callback_url": "https://pay.1ai.dev/webhook/tripay",
  "return_url": "https://example.com/payment/finish",
  "expired_time": 1720166400
}
```

- `method` is the uppercased `paymentMethod` from request params.
- `expired_time` = `Date.now() + 86400` (seconds, Unix timestamp).

**Response:**
```json
{
  "success": true,
  "data": {
    "reference": "TRX123",
    "merchant_ref": "pay_xxx",
    "payment_method": "BCA",
    "amount": 100000,
    "status": "UNPAID",
    "pay_url": "https://tripay.co.id/checkout/TRX123",
    "expired_time": 1720166400
  }
}
```

**Result:** `gatewayReference` = `data.reference`, `paymentUrl` = `data.pay_url`.

### Callback URL
```
POST /webhook/tripay
```

### Signature Verification
```typescript
signature = HMAC-SHA256(JSON.stringify(body), private_key)
```
- Compare with `x-signature` header (headers are lowercased by the shared route)
- `private_key` from env: `TRIPAY_PRIVATE_KEY`

### Status Mapping
| Tripay Status | Mapped To |
|---------------|-----------|
| `PAID` | success |
| `EXPIRED` | expired |
| `FAILED` | failed |
| `CANCELLED` | cancelled |
| `UNPAID` | pending |

### Callback Payload (relevant fields)
```json
{
  "merchant_ref": "pay_xxx",
  "reference": "TRX123",
  "status": "PAID",
  "amount": 100000,
  "payment_method": "BCA"
}
```

### Environment Variables
```
TRIPAY_API_KEY=...
TRIPAY_PRIVATE_KEY=...
TRIPAY_MERCHANT_CODE=...
TRIPAY_ENVIRONMENT=sandbox|production
```

---

## Duitku

### Payment Creation
```typescript
POST https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry      // sandbox
POST https://passport.duitku.com/webapi/api/merchant/v2/inquiry     // production
// No auth header — the request is signed via the `signature` body field
```

**Request:**
```json
{
  "merchantCode": "M123",
  "paymentAmount": 100000,
  "paymentMethod": "VC",
  "merchantOrderId": "pay_xxx",
  "productDetails": "Credits",
  "customerVaName": "John",
  "email": "john@example.com",
  "callbackUrl": "https://pay.1ai.dev/webhook/duitku",
  "returnUrl": "https://example.com/payment/finish",
  "signature": "abc123...",
  "expiryPeriod": 60
}
```

**Signature:** `MD5(merchantCode + merchantOrderId + paymentAmount + apiKey)`

**Response:**
```json
{
  "merchantCode": "M123",
  "reference": "REF123",
  "paymentUrl": "https://sandbox.duitku.com/pay/REF123",
  "vaNumber": "1234567890",
  "amount": "100000",
  "statusCode": "00",
  "statusMessage": "SUCCESS"
}
```

### Callback URL
```
POST /webhook/duitku
```

### Signature Verification (Webhook)
```typescript
signature = MD5(merchantCode + amount + merchantOrderId + apiKey)
```
- Fields from request body: `merchantCode`, `amount`, `merchantOrderId`
- `apiKey` from env: `DUITKU_API_KEY`
- Compared with body field `signature` using timing-safe comparison.

### Status Mapping
| Duitku Result Code | Mapped To |
|--------------------|-----------|
| `00` | success |
| `01` | pending |
| Other | failed |

(No `expired` / `cancelled` mapping — anything outside `00` / `01` becomes `failed`.)

### Callback Payload (relevant fields)
```json
{
  "merchantCode": "M123",
  "amount": "100000",
  "merchantOrderId": "pay_xxx",
  "resultCode": "00",
  "reference": "REF123",
  "signature": "abc123..."
}
```

### Environment Variables
```
DUITKU_API_KEY=...
DUITKU_MERCHANT_CODE=...
DUITKU_ENVIRONMENT=sandbox|production
```

---

## NOWPayments

### Payment Creation
```typescript
POST https://api-sandbox.nowpayments.io/v1/invoice   // sandbox
POST https://api.nowpayments.io/v1/invoice           // production
x-api-key: NOWPAYMENTS_API_KEY
```

**Request:**
```json
{
  "price_amount": 20.00,
  "price_currency": "USD",
  "order_id": "pay_xxx",
  "order_description": "Credits",
  "ipn_callback_url": "https://pay.1ai.dev/webhook/nowpayments",
  "success_url": "https://example.com/payment/finish",
  "cancel_url": "https://example.com/payment/cancel"
}
```

**Note:** `price_amount` is `amount / 100` (major units) for every currency except `IDR`, which is sent as the raw amount — see code suggestions.

**Response:**
```json
{
  "id": "inv_123",
  "token_id": "tok_456",
  "order_id": "pay_xxx",
  "order_description": "Credits",
  "price_amount": 20.00,
  "price_currency": "USD",
  "pay_currency": "btc",
  "invoice_url": "https://nowpayments.io/payment/?iid=inv_123",
  "status": "pending",
  "created_at": "2026-07-04T10:00:00Z",
  "expiration_estimate_date": "2026-07-05T10:00:00Z"
}
```

### Callback URL
```
POST /webhook/nowpayments
```

### Signature Verification
```typescript
signature = HMAC-SHA512(JSON.stringify(body), ipn_secret_key)
```
- Compare with `x-now-sig` header
- `ipn_secret_key` from env: `NOWPAYMENTS_IPN_SECRET`

### Status Mapping
| NOWPayments Status | Mapped To |
|--------------------|-----------|
| `finished` | success |
| `confirmed` | success |
| `confirming` | pending |
| `sending` | pending |
| `partially_paid` | pending |
| `failed` | failed |
| `refunded` | refunded |
| `expired` | expired |

### Callback Payload (relevant fields)
```json
{
  "payment_id": "12345",
  "order_id": "pay_xxx",
  "order_description": "Credits",
  "price_amount": 20.00,
  "price_currency": "USD",
  "pay_amount": 0.005,
  "pay_currency": "btc",
  "payment_status": "finished",
  "created_at": "2026-07-04T10:00:00Z"
}
```

### Environment Variables
```
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
NOWPAYMENTS_ENVIRONMENT=sandbox|production
```

---

## iPaymu

### Payment Creation
```typescript
POST https://sandbox.ipaymu.com/api/v2/payment   // sandbox
POST https://my.ipaymu.com/api/v2/payment        // production
va: IPAYMU_VA_KEY
timestamp: <unix ms>
signature: HMAC-SHA256(POST:{VA_KEY}:{bodyHash}:{API_KEY})
```

Where `bodyHash` = lowercase hex SHA-256 of the JSON request body, and the resulting HMAC is hex-encoded lowercase. The signature is sent as a **request header** (not a body field).

**Request:**
```json
{
  "name": "John",
  "phone": "",
  "email": "john@example.com",
  "amount": 100000,
  "notifyUrl": "https://pay.1ai.dev/webhook/ipaymu",
  "returnUrl": "https://example.com/payment/finish",
  "cancelUrl": "https://example.com/payment/cancel",
  "referenceId": "pay_xxx",
  "paymentMethod": "va",
  "paymentChannel": "va"
}
```

**Response:**
```json
{
  "Status": 200,
  "Message": "Success",
  "Data": {
    "SessionID": "sess_123",
    "OrderID": "pay_xxx",
    "Amount": "100000",
    "ReferenceID": "ref_123",
    "PaymentURL": "https://sandbox.ipaymu.com/pay/...",
    "PaymentMethod": "va",
    "ExpiredAt": "2026-07-05 10:00:00"
  }
}
```

**Result:** `gatewayReference` = `Data.SessionID`, `paymentUrl` = `Data.PaymentURL`.

### Callback URL
```
POST /webhook/ipaymu
```

### Signature Verification
```typescript
signature = SHA-256(va + order_id + status + amount + apiKey)
```
- Fields from request body: `order_id`, `status`, `amount`
- `va` from env: `IPAYMU_VA_KEY`
- `apiKey` from env: `IPAYMU_API_KEY`
- Compared with body field `signature` using timing-safe comparison.

### Status Mapping
| iPaymu Status | Mapped To |
|---------------|-----------|
| `success` | success |
| `pending` | pending |
| `failed` | failed |
| `expired` | expired |
| `cancelled` | cancelled |

### Callback Payload (relevant fields)
```json
{
  "order_id": "pay_xxx",
  "status": "success",
  "amount": "100000",
  "payment_method": "va",
  "reference_id": "ref_123",
  "signature": "abc123..."
}
```

### Environment Variables
```
IPAYMU_API_KEY=...
IPAYMU_VA_KEY=...
IPAYMU_ENVIRONMENT=sandbox|production
```

---

## Scalev

Scalev is integrated as a **headless-commerce checkout**: the storefront API creates a checkout order for a pre-configured product variant, and the 1ai-payment order ID round-trips through the `notes` field.

### Payment Creation
```typescript
POST https://api.scalev.com/v3/stores/{SCALEV_STORE_ID}/public/checkout
X-Scalev-Storefront-Api-Key: SCALEV_STOREFRONT_API_KEY
```

**Request:**
```json
{
  "customer_name": "John",
  "customer_email": "john@example.com",
  "customer_phone": "",
  "payment_method": "bank_transfer",
  "notes": "1ai-payment:pay_xxx",
  "items": [
    {
      "type": "variant",
      "variant_id": 12345,
      "quantity": 1
    }
  ]
}
```

- `payment_method` defaults to `bank_transfer` when not supplied.
- `customer_email` defaults to `customer-{Date.now()}@example.com` when not supplied.
- `variant_id` comes from env `SCALEV_VARIANT_ID`.
- `notes` is always `1ai-payment:{orderId}` — this is how the webhook later maps back to the 1ai-payment order.
- The same base URL `https://api.scalev.com` is used for sandbox and production (see code suggestions).

If the gateway responds `400 Duplicate order`, the existing order is fetched instead:

```typescript
GET https://api.scalev.com/v3/stores/{SCALEV_STORE_ID}/public/orders?notes=1ai-payment:{orderId}
X-Scalev-Storefront-Api-Key: SCALEV_STOREFRONT_API_KEY
```

…and the first result is reused.

**Result:**
- `gatewayReference` = returned order `id`
- `paymentUrl` = `payment_url` if present, else `https://checkout.scalev.com/{secret_slug}`

### Callback URL
```
POST /webhook/scalev
```

### Signature Verification
```typescript
signature = HMAC-SHA256(JSON.stringify(body), SCALEV_WEBHOOK_SECRET)
```
- Compare with `x-scalev-signature` header using timing-safe comparison.
- `SCALEV_WEBHOOK_SECRET` from env; if unset, verification fails.

### Status Mapping
| Scalev Status | Mapped To |
|---------------|-----------|
| `paid` / `completed` | success |
| `pending` / `processing` | pending |
| `failed` | failed |
| `cancelled` | cancelled |
| `expired` | expired |
| anything else (incl. `refunded`) | pending |

`order_id` is recovered from `notes` via `/^1ai-payment:(.+)$/`, falling back to `secret_slug` / `id`.

### Callback Payload (relevant fields)
```json
{
  "id": "trx_123",
  "notes": "1ai-payment:pay_xxx",
  "status": "paid",
  "payment_method": "bank_transfer",
  "paid_at": "2026-07-04T10:00:00Z"
}
```

### Environment Variables
```
SCALEV_STOREFRONT_API_KEY=...
SCALEV_STORE_ID=...
SCALEV_VARIANT_ID=...
SCALEV_WEBHOOK_SECRET=...
SCALEV_ENVIRONMENT=sandbox|production
```

---

## Xendit

### Payment Creation (Invoice — QRIS, e-Wallet, Retail, Credit Card)
```typescript
POST https://api.xendit.co/v2/invoices
Authorization: Basic base64(API_KEY:)
```

**Request:**
```json
{
  "external_id": "pay_xxx",
  "amount": 100000,
  "payer_email": "john@example.com",
  "description": "Payment",
  "currency": "IDR",
  "success_redirect_url": "https://example.com/payment/finish",
  "failure_redirect_url": "https://example.com/payment/cancel"
}
```

**Response:**
```json
{
  "id": "inv_123",
  "external_id": "pay_xxx",
  "status": "PENDING",
  "amount": 100000,
  "invoice_url": "https://invoice.xendit.co/...",
  "expiry_date": "2026-07-05T10:00:00Z"
}
```

### Payment Creation (Virtual Account)
```typescript
POST https://api.xendit.co/callback_virtual_accounts
Authorization: Basic base64(API_KEY:)
```

**Request:**
```json
{
  "external_id": "pay_xxx",
  "bank_code": "BCA",
  "name": "John",
  "expected_amount": 100000,
  "is_closed": true,
  "is_single_use": true
}
```

**Response:**
```json
{
  "id": "va_123",
  "external_id": "pay_xxx",
  "status": "ACTIVE",
  "amount": 100000,
  "bank_code": "BCA",
  "account_number": "1234567890",
  "expiry_date": "2026-07-05T10:00:00Z"
}
```

Bank-transfer methods (`bca`, `mandiri`, `bni`, `bri`, `permata`, `cimb`, `btn`, `bjb`, `bsi`) use the VA endpoint; everything else uses invoices.

### Callback URL
```
POST /webhook/xendit
```

### Signature Verification
```typescript
// Compare X-Callback-Token header with env
```
- Header: `X-Callback-Token` (lowercased by the shared route)
- `callbackToken` from env: `XENDIT_CALLBACK_TOKEN`

### Status Mapping
| Xendit Status | Mapped To |
|---------------|-----------|
| `PAID` / `SETTLED` | success |
| `PENDING` | pending |
| `EXPIRED` | expired |
| `FAILED` | failed |
| `CANCELLED` / `VOIDED` | cancelled |
| anything else | pending |

### Callback Payload (Invoice)
```json
{
  "id": "inv_123",
  "external_id": "pay_xxx",
  "status": "PAID",
  "amount": 100000,
  "paid_amount": 100000,
  "payment_method": "qris",
  "paid_at": "2026-07-04T10:00:00Z",
  "invoice_url": "https://invoice.xendit.co/...",
  "x_callback_token": "abc123..."
}
```

### Callback Payload (Virtual Account)
```json
{
  "id": "va_123",
  "external_id": "pay_xxx",
  "status": "PAID",
  "amount": 100000,
  "paid_amount": 100000,
  "bank_code": "BCA",
  "paid_at": "2026-07-04T10:00:00Z",
  "virtual_account_number": "1234567890",
  "x_callback_token": "abc123..."
}
```

### Environment Variables
```
XENDIT_API_KEY=...
XENDIT_CALLBACK_TOKEN=...
XENDIT_ENVIRONMENT=sandbox|production
```

---

## Telegram Stars

Telegram's native in-app currency (XTR). Users pay with Stars inside the Telegram client; the callback arrives as a bot update on the configured webhook.

### Payment Creation
```typescript
POST https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/createInvoiceLink
```

**Request:**
```json
{
  "title": "Payment",
  "description": "Payment for order pay_xxx",
  "payload": "{\"order_id\":\"pay_xxx\",\"gateway\":\"telegram_stars\"}",
  "currency": "XTR",
  "prices": [
    { "label": "Payment", "amount": 100 }
  ]
}
```

- `title` defaults to the customer name, else `"Payment"`.
- `currency` is always `XTR`; the amount is in Stars (whole units, not subdivided).
- `payload` embeds the 1ai-payment order ID and is returned in the callback.

**Result:**
- `gatewayReference` = the 1ai-payment `orderId` (no gateway-side transaction ID at creation)
- `paymentUrl` = `result.result` (the invoice link)
- `expiresAt` = undefined

### Callback URL
```
POST /webhook/telegram_stars
```

### Signature Verification
- Header: `x-telegram-bot-api-secret-token`
- Compared (timing-safe) with `TELEGRAM_WEBHOOK_SECRET`.
- Fail-closed: if `TELEGRAM_WEBHOOK_SECRET` is unset (or the header is missing), verification returns `false` and the webhook is rejected with 401.

### Status Mapping
Telegram has no status string; the update shape decides:

| Update Shape | Mapped To |
|--------------|-----------|
| `message.successful_payment` | success |
| `pre_checkout_query` | pending |
| anything else | throws (invalid payload) |

For a successful payment: `amount` = `total_amount`, `currency` = `XTR`, `payment_method` = `telegram_stars`, `gateway_reference` = `telegram_payment_charge_id`, `order_id` = parsed from `invoice_payload` JSON.

### Callback Payload (relevant fields)
```json
{
  "update_id": 100,
  "message": {
    "successful_payment": {
      "invoice_payload": "{\"order_id\":\"pay_xxx\",\"gateway\":\"telegram_stars\"}",
      "telegram_payment_charge_id": "charge_123",
      "total_amount": 100,
      "currency": "XTR"
    }
  }
}
```

### Payment Methods
| Code | Name | Currencies |
|------|------|------------|
| `stars` | Telegram Stars | XTR |

### Environment Variables
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
```

---

## Telegram Payments

Telegram Payments API with an external payment provider (card tokenization). Same `createInvoiceLink` endpoint, multi-currency via the configured provider.

### Payment Creation
```typescript
POST https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/createInvoiceLink
```

**Request:**
```json
{
  "title": "Payment",
  "description": "Payment for order pay_xxx",
  "payload": "{\"order_id\":\"pay_xxx\",\"gateway\":\"telegram_payments\"}",
  "provider_token": "TOKEN",
  "currency": "USD",
  "prices": [
    { "label": "Payment", "amount": 2000 }
  ]
}
```

- `currency` = `params.currency || "USD"`.
- `provider_token` from env: `TELEGRAM_PAYMENT_PROVIDER_TOKEN`.
- Amount is in the smallest unit of the currency (e.g. cents).

**Result:** same as Telegram Stars — `gatewayReference` = `orderId`, `paymentUrl` = `result.result`.

### Callback URL
```
POST /webhook/telegram_payments
```

### Signature Verification
- Same as Telegram Stars: header `x-telegram-bot-api-secret-token` vs `TELEGRAM_WEBHOOK_SECRET`, timing-safe; also fails closed when the secret is unset.

### Status Mapping
Same update-shape logic as Telegram Stars (`message.successful_payment` → success, `pre_checkout_query` → pending, else throws). For a successful payment `payment_method` = `telegram` and `currency` is taken from the update.

### Callback Payload (relevant fields)
```json
{
  "update_id": 100,
  "message": {
    "successful_payment": {
      "invoice_payload": "{\"order_id\":\"pay_xxx\",\"gateway\":\"telegram_payments\"}",
      "telegram_payment_charge_id": "charge_123",
      "total_amount": 2000,
      "currency": "USD"
    }
  }
}
```

### Payment Methods
| Code | Name | Currencies |
|------|------|------------|
| `telegram` | Telegram Payments | USD, EUR, GBP, IDR |

### Environment Variables
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_PAYMENT_PROVIDER_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
```

---

## PayPal

Two-step flow: OAuth2 client-credentials token, then the Orders API with `intent: CAPTURE`. Webhook signature verification is **async** — PayPal verifies the signature via its API rather than locally.

### Payment Creation
Step 1 — get access token:
```typescript
POST https://api-m.sandbox.paypal.com/v1/oauth2/token   // sandbox
POST https://api-m.paypal.com/v1/oauth2/token           // production
Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

Step 2 — create order:
```typescript
POST https://api-m.sandbox.paypal.com/v2/checkout/orders   // sandbox
POST https://api-m.paypal.com/v2/checkout/orders           // production
Authorization: Bearer {access_token}
PayPal-Request-Id: {orderId}   // idempotency key
```

**Request:**
```json
{
  "intent": "CAPTURE",
  "purchase_units": [
    {
      "reference_id": "pay_xxx",
      "description": "Payment for order pay_xxx",
      "amount": {
        "currency_code": "USD",
        "value": "20.00"
      }
    }
  ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "payment_method_preference": "IMMEDIATE_PAYMENT_REQUIRED",
        "brand_name": "1AI Payment",
        "locale": "en-US",
        "landing_page": "LOGIN",
        "shipping_preference": "NO_SHIPPING",
        "user_action": "PAY_NOW",
        "return_url": "https://example.com/payment/success",
        "cancel_url": "https://example.com/payment/cancel"
      }
    }
  }
}
```

- Amount value = `(amount / 100).toFixed(2)` — smallest units → major units.

**Result:**
- `gatewayReference` = `result.id`
- `paymentUrl` = the link with `rel = "payer-action"` from `result.links`

### Callback URL
```
POST /webhook/paypal
```

### Signature Verification (async)
Required headers: `paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url` (plus `paypal-auth-algo`).

```typescript
POST /v1/notifications/verify-webhook-signature   // same base URL as above
Authorization: Bearer {access_token}
```

**Request:**
```json
{
  "transmission_id": "...",
  "transmission_time": "...",
  "cert_url": "...",
  "auth_algo": "SHA256withRSA",
  "transmission_sig": "...",
  "webhook_id": "PAYPAL_WEBHOOK_ID",
  "webhook_event": {}
}
```

Valid when `verification_status === "SUCCESS"`. Note: `PAYPAL_WEBHOOK_SECRET` is checked for presence but is not used in the verification call (see code suggestions).

### Status Mapping
| PayPal Event / Status | Mapped To |
|-----------------------|-----------|
| `PAYMENT.CAPTURE.REFUNDED` | refunded |
| `CHECKOUT.ORDER.APPROVED` (approved) | pending |
| `completed` / `approved` / `captured` | success |
| `pending` / `created` | pending |
| `voided` / `cancelled` | cancelled |
| `refunded` | refunded |
| `denied` / `failed` | failed |
| `expired` | expired |
| unknown event_type | pending |

- `order_id` = `resource.custom_id` || `resource.invoice_id` || `resource.id`
- `gateway_reference` = `resource.id`
- `amount` = `Math.round(value * 100)` (major → smallest units)

### Callback Payload (relevant fields)
```json
{
  "id": "wh_123",
  "event_type": "PAYMENT.CAPTURE.COMPLETED",
  "resource": {
    "id": "cap_123",
    "custom_id": "pay_xxx",
    "status": "COMPLETED",
    "amount": {
      "currency_code": "USD",
      "value": "20.00"
    }
  }
}
```

### Payment Methods
| Code | Name | Currencies |
|------|------|------------|
| `paypal` | PayPal | USD, EUR, GBP, CAD, AUD |
| `pay_later` | Pay Later | USD, EUR, GBP |
| `venmo` | Venmo | USD |

### Environment Variables
```
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_WEBHOOK_SECRET=...
PAYPAL_ENVIRONMENT=sandbox|production
```

---

## x402

On-chain HTTP payment protocol. Payment creation is **offline** — no HTTP API call — the gateway returns an x402 `PaymentRequirements` JSON document as the `paymentUrl`. Settlement is verified on-chain when the payer completes the x402 flow and the callback arrives.

Requires `X402_WALLET_ADDRESS` to be set, otherwise the gateway is not enabled.

### Payment Creation
No HTTP request. Builds a `PaymentRequirements` document:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://pay.berkahkarya.org/api/payments/pay_xxx/status",
    "description": "Payment of 20 USDC"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "20000000",
      "asset": "0xUSDC_ADDRESS",
      "payTo": "0xMERCHANT_WALLET",
      "maxTimeoutSeconds": 300
    }
  ]
}
```

- `network` = `X402_NETWORK` (default `eip155:8453`).
- `asset` = `X402_USDC_ADDRESS` if set, else the default USDC address for the network.
- `amount` = `String(BigInt(round(amount * 1e6)))` — USDC has 6 decimals.
- `payTo` = `X402_WALLET_ADDRESS`.

**Result:**
- `gatewayReference` = the 1ai-payment `orderId`
- `paymentUrl` = `JSON.stringify(paymentRequirements)`
- `expiresAt` = now + 300s

### Callback URL
```
POST /webhook/x402
```
Body: `{ order_id, tx_hash, network, asset, amount, payer }`

### Signature Verification
- `verifySignature` decodes the payload and requires `network`, `tx_hash`, `asset` (with `network` containing `eip155:`), then verifies **on-chain**: `getTransactionReceipt(tx_hash)`, require `tx.status === "success"`, and find an ERC-20 `Transfer` log to the merchant wallet (`X402_WALLET_ADDRESS`) with `value >= expectedAmount`. The client-declared asset/payer fields are not trusted — the expected USDC contract comes from `X402_USDC_ADDRESS` or the per-network default.
- Fails closed: without `X402_WALLET_ADDRESS` configured the gateway is not enabled and verification returns `false`.
- Verified results are cached (keyed by tx hash, 5-minute TTL) so `normalizeEvent` reports the actual on-chain amount.
- Networks: `eip155:8453` → base, `eip155:84532` → baseSepolia, `eip155:1` → mainnet.

### Status Mapping
| Condition | Mapped To |
|-----------|-----------|
| on-chain verified | success |
| otherwise | pending |

- `amount` = `Number(amount) / 1e6` (string amounts are USDC base units)
- `currency` = `USD`, `payment_method` = `network`, `gateway_reference` = `tx_hash`

### Callback Payload (relevant fields)
```json
{
  "order_id": "pay_xxx",
  "tx_hash": "0xabc...",
  "network": "eip155:8453",
  "asset": "0xUSDC_ADDRESS",
  "amount": "20000000",
  "payer": "0xpayer"
}
```

### Payment Methods
| Code | Name | Currencies |
|------|------|------------|
| `usdc_base` | USDC on Base | USD |
| `usdc_ethereum` | USDC on Ethereum | USD |

### Environment Variables
```
X402_RPC_URL=...
X402_NETWORK=...
X402_USDC_ADDRESS=...
X402_WALLET_ADDRESS=...
```

---

## ERC-8183

On-chain escrow (MVP). Payment creation is **offline** — an escrow entry is built from order metadata and returned as JSON (`paymentUrl`). Settlement happens via evaluator attestation; the callback carries the attestation data.

### Payment Creation
No HTTP request. Builds an escrow entry from `metadata`:
- `employer` / `employer_address`
- `provider` / `provider_address`
- `evaluator` / `evaluator_address`
- `job_title` / `title`, `job_description` / `description`
- `token_address`, `network`, `deliverables`
- `timeout_minutes` (default 1440)

**Result:**
- `escrowId` = `orderId`, or `escrow-{uuid8}` when no order ID is provided
- `gatewayReference` = escrowId
- `paymentUrl` = `JSON.stringify(escrowEntry)`
- `expiresAt` = `timeoutAt`

### Callback URL
```
POST /webhook/erc8183
```
Body (attestation): `{ escrow_id, evaluator / evaluator_address, approved / status, signature?, notes? }`

### Signature Verification
- `verifySignature` parses the attestation (required fields `escrow_id`, `evaluator`) and verifies the attestation **signature**: the signer is recovered (viem) from `JSON.stringify({ escrowId, evaluator, approved, notes })` and compared timing-safe with the configured evaluator (`ERC8183_EVALUATOR_ADDRESS`, falling back to `ERC8183_EVALUATOR_PUBLIC_KEY`).
- Fails closed: a missing/invalid signature, no configured evaluator, or a signer mismatch all reject the webhook (401).

### Status Mapping
| Escrow Status | Mapped To |
|---------------|-----------|
| `released` | success |
| `pending` / `funded` / `in_progress` / `completed` / `attested` | pending |
| `disputed` | failed |
| `cancelled` | cancelled |
| anything else | pending |

- `order_id` = `escrow_id` || `order_id`
- `gateway_reference` = `tx_hash` || `attestation_hash` || `gateway_reference`
- `currency` = `USD`, `payment_method` = `erc8183_escrow`, `paid_at` = `released_at`

### Callback Payload (relevant fields)
```json
{
  "escrow_id": "pay_xxx",
  "evaluator": "0xevaluator",
  "approved": true,
  "status": "released",
  "signature": "0xabc..."
}
```

### Payment Methods
| Code | Name | Currencies |
|------|------|------------|
| `erc8183_escrow` | ERC-8183 Escrow | USD |

### Environment Variables
```
ERC8183_NETWORK=...
ERC8183_TOKEN_ADDRESS=...
ERC8183_WALLET_ADDRESS=...
ERC8183_EVALUATOR_ADDRESS=...    # required for webhook signature verification
# fallback when ERC8183_EVALUATOR_ADDRESS is unset: ERC8183_EVALUATOR_PUBLIC_KEY
```

---

## Adding a New Gateway

1. Create `src/gateways/<name>/` implementing `PaymentGateway` from `src/gateways/base.ts`
2. Implement `createPayment()`, `getPaymentMethods()`, `verifySignature()`, `normalizeEvent()` (plus `refundPayment()` if the gateway supports refunds)
3. Register in `src/gateways/index.ts`:
   ```typescript
   import { NewGateway } from './<name>';
   gateways.set('<name>', new NewGateway());
   ```
   (no config argument — gateways read their credentials from env via `getGatewayConfig()`)
4. Add the gateway name to `GATEWAY_NAMES` in `src/schemas.ts` — the webhook route `POST /webhook/{gateway}` is auto-generated for every entry in `src/routes/webhook.ts`
5. Add env vars to `src/config/env.ts` and `.env.example`
6. Add tests
7. Update this doc + `README.md`

No changes to routing or forwarding logic. SOLID: open for extension, closed for modification.
