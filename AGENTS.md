# AGENTS.md — 1ai-payment

## MANDATORY PROCESS (8 Steps — No Skipping)

Every task follows this sequence. No exceptions.

1. **AUDIT** — Read existing code. Understand current state.
2. **THINK** — Understand WHY. Intent vs literal.
3. **BRAINSTORM** — ≥3 approaches. Score options.
4. **PLAN** — Decompose. Risks. Rollback plan.
5. **EXECUTE** — Build. TDD when possible.
6. **TEST** — Run all tests. Break it first.
7. **VERIFY** — Prove with literal output.
8. **REVIEW** — Read your own diff before committing.

Full details: `~/.1ai/core/PROCESS.md` (auto-injected by hooks)

## This repo

Payment gateway **aggregator** — unified API for creating payments across 10 gateways and routing callbacks to owning projects.
Stack: TypeScript / Hono / LibSQL (SQLite)
Domain: Payment creation, webhook aggregation, signature verification, order routing, callback forwarding
Gateways: midtrans, tripay, duitku, nowpayments, ipaymu, scalev, xendit, telegram_stars, telegram_payments, paypal

Engineering rules are enforced by machine-level loaders when `setup-dev.sh` has been run:
- Claude Code: SessionStart hook injects `~/.1ai/core/RULES.md` + enforcement table
- OpenCode: plugin injects `~/.1ai/core/RULES.md` + enforcement table
- OMP: wrapper appends `~/.1ai/core/RULES.md` + enforcement table to launch sessions

Primary rules file:
```bash
cat ~/.1ai/core/RULES.md
```

Full engineering protocol:
```bash
cat ~/.1ai/core/ENGINEERING.md
```

Pre-ship gate (14 gates — ALL must pass):
```bash
cat ~/.1ai/core/GATE.md
```

Task decomposition (before writing code):
```bash
cat ~/.1ai/core/PLAN.md
```

Adversarial review (for COMPLEX PRs):
```bash
cat ~/.1ai/core/REVIEWER.md
```

If `~/.1ai` or auto-load is missing, run:
```bash
bash ~/.1ai/scripts/setup-dev.sh
```

Do NOT add the rules repo as a git submodule. Update rules centrally, then run/sync the thin `AGENTS.md` template.

## Hard rules (enforced — not suggestions)

1. Read code before writing code. (RULES.md §1)
2. No completion claim without literal receipt. (RULES.md §2)
3. Compile/test/use like a real user before claiming work is ready. (RULES.md §6)
4. Task must match this repo domain. (RULES.md §4)
5. **Before writing code**: classify scope as TRIVIAL/STANDARD/COMPLEX (PLAN.md §2).
   COMPLEX = ANY of: >5 files, new dep, public interface change, unclear rollback, auth/security/infra.
6. **Before commit**: run ALL 14 gates from GATE.md. Paste the output. Any unchecked = DO NOT COMMIT.
7. **For COMPLEX changes**: open GitHub Issue → break into small PRs → deploy fresh-context reviewer (REVIEWER.md §8).
   BLOCK findings = DO NOT MERGE until fixed and re-reviewed.
8. **After any failure**: run LEARN.md retrospective. Add anti-pattern if new class of failure.

## Security rules (CRITICAL — payment domain)

1. **NEVER log raw webhook payloads** — log only order_id, gateway, status. No amounts, no signatures.
2. **Signature verification is MANDATORY** — reject any webhook without valid signature. No exceptions.
3. **Idempotency required** — duplicate webhook must not double-credit. Use idempotency keys + UNIQUE constraints.
4. **Rate limit all endpoints** — payment endpoints: 60 req/min. Webhook endpoints: 120 req/min.
5. **No hardcoded secrets** — all keys from env. `.env.example` only, never `.env`.
6. **Timing-safe comparison** — use `crypto.timingSafeEqual` for signature checks.
7. **HTTPS only** — reject any non-TLS webhook in production.
8. **Metadata preserved** — project metadata passed through full lifecycle: create → callback → forward.

## Repo-specific conventions

- **Provider/Plugin pattern**: all gateways implement `PaymentGateway` interface (RULES.md §5 PROVIDER/PLUGIN)
- **Idempotent webhooks**: duplicate callbacks must produce same result as first (ENGINEERING.md §5)
- **Thin routing layer**: business logic (credits, subscriptions) stays in owning project
- **Normalized events**: all gateway webhooks → `NormalizedPaymentEvent` before forwarding
- **Error isolation**: one gateway failure must not affect others
- **Forwarding is async**: webhook returns 200 immediately, forward to project via background job with retries
- **Payment creation is sync**: `POST /api/payments` waits for gateway response before returning payment URL
- **Metadata passthrough**: project metadata attached to order, returned in callbacks

## Directory layout

```
src/
├── schemas.ts       # Zod schemas (source of truth for validation + OpenAPI)
├── config/          # Environment, database
├── gateways/        # Gateway implementations (Provider pattern)
│   ├── base.ts      # Abstract PaymentGateway interface + types
│   ├── midtrans.ts  # Midtrans — SHA-512 signature
│   ├── tripay.ts    # Tripay — HMAC-SHA256 signature
│   ├── duitku.ts    # Duitku — MD5 signature
│   ├── nowpayments.ts # NOWPayments — HMAC-SHA512 signature
│   ├── ipaymu.ts    # iPaymu — SHA-256 signature
│   ├── scalev.ts    # Scalev — HMAC-SHA256 signature
│   ├── xendit.ts    # Xendit — X-Callback-Token header
│   ├── telegram-stars/    # Telegram Stars (XTR)
│   ├── telegram-payments/ # Telegram Payments (multi-currency)
│   ├── paypal/      # PayPal — webhook signature
│   └── index.ts     # Gateway registry (add gateway = implement + register)
├── middleware/       # Rate limiting, auth
├── routes/          # Hono route handlers (OpenAPIHono + createRoute)
│   ├── webhook.ts   # /webhook/:gateway (callback receiver)
│   ├── payment.ts   # /api/payments, /api/gateways
│   └── health.ts    # /health
├── services/        # Business logic
│   ├── order.service.ts      # Order CRUD + routing
│   ├── forwarder.service.ts  # Forward events to projects (async, 3-retry)
│   └── gateway.service.ts    # Gateway registry + methods listing
├── utils/           # Crypto, logger, errors
└── index.ts         # Entry point — OpenAPIHono + Swagger UI
```

## Commands

- Dev:   `bun run dev`
- Test:  `bun test`
- Build: `bun run build`
- Lint:  `bun run lint`
- Type:  `bun run typecheck`

## Adding a New Gateway

1. Create `src/gateways/<name>/` — implement `PaymentGateway` interface from `base.ts`
2. Register in `src/gateways/index.ts`
3. Add gateway name to `GATEWAY_NAMES` in `src/schemas.ts`
4. Add env vars to `src/config/env.ts` and `.env.example`

## API Docs

- Swagger UI: `GET /reference` (auto-generated from Zod schemas)
- OpenAPI JSON: `GET /doc` (auto-generated, always in sync with code)