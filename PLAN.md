# 1ai-payment: Remediation Plan

**Date**: 2026-07-13
**Source**: Full codebase audit — 18 findings across 8 categories.
**Philosophy**: SOLID, KISS, DRY, 0 assumptions, 1ai-rules.

---

## Execution Contract

1. **Each PR = one GitHub Issue**. Issue stays open until PR merges.
2. **Ordered by dependency**. Later PRs may assume earlier ones merged.
3. **Fresh review agent before every merge** (`reviewer` agent, not self-review).
4. **Atomic scope**: each PR is small enough to fully understand in one sitting.
5. **No speculative abstraction** (YAGNI). Change only what the finding demands.
6. **Rollback path documented** in every PR body.


## Issue Number Mapping

| ID | Title | Issue # |
|---|---|---|
| P0-1 | Dedicated ENCRYPTION_KEY env var | #1 |
| P0-2 | Restrict CORS origin | #2 |
| P0-3 | Rate-limit POST /api/register endpoint | #5 |
| P0-4 | HTTPS enforcement in production | #6 |
| P0-5 | Idempotency DB constraint | #4 |
| P0-6 | Rate limiter stale entry eviction (memory leak) | #3 |
| P1-1 | Graceful shutdown | #8 |
| P1-2 | Webhook payload audit trail | #9 |
| P1-3 | Dead letter queue for failed forward events | #10 |
| P1-4 | Fix NOWPayments refunded status mapping | #11 |
| P2-1 | Remove duplicate Scalev apiKey config | #12 |
| P2-2 | Database migration system | #13 |
| P2-3 | Prometheus /metrics endpoint | #14 |
| P3-1 | Unit tests for remaining 9 gateways | #15 |
| P3-2 | Payment flow integration test | #17 |
| P3-3 | Unit tests for webhook handler | #16 |

---

## P0 — CRITICAL SECURITY (ship first, one at a time)

### #001: Dedicated ENCRYPTION_KEY env var

| Field | Value |
|---|---|
| **Why** | Encryption key derived from `API_KEY`. Rotating API_KEY = data loss. |
| **Files** | `src/config/env.ts`, `src/utils/crypto.ts`, `.env.example` |
| **Change** | Add `ENCRYPTION_KEY` to Config schema. `getEncryptionKey()` reads it directly. No derivation. Fallback: crash, not silent default. |
| **Risk** | Existing encrypted data becomes unreadable if key changes. Force re-encryption on first deploy. |
| **Rollback** | Revert env addition, restore old crypto.ts. Existing data readable again old key. |
| **Test** | Unit: encrypt/decrypt round-trip with known key. Integration: env missing = startup crash. |

### #002: Restrict CORS origin

| Field | Value |
|---|---|
| **Why** | `cors()` with no args = wide open. Any origin can call any endpoint. |
| **Files** | `src/index.ts` |
| **Change** | `cors({ origin: config.CORS_ORIGIN })`. Add `CORS_ORIGIN` to env (default `'*'` backward-compatible). |
| **Risk** | Existing clients on unexpected origins break on non-wildcard deploy. Keep default `'*'` in env.example. |
| **Rollback** | Set `CORS_ORIGIN=*` or revert index.ts. |
| **Test** | Curl with mismatched Origin → 403. Curl with allowed Origin → 200. |

### #003: Rate-limit registration endpoint

| Why | `POST /api/register` has NO rate limit. Anyone can spam-create merchants. |
|---|---|
| **Files** | `src/index.ts`, `src/routes/register.ts` |
| **Change** | Mount registration before `/api/*` but apply a dedicated `rateLimitMiddleware({ windowMs: 3600000, max: 5 })` specifically on register route. Or move register under `/api/*` and keep the existing rate limiter. |
| **Risk** | Legit registration fails under concurrent signups. 5/hr is generous for 1-person-company. |
| **Rollback** | Revert index.ts route order change. |
| **Test** | 6 rapid POST /api/register → 429 on 6th. |

### #004: HTTPS enforcement in production

| Why | No check. In production, plaintext traffic leaks API keys. |
|---|---|
| **Files** | `src/index.ts` |
| **Change** | In `app.onError` or a dedicated middleware: if `config.ENVIRONMENT === 'production'` and `X-Forwarded-Proto !== 'https'` → 426 Upgrade Required. |
| **Risk** | Behind a proxy that terminates TLS (the normal case). Use `X-Forwarded-Proto` header check. |
| **Rollback** | Remove condition. |
| **Test** | Curl `http://localhost` in prod mode → 426. Curl with X-Forwarded-Proto: https → passes. |

### #005: Idempotency — replace silent error swallow with DB UNIQUE constraint

| Why | `try/catch` with `// Ignore — proceed with creation` swallows DB errors. May create duplicate orders. |
|---|---|
| **Files** | `src/routes/payment.ts`, `src/config/database.ts` |
| **Change** | Add `UNIQUE(idempotency_key, merchant_id)` constraint. Remove the `try/catch` empty catch in payment.ts. Let DB constraint enforce uniqueness. |
| **Risk** | Migrations not supported yet (see #012). Must drop+recreate table or use `CREATE UNIQUE INDEX`. Use index approach: no migration system needed. |
| **Rollback** | `DROP INDEX idx_unique_idempotency_merchant`. |
| **Test** | Same idempotency_key twice → second returns 200 with existing order. Invalid key → 400, not 200. |

### #006: Rate limiter stale entry eviction

| Why | `counters` Map grows unboundedly. Each unique IP/merchant = permanent entry. Memory leak. |
|---|---|
| **Files** | `src/middleware/rate-limit.ts` |
| **Change** | On entry creation: schedule deletion after `windowMs`. Or: lazy eviction — if `now > entry.resetAt + windowMs`, delete the entry and create fresh. |
| **Risk** | None. Pure memory safety. |
| **Rollback** | Restore old file. |
| **Test** | Create entry, wait `windowMs+1ms`, verify entry is gone or reset. Unit-verify by reading Map size. |

---

## P1 — DATA INTEGRITY & OPERATIONS

### #007: Webhook payload audit trail

| Why | `webhook_events` table stores metadata but NOT the raw payload or headers. Cannot audit what the gateway sent. |
|---|---|
| **Files** | `src/config/database.ts`, `src/routes/webhook.ts` |
| **Change** | Add `raw_payload TEXT, raw_headers TEXT` columns to `webhook_events`. Populate from incoming webhook. |
| **Risk** | Payloads can be large. Use TEXT, no index. Production payloads with PII must be logged per security rules (already in webhook.ts — no amounts/signatures logged). |
| **Rollback** | Remove columns from schema. |
| **Test** | POST webhook → SQL: `SELECT raw_payload FROM webhook_events` → matches input body. |

### #008: Graceful shutdown

| Why | `Bun.serve({ fetch })` without signal handler. SIGTERM drops in-flight requests. |
|---|---|
| **Files** | `src/index.ts` |
| **Change** | Add `process.on('SIGTERM', ...)` / `process.on('SIGINT', ...)` that calls `server.stop()`, drains in-flight, then exits. |
| **Risk** | None. Pure ops hardening. |
| **Rollback** | Remove handler. |
| **Test** | Start server, curl long endpoint, SIGTERM → curl completes. |

### #009: Dead letter queue for failed forward events

| Why | After 3 retries, forwarder logs and gives up. Payload is lost forever on the aggregator. No replay possible. |
|---|---|
| **Files** | `src/services/forwarder.service.ts`, `src/config/database.ts` |
| **Change** | Add `failed_forwards` table: `order_id, payload, error, attempts, created_at`. Write to it when max retries exhausted. Admin endpoint or replay worker. |
| **Risk** | Adds storage. Minimal. |
| **Rollback** | Drop table. |
| **Test** | Point callback_url to dead endpoint → verify row in `failed_forwards`. |

### #010: NOWPayments refunded status mapped correctly

| Why | `refunded → 'failed'` loses information. `refunded` is a valid `PaymentStatus` value. |
|---|---|
| **Files** | `src/gateways/nowpayments.ts` |
| **Change** | Line 168: `refunded: 'failed'` → `refunded: 'refunded'`. |
| **Risk** | None. Semantic fix. |
| **Rollback** | Revert one line. |
| **Test** | Unit: `normalizeEvent` with `payment_status: 'refunded'` → `status === 'refunded'`. |

---

## P2 — CONFIG & MONITORING

### #011: Scalev config deduplication

| Why | `apiKey` and `storefrontApiKey` both read `SCALEV_STOREFRONT_API_KEY`. Duplicate. |
|---|---|
| **Files** | `src/config/env.ts` |
| **Change** | Remove `apiKey` alias, keep `storefrontApiKey`. Update gateway implementation if it references `apiKey`. |
| **Risk** | May break internal usage if something references `gatewayConfig.apiKey`. Grep for usage first. |
| **Rollback** | Restore duplicate key. |
| **Test** | `getGatewayConfig('scalev')` returns no `apiKey` field. Gateway creates payments without error. |

### #012: Database migration system

| Why | `CREATE TABLE IF NOT EXISTS` — no schema versioning, no rollback. Every deploy re-runs DDL. Cannot add columns safely. Blocking several PRs above (#005, #007, #009). |
|---|---|
| **Files** | `src/config/migrations.ts` (new), `src/config/database.ts` |
| **Change** | Add `migrations` table with version tracking. Each DDL change is a numbered migration. Run on startup. Seed current schema as v001. |
| **Risk** | First deploy must not conflict with existing schema. `IF NOT EXISTS` handles it for v001. |
| **Rollback** | `DROP TABLE migrations` + restore old `database.ts` ORM. |
| **Test** | Fresh DB: migrations run, `migrations` table has v001. Existing DB (no migrations table): v001 created, v002 skipped. |

### #013: Prometheus metrics endpoint

| Why | No metrics. Cannot monitor payment volumes, errors, latency. |
|---|---|
| **Files** | `src/middleware/metrics.ts` (new), `src/index.ts` |
| **Change** | Counter for: payments created (by gateway/status), webhooks received, forward failures, errors. Histogram for: payment creation latency. Expose `GET /metrics`. |
| **Risk** | Tiny dependency on `prom-client` or implement counters manually. |
| **Rollback** | Remove middleware + route. |
| **Test** | Create payment → GET /metrics → counter incremented. |

---

## P3 — TESTING (parallel, no deps on each other)

### #014: Gateway unit tests

| Why | Only midtrans has unit tests. Other 9 gateways are untested for status mapping, signature verification, event normalization. |
|---|---|
| **Files** | `tests/unit/<gateway>.test.ts` × 9 |
| **Change** | Each gateway: test `createPayment` params, `normalizeEvent` mapping, `verifySignature` valid & invalid. |
| **Risk** | None. |
| **Rollback** | Delete test files. |
| **Test** | New tests alone (no project-wide). |

### #015: Payment flow integration test

| Why | No end-to-end test for the critical path: POST /api/payments → webhook → forward. Only register + refund tested. |
|---|---|
| **Files** | `tests/integration/payment-flow.test.ts` (new) |
| **Change** | Mock callback server. POST payment, simulate webhook, verify callback received + order status updated. |
| **Risk** | None. |
| **Rollback** | Delete test file. |
| **Test** | `bun test` passes. |

### #016: Webhook handler tests

| Why | Webhooks are the most security-critical path. No tests for invalid signatures, unknown gateways, duplicate events. |
|---|---|
| **Files** | `tests/unit/webhook.test.ts` (new) |
| **Change** | Test: valid signature → 200, invalid → 401, unknown gateway → 400, duplicate event → idempotent 200. |
| **Risk** | None. |
| **Rollback** | Delete test file. |
| **Test** | `bun test` passes. |

---

## Dependency Graph

```
P0-1 (#001 ENCRYPTION_KEY)        ─┐
P0-2 (#002 CORS)                    ├── all independent, no ordering needed
P0-3 (#003 Register rate limit)     │
P0-4 (#004 HTTPS)                   │
P0-5 (#005 Idempotency)            ─┤
P0-6 (#006 Rate eviction)          ─┘
                                     │
P1-1 (#007 Webhook audit)       ────┤  depends on #005 (same table schema)
P1-2 (#008 Graceful shutdown)  ────┤  independent
P1-3 (#009 Dead letter queue)  ────┤  independent
P1-4 (#010 NOWPayments fix)    ────┤  independent
                                     │
P2-1 (#011 Scalev dedup)       ────┤  independent
P2-2 (#012 Migration system)   ────┤  PREREQUISITE for safe DDL changes
P2-3 (#013 Metrics)            ────┤  independent
                                     │
P3-1 (#014 Gateway tests)      ────┤  independent (or after fixes land)
P3-2 (#015 Payment flow test)  ────┤
P3-3 (#016 Webhook tests)      ────┘
```

---

## Execution Order (recommended)

```
# Phase 0 — Security
#001 → #002 → #003 → #004 → #005 → #006
    │
# Phase 1 — Data & Ops
    ├→ #007 (webhook payload — needs #005)
    ├→ #010 (1-line fix)
    ├→ #008 (graceful shutdown)
    ├→ #009 (dead letter queue)
    └→ #005 blocks #007 only
    │
# Phase 2 — Infrastructure
    ├→ #012 (migration system — enables safe schema changes)
    ├→ #011 (scalev — independent)
    └→ #013 (metrics — independent)
    │
# Phase 3 — Testing
    ├→ #014 (gateway tests)
    ├→ #015 (payment flow)
    └→ #016 (webhook tests)
```

---

## PR Body Template

Every PR body MUST include:

```markdown
## Issue
Closes #N

## Change
- bullet list of exact changes

## Risk
- what could break
- what was considered but rejected

## Rollback
- exact steps to revert

## Verification
- [ ] Specific test(s) pass
- [ ] Manual test result (if applicable)
```

## Review Protocol

**BEFORE EVERY MERGE:**
1. Open PR
2. Spawn fresh `reviewer` agent on the diff
3. Fix all BLOCK findings
4. Fix or explicitly defer MEDIUM findings
5. Only then merge

---

## Blockers & Assumptions (verified against codebase 2026-07-13)

| # | Claim | Verified |
|---|---|---|
| 1 | `cors()` has no args | `src/index.ts:29` — confirmed |
| 2 | Encryption derived from `API_KEY` via SHA-256 | `src/utils/crypto.ts:74-75` — confirmed |
| 3 | Registration not rate-limited | `src/index.ts:34` before line 30 middleware — confirmed |
| 4 | No HTTPS enforcement | `src/index.ts:82-84` — confirmed, no check |
| 5 | Idempotency try/catch silently swallows | `src/routes/payment.ts:119-121` — confirmed |
| 6 | Rate limiter Map has no eviction | `src/middleware/rate-limit.ts:21` — confirmed |
| 7 | NOWPayments maps refunded→failed | `src/gateways/nowpayments.ts:168` — confirmed |
| 8 | Scalev `apiKey` = `storefrontApiKey` | `src/config/env.ts:169-170` — confirmed |
| 9 | Webhook_events has no raw_payload | `src/config/database.ts:47-57` — confirmed |
| 10 | No migration system | `src/config/database.ts` — only `CREATE TABLE IF NOT EXISTS` |
| 11 | No graceful shutdown | `src/index.ts:81-84` — bare `Bun.serve()` |
| 12 | No dead letter queue | `src/services/forwarder.service.ts:84-92` — confirmed |
| 13 | No Prometheus metrics | confirmed via grep |
| 14 | 4 test files, 39 tests, 66 expects | confirmed via `bun test` |
| 15 | No gateway tests beyond midtrans | confirmed via glob |
