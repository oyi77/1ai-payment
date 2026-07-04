# 03 — Gateway Specifications

## Overview

Each payment gateway has unique APIs, callback formats, signature algorithms, and status mappings. This document specifies how 1ai-payment handles each gateway for both **payment creation** and **webhook processing**.

---

## Common Interface

Each gateway implements:

```typescript
interface PaymentGateway {
  readonly name: string;

  /** Create a payment via gateway API */
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;

  /** Verify webhook signature */
  verifySignature(body: unknown, headers: Record<string, string>): boolean;

  /** Normalize webhook event to standard format */
  normalizeEvent(body: unknown): NormalizedPaymentEvent;
}

interface CreatePaymentParams {
  orderId: string;        // 1ai-payment order ID
  amount: number;         // In smallest currency unit
  currency: string;
  paymentMethod?: string;
  customerName?: string;
  customerEmail?: string;
}

interface CreatePaymentResult {
  gatewayReference: string;  // Gateway's transaction ID
  paymentUrl: string;        // URL to redirect user to
  expiresAt?: string;        // ISO timestamp
}
```

---

## Midtrans

### Payment Creation
```typescript
POST https://api.sandbox.midtrans.com/v2/charge
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
POST https://tripay.co.id/api/transaction/create
Authorization: Bearer API_KEY
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
      "sku": "CREDITS",
      "name": "Credits",
      "price": 100000,
      "quantity": 1
    }
  ],
  "callback_url": "https://pay.1ai.dev/webhook/tripay",
  "return_url": "https://example.com/payment/finish",
  "expired_time": 1720166400
}
```

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

### Callback URL
```
POST /webhook/tripay
```

### Signature Verification
```typescript
signature = HMAC-SHA256(JSON.stringify(body), private_key)
```
- Compare with `X-Signature` header
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
POST https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry
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

### Status Mapping
| Duitku Result Code | Mapped To |
|--------------------|-----------|
| `00` | success |
| `01` | pending |
| `02` | failed |
| Other | failed |

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
POST https://api.nowpayments.io/v1/invoice
x-api-key: API_KEY
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
| `confirming` | pending |
| `confirmed` | success |
| `sending` | pending |
| `partially_paid` | pending |
| `failed` | failed |
| `refunded` | failed |
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

## Adding a New Gateway

1. Create `src/gateways/new-gateway.ts` implementing `PaymentGateway`
2. Implement `createPayment()`, `verifySignature()`, `normalizeEvent()`
3. Register in `src/gateways/index.ts`:
   ```typescript
   import { NewGateway } from './new-gateway';
   gateways.set('new-gateway', new NewGateway(config));
   ```
4. Add env vars to `src/config/env.ts`
5. Add webhook route in `src/routes/webhook.ts`

---

## iPaymu

### Payment Creation
```typescript
POST https://sandbox.ipaymu.com/api/v2/payment
key: API_KEY
```

**Request:**
```json
{
  "name": "John",
  "phone": "",
  "email": "john@example.com",
  "amount": 100000,
  "notifyUrl": "https://pay.1ai.dev/webhook/ipaymu",
  "returnUrl": "https://example.com/payment/finish",
  "referenceId": "pay_xxx",
  "paymentMethod": "va",
  "product": [{ "name": "Payment", "qty": 1, "price": 100000 }],
  "signature": "sha256(va+referenceId+amount+apiKey)"
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

### Payment Creation
```typescript
POST https://sandbox.scalev.com/api/v1/transaction
Authorization: Bearer API_KEY
```

**Request:**
```json
{
  "merchant_id": "M123",
  "order_id": "pay_xxx",
  "amount": 100000,
  "payment_method": "qris",
  "customer_name": "John",
  "customer_email": "john@example.com",
  "callback_url": "https://pay.1ai.dev/webhook/scalev",
  "return_url": "https://example.com/payment/finish",
  "expired_time": 1720166400
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transaction_id": "trx_123",
    "order_id": "pay_xxx",
    "payment_url": "https://scalev.com/pay/...",
    "amount": "100000",
    "status": "pending",
    "expired_at": 1720166400
  }
}
```

### Callback URL
```
POST /webhook/scalev
```

### Signature Verification
```typescript
signature = HMAC-SHA256(JSON.stringify(body), apiKey)
```
- Compare with `signature` field in body
- `apiKey` from env: `SCALEV_API_KEY`

### Status Mapping
| Scalev Status | Mapped To |
|---------------|-----------|
| `paid` / `success` | success |
| `pending` | pending |
| `failed` | failed |
| `expired` | expired |
| `cancelled` | cancelled |
| `refunded` | failed |

### Callback Payload (relevant fields)
```json
{
  "transaction_id": "trx_123",
  "merchant_id": "M123",
  "order_id": "pay_xxx",
  "amount": "100000",
  "status": "paid",
  "payment_method": "qris",
  "paid_at": "2026-07-04T10:00:00Z",
  "signature": "abc123..."
}
```

### Environment Variables
```
SCALEV_API_KEY=...
SCALEV_MERCHANT_ID=...
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

### Callback URL
```
POST /webhook/xendit
```

### Signature Verification
```typescript
// Compare X-Callback-Token header with env
```
- Header: `X-Callback-Token`
- `callbackToken` from env: `XENDIT_CALLBACK_TOKEN`

### Status Mapping
| Xendit Status | Mapped To |
|---------------|-----------|
| `PAID` / `SETTLED` | success |
| `PENDING` | pending |
| `EXPIRED` | expired |
| `FAILED` | failed |
| `CANCELLED` / `VOIDED` | cancelled |

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

## Adding a New Gateway

1. Create `src/gateways/new-gateway.ts` implementing `PaymentGateway`
2. Implement `createPayment()`, `verifySignature()`, `normalizeEvent()`
3. Register in `src/gateways/index.ts`:
   ```typescript
   import { NewGateway } from './new-gateway';
   gateways.set('new-gateway', new NewGateway(config));
   ```
4. Add env vars to `src/config/env.ts`
5. Add webhook route in `src/routes/webhook.ts`
6. Add tests
7. Update this doc + `README.md`

No changes to routing or forwarding logic. SOLID: open for extension, closed for modification.
