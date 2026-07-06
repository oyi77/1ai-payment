# 05 — Product Roadmap: Internal Tool → Payment Aggregator SaaS

## Guiding Principle

**Every step must be independently deployable.** The service works correctly after
each merge. No step breaks existing API consumers. No step requires a "big bang"
migration. If we stop at any step, the service is in a valid, better state.

## Current State (v0.1 — Internal)

```
Single API key (env var)
Single tenant (hardcoded project_id: '1ai-content')
Gateway creds from env only
No merchant management
No billing
No dashboard
```

**What works:** Payment creation, webhook processing, signature verification,
idempotent operations, 10 gateways, auto-generated OpenAPI docs.

---

## Phase 1: Multi-Tenant Foundation

> **Goal:** Multiple projects can use 1ai-payment with isolated API keys,
> own callback URLs, and own order namespaces. Existing single-key usage
> continues to work unchanged.

### Step 1.1 — Add `merchants` table (DB-only, zero behavior change)

**Files:** `src/config/database.ts`

```sql
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,                    -- 'merch_xxxxx'
  name TEXT NOT NULL,                     -- Display name
  api_key_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of API key
  webhook_secret TEXT NOT NULL,           -- HMAC secret for forwarding
  default_callback_url TEXT,              -- Fallback callback
  active INTEGER DEFAULT 1,
  plan TEXT DEFAULT 'free',               -- free | pro | enterprise
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merchants_api_key ON merchants(api_key_hash);
```

**Also:** Seed a default merchant row that matches current env `API_KEY`:

```sql
-- In initDatabase(), after CREATE TABLE merchants:
-- If no merchants exist, create default from env API_KEY
INSERT OR IGNORE INTO merchants (id, name, api_key_hash, webhook_secret, active)
VALUES ('merch_default', 'Default', hex(sha256(?)), hex(randomblob(32)), 1);
```

**Verification:**
- `bun run typecheck` passes
- `bun run dev` starts, logs "Database initialized"
- All existing API calls work identically (no behavior change)
- `merchants` table exists in `data/payment.db`

**Rollback:** `DROP TABLE IF EXISTS merchants;`

---

### Step 1.2 — Auth middleware reads from `merchants` table (backward-compatible)

**Files:** `src/middleware/auth.ts`

Change: Instead of comparing against env `API_KEY`, look up the API key hash
in the `merchants` table. If no merchant found, fall back to env `API_KEY`
(existing behavior).

```typescript
export async function authMiddleware(c: Context, next: Next) {
  const apiKey = c.req.header('X-API-Key');
  if (!apiKey) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', ... } }, 401);
  }

  const db = getDb();
  const keyHash = sha256(apiKey);
  const result = await db.execute({
    sql: 'SELECT id, name, active FROM merchants WHERE api_key_hash = ?',
    args: [keyHash],
  });

  if (result.rows.length > 0) {
    const merchant = result.rows[0];
    if (!merchant.active) {
      return c.json({ success: false, error: { code: 'MERCHANT_DISABLED', ... } }, 403);
    }
    c.set('merchantId', merchant.id as string);
    c.set('merchantName', merchant.name as string);
    await next();
    return;
  }

  // Fallback: env API_KEY (backward compatibility)
  const config = getConfig();
  if (apiKey === config.API_KEY) {
    c.set('merchantId', 'merch_default');
    c.set('merchantName', 'Default');
    await next();
    return;
  }

  return c.json({ success: false, error: { code: 'UNAUTHORIZED', ... } }, 401);
}
```

**Verification:**
- Existing `X-API-Key: <env API_KEY>` calls still work
- New merchant API keys work (once merchants are created)
- `c.get('merchantId')` available in downstream handlers

**Rollback:** Revert auth.ts to env-only comparison.

---

### Step 1.3 — Order creation uses merchant context (no API change)

**Files:** `src/routes/payment.ts`, `src/services/order.service.ts`

Change: Replace hardcoded `project_id: '1ai-content'` with
`c.get('merchantId')`.

```typescript
// In createPayment handler:
const orderParams: CreateOrderParams = {
  project_id: c.get('merchantId') ?? 'merch_default', // was '1ai-content'
  ...
};
```

**Verification:**
- Orders created with existing API key have `project_id = 'merch_default'`
- Orders created with new merchant key have `project_id = merch_xxxxx`
- All other behavior identical

**Rollback:** Hardcode `'1ai-content'` again.

---

### Step 1.4 — Webhook forwarding uses merchant's webhook_secret

**Files:** `src/routes/webhook.ts`, `src/services/forwarder.service.ts`

Change: Look up `webhook_secret` from `merchants` table using order's
`project_id`, instead of using `order.id` as secret.

```typescript
// In webhook handler, after finding the order:
const merchant = await db.execute({
  sql: 'SELECT webhook_secret FROM merchants WHERE id = ?',
  args: [order.project_id],
});
const webhookSecret = merchant.rows[0]?.webhook_secret ?? order.id;

forwardEvent(fullEvent, order, webhookSecret);
```

**Verification:**
- Forwarded events signed with merchant's secret
- Fallback to `order.id` if merchant not found (backward compat)
- Existing projects receive correctly signed payloads

**Rollback:** Use `order.id` as secret again.

---

### Step 1.5 — Merchant CRUD API

**Files:** `src/routes/merchant.ts` (new), `src/schemas.ts`, `src/index.ts`

New endpoints (all require auth):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/merchants` | POST | Create merchant (returns API key once) |
| `/api/merchants` | GET | List all merchants |
| `/api/merchants/:id` | GET | Get merchant details |
| `/api/merchants/:id` | PATCH | Update merchant (name, callback_url, active) |
| `/api/merchants/:id/api-key` | POST | Rotate API key (returns new key once) |

**API key generation:**
```typescript
function generateApiKey(): string {
  return '1pay_' + randomBytes(32).toString('hex');
}
// Store SHA-256 hash, return raw key ONCE
```

**Verification:**
- Create merchant → get API key
- Use new API key → payment creation works
- List merchants → shows all
- Rotate key → old key stops working, new key works

**Rollback:** Remove merchant routes, delete merchant table.

---

### Step 1.6 — Per-merchant idempotency scope

**Files:** `src/services/order.service.ts`

Change: Add `merchant_id` to idempotency key uniqueness:

```sql
-- Current: UNIQUE(idempotency_key) — global
-- Target:  UNIQUE(merchant_id, idempotency_key) — per-merchant
```

Migration:
```sql
-- Add column (nullable, backward compat)
ALTER TABLE orders ADD COLUMN merchant_id TEXT;

-- Populate from project_id
UPDATE orders SET merchant_id = project_id WHERE merchant_id IS NULL;

-- Recreate index
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_merchant
  ON orders(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
```

**Verification:**
- Same idempotency key from different merchants → two separate orders
- Same idempotency key from same merchant → same order (idempotent)

**Rollback:** Drop new index, restore global unique.

---

## Phase 2: Transaction History & Refunds

> **Goal:** Merchants can query their transaction history and issue refunds.

### Step 2.1 — Transaction history endpoint

**Files:** `src/routes/payment.ts` (add route), `src/services/order.service.ts`

New endpoint:

```
GET /api/transactions?status=success&gateway=midtrans&from=2026-01-01&to=2026-12-31&limit=50&offset=0
```

Scopes to `merchant_id` from auth context. Returns paginated results.

**Verification:**
- Merchant A sees only their transactions
- Merchant B sees only their transactions
- Filters work correctly
- Pagination works

**Rollback:** Remove route.

---

### Step 2.2 — Refund API

**Files:** `src/routes/refund.ts` (new), `src/services/refund.service.ts` (new),
`src/config/database.ts`, `src/schemas.ts`

New table:
```sql
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,                    -- 'ref_xxxxx'
  order_id TEXT NOT NULL REFERENCES orders(id),
  merchant_id TEXT NOT NULL,
  amount INTEGER NOT NULL,                -- Refund amount (partial or full)
  gateway TEXT NOT NULL,
  gateway_refund_id TEXT,                 -- Gateway's refund reference
  status TEXT DEFAULT 'pending',          -- pending, success, failed
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

New endpoint:
```
POST /api/refunds
{
  "order_id": "pay_xxxxx",
  "amount": 50000,       // optional, defaults to full amount
  "reason": "Customer request"
}
```

**Gateway refund implementation:**
Each gateway implements `refundPayment(gatewayRef, amount)` method on
`PaymentGateway` interface. Gateways that don't support refunds throw
`GatewayError('REFUND_NOT_SUPPORTED')`.

**Verification:**
- Create payment → pay → refund → order status updates
- Partial refund works
- Idempotent refund (same request = same result)
- Gateway that doesn't support refund returns clear error

**Rollback:** Drop refunds table, remove routes.

---

### Step 2.3 — Webhook delivery log endpoint

**Files:** `src/routes/webhook.ts` (add route), `src/services/order.service.ts`

New endpoint:
```
GET /api/webhook-deliveries?order_id=pay_xxxxx&limit=20
```

Returns delivery attempts for the merchant's orders.

**Verification:**
- Shows forward attempts, status codes, timestamps
- Scoped to merchant

**Rollback:** Remove route.

---

## Phase 3: Per-Merchant Gateway Config

> **Goal:** Merchants can use their own gateway credentials, or fall back to
> platform-shared credentials.

### Step 3.1 — Add `merchant_gateways` table

**Files:** `src/config/database.ts`

```sql
CREATE TABLE IF NOT EXISTS merchant_gateways (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  gateway TEXT NOT NULL,                  -- 'midtrans', 'tripay', etc.
  credentials TEXT NOT NULL,              -- Encrypted JSON (AES-256-GCM)
  environment TEXT DEFAULT 'sandbox',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(merchant_id, gateway)
);
```

**Verification:** Table created, zero behavior change.

**Rollback:** Drop table.

---

### Step 3.2 — Gateway config resolution (merchant-first, fallback to env)

**Files:** `src/config/env.ts` (modify `getGatewayConfig`)

```typescript
export async function getGatewayConfigForMerchant(
  gateway: string,
  merchantId: string
) {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT credentials, environment FROM merchant_gateways WHERE merchant_id = ? AND gateway = ? AND enabled = 1',
    args: [merchantId, gateway],
  });

  if (result.rows.length > 0) {
    return JSON.parse(decrypt(result.rows[0].credentials as string));
  }

  // Fallback to platform env config
  return getGatewayConfig(gateway);
}
```

**Change in payment route:** Pass `merchantId` to gateway config resolution.

**Verification:**
- Merchant with own creds → uses own creds
- Merchant without own creds → uses platform creds (env)
- Existing behavior unchanged

**Rollback:** Revert to env-only config.

---

### Step 3.3 — Merchant gateway management API

**Files:** `src/routes/merchant.ts` (add endpoints)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/merchants/:id/gateways` | GET | List configured gateways |
| `/api/merchants/:id/gateways/:gateway` | PUT | Set gateway credentials |
| `/api/merchants/:id/gateways/:gateway` | DELETE | Remove gateway config |
| `/api/merchants/:id/gateways/:gateway` | PATCH | Enable/disable gateway |

**Verification:**
- Set creds → payment uses those creds
- Delete creds → falls back to platform
- Enable/disable works

**Rollback:** Remove endpoints.

---

## Phase 4: Rate Limiting & Billing Prep

> **Goal:** Per-merchant rate limits and transaction fee tracking.

### Step 4.1 — Per-merchant rate limiting

**Files:** `src/middleware/rate-limit.ts`

Change: Key rate limiter by `merchant_id` instead of IP.

```typescript
const key = c.get('merchantId') || c.req.header('X-Forwarded-For') || 'unknown';
```

**Verification:**
- Merchant A hitting limit doesn't affect Merchant B
- IP-based fallback for unauthenticated requests

**Rollback:** Revert to IP-only keying.

---

### Step 4.2 — Add `plan` rate limit tiers

**Files:** `src/middleware/rate-limit.ts`, `src/config/database.ts`

Read merchant's `plan` from context, apply tier:

| Plan | API Rate | Webhook Rate |
|------|----------|-------------|
| free | 30/min | 60/min |
| pro | 120/min | 300/min |
| enterprise | 600/min | 1200/min |

**Verification:**
- Free merchant hits limit at 30
- Pro merchant hits limit at 120
- Existing behavior (env key) uses free tier

**Rollback:** Revert to flat rate.

---

### Step 4.3 — Transaction fee tracking (no billing yet)

**Files:** `src/config/database.ts`, `src/services/order.service.ts`

Add `fee` and `net` columns to orders:

```sql
ALTER TABLE orders ADD COLUMN fee INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN net INTEGER DEFAULT 0;
```

On payment success:
```typescript
const feeRate = merchant.plan === 'enterprise' ? 0.01 : merchant.plan === 'pro' ? 0.02 : 0.025;
const fee = Math.round(amount * feeRate);
const net = amount - fee;
```

**Verification:**
- Fee calculated correctly per plan
- Net = amount - fee
- Existing orders have fee=0 (no breakage)

**Rollback:** Drop columns.

---

## Phase 5: Dashboard & Polish

> **Goal:** Merchant-facing dashboard, API docs per merchant, SDK.

### Step 5.1 — Dashboard scaffold (Next.js or Hono + static)

**Files:** `src/dashboard/` (new directory)

Static React app served from `/dashboard`. Uses the same API endpoints
with merchant's API key.

Pages:
- Overview (transaction count, volume, success rate)
- Transactions (list, search, filter)
- Gateways (configure credentials)
- Webhooks (delivery logs, configure endpoints)
- Settings (API key, plan, callback URL)

**Verification:**
- `/dashboard` loads
- Login with API key
- Transactions show correct data

**Rollback:** Remove dashboard directory.

---

### Step 5.2 — Per-merchant API docs

**Files:** `src/index.ts`

Change: `/reference` accepts `X-API-Key` header or `?key=` query param.
Swagger UI uses the key to authenticate "Try it out" requests.

**Verification:**
- Swagger UI pre-fills API key
- Try-it-out works with merchant's key

**Rollback:** Remove key pre-fill.

---

### Step 5.3 — TypeScript SDK

**Files:** `packages/sdk/` (new directory)

```typescript
import { OneAIPayment } from '@1ai/payment';

const payment = new OneAIPayment({ apiKey: '1pay_xxxxx' });

const order = await payment.create({
  gateway: 'midtrans',
  amount: 100000,
  callbackUrl: 'https://my-app.com/callback',
  metadata: { userId: '123' },
});

// order.paymentUrl → redirect user
// order.id → track payment
```

**Verification:**
- SDK creates payment
- SDK gets payment status
- SDK lists transactions

**Rollback:** Remove package.

---

## Summary: Dependency Graph

```
1.1 (merchants table)
 └─► 1.2 (auth reads merchants)
      ├─► 1.3 (order uses merchant_id)
      │    └─► 1.6 (per-merchant idempotency)
      ├─► 1.4 (forwarding uses merchant secret)
      └─► 1.5 (merchant CRUD API)
           ├─► 2.1 (transaction history)
           ├─► 2.2 (refunds)
           ├─► 2.3 (webhook delivery logs)
           ├─► 3.1 (merchant_gateways table)
           │    └─► 3.2 (merchant-first config)
           │         └─► 3.3 (gateway management API)
           ├─► 4.1 (per-merchant rate limiting)
           │    └─► 4.2 (plan tiers)
           └─► 4.3 (fee tracking)
                └─► 5.1 (dashboard)
                     ├─► 5.2 (per-merchant docs)
                     └─► 5.3 (SDK)
```

Each leaf is independently deployable. Each parent works without its children.

## Estimated Effort

| Phase | Steps | Est. Time | Priority |
|-------|-------|-----------|----------|
| Phase 1: Multi-tenant | 6 steps | 2-3 weeks | **P0** — blocks everything |
| Phase 2: History & Refunds | 3 steps | 1-2 weeks | **P1** — merchant needs |
| Phase 3: Merchant Gateways | 3 steps | 1-2 weeks | **P1** — platform differentiation |
| Phase 4: Rate & Billing | 3 steps | 1 week | **P2** — monetization |
| Phase 5: Dashboard & SDK | 3 steps | 2-3 weeks | **P2** — adoption |
