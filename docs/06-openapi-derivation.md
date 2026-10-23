# 06 — OpenAPI Derivation Contract

`GET /doc` serves a decorated OpenAPI 3.1.0 document. Hono's own generator emits paths in declaration order with no `operationId`, no tag list and no servers; `src/services/openapi-document.ts` adds all three so code generators, Postman exports and MCP tooling see a stable contract.

| Requirement | Guarantee | Source |
|---|---|---|
| Operation IDs | Non-empty, unique, `[A-Za-z][A-Za-z0-9]*`, deterministic per method+path. Collisions resolved by appending `On{Subject}` + optional counter | `resolveOperationIds()`, `deriveOperationId()` |
| Tag ordering | Prescribed order, every used tag declared with a description | `TAG_ORDER`, `buildTags()` |
| Webhook paths | Canonical `/webhook/{gateway}` sort before `/webhooks/{gateway}` aliases | `isCanonicalWebhookPath()` |
| Servers | Public production URL first; local URL appended outside production | `serversFor()` |
| Method order | `post, get, put, patch, delete, head, options, trace` within each path item | `methodOrder()` |

Contract tests: `tests/integration/openapi-doc.test.ts`.

## Operation ID derivation

### Base construction

`deriveOperationId(method, path)` walks path segments, drops `api`, converts `{placeholders}` into their PascalCase names, and appends a verb.

**Verb map:**
- `get` → `List` for **collection** paths (zero placeholders)
- `get` → `Get` for items (one or more placeholders)  
- `post` → `Create`
- `put` → `Set`
- `patch` → `Update`
- `delete` → `Delete`

**Placeholder handling:**

- Trailing placeholder moves subject before verb: `/payments/{id}` → `PaymentsGet` (not `PaymentsIdGet`)
- Multiple placeholders preserve order but drop `api`: `/merchants/{id}/api-key` → `MerchantsApiKeyCreate`

### Collision resolution

When two entries normalize to the same base name, `resolveOperationIds()` applies:

1. First entry keeps base (`PaymentsCreate`)
2. Second gets `BaseOn{Discriminator}` where discriminator = last path segment in PascalCase
3. Ties continue with counters: `BaseOnX`, `BaseOnX2`, ...

Example: Two resources could produce `RefundsCreate`, `RefundsCreateOnMerchant` if needed.

## Tag ordering

```
Payments → Gateways → Transactions → Refunds → Saved Methods → Webhooks
→ Merchants → Registration → Admin → Health → Mutations
```

Tags used by an operation but absent from this list are appended alphabetically with a fallback description, so a new route tag never silently disappears from the doc.

## Path ordering

`decorateOpenApiDocument()` sorts paths so canonical webhook receivers come first, then by raw path string length, then lexicographically. Aliases stay in the document for backward compatibility but never precede their canonical form.

## Public surface

| Path | Content |
|---|---|
| `GET /doc` | OpenAPI 3.1.0 JSON, generated from the live route table on every request |
| `GET /reference` | Swagger UI rendered from `/doc`; `persistAuthorization` on, API keys rejected as query params |

## Verified live (2026-10-23)

`https://pay.berkahkarya.org/doc`: 58 paths, 66 operations, 66 unique operationIds, first path `/webhook/lynk`, first tags `Payments, Gateways, Transactions, Refunds`, screenshot-free DOM probe of `/reference` rendered 66 operation blocks across 11 tags with zero console errors.

## Operation ID examples (live)

| Method | Path | operationId |
|---|---|---|
| POST | /api/payments | PaymentsCreate |
| GET | /api/payments/{id} | PaymentsGet |
| GET | /api/payments | PaymentsList |
| GET | /health | HealthList |
| POST | /webhook/lynk | CallbackLynkCreate |
| POST | /api/refunds | RefundsCreate |
| GET | /api/refunds | RefundsList |
| POST | /api/merchants/{id}/api-key | MerchantsApiKeyCreate |
