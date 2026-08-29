# GATE 6 Evidence — `/api/payments` robustness (port 3105, isolated test server)

Server under test: `bun run src/index.ts` (corrected `app.ts` + `rate-limit.ts`), `NODE_ENV=production`, `DATABASE_PATH=./data/payment.db`, `PORT=3105`.

## 6A. Malformed bodies → 4xx (never 500)

```bash
# empty body
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3105/api/payments \
  -H 'X-API-Key: <valid>' -H 'Content-Type: application/json' \
  -H 'X-Forwarded-Proto: https' -d ''
# → 400

# invalid JSON
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3105/api/payments \
  -H 'X-API-Key: <valid>' -H 'Content-Type: application/json' \
  -H 'X-Forwarded-Proto: https' -d '{not json'
# → 400

# missing amount (schema-valid shell, required field absent)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3105/api/payments \
  -H 'X-API-Key: <valid>' -H 'Content-Type: application/json' \
  -H 'X-Forwarded-Proto: https' -d '{"gateway":"midtrans","currency":"IDR","callback_url":"https://example.com/cb"}'
# → 400
```

## 6B. Wrong-key burst → rate-limited at #61 (GATE 6 acceptance)

```bash
BODY='{"gateway":"midtrans","amount":10000,"currency":"IDR","callback_url":"https://example.com/cb"}'
: > /tmp/burst3105.txt
for i in $(seq 1 70); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3105/api/payments \
    -H 'X-API-Key: wrongkey' -H 'Content-Type: application/json' \
    -H 'X-Forwarded-Proto: https' -d "$BODY")
  printf '%s' "$code" >> /tmp/burst3105.txt
done
echo "" >> /tmp/burst3105.txt
python3 - <<'PY'
s=open('/tmp/burst3105.txt').read().strip()
codes=[s[i:i+3] for i in range(0,len(s),3)]
from collections import Counter
print("total",len(codes),"first_non_401",next((i+1 for i,c in enumerate(codes) if c!='401'),None),Counter(codes))
PY
```

Result (verbatim):

```
total 70 first_non_401 61 Counter({'401': 60, '429': 10})
```

First 60 wrong-key payments → `401`. 61st → `429` (rate limit, `max=60` on the `/api/*` pre-auth limiter). Remaining 9 → `429`. Matches GATE 6 acceptance: "70 wrong-key payments → 429 at #61". `max` stays 60 (raising to 600 would hide the defect).

## 6C. Idempotent webhook (midtrans, unknown-order path)

Script `/tmp/mt-replay.mjs` POSTs the same midtrans settlement callback twice to `http://localhost:3105/webhook/midtrans` (header `X-Forwarded-Proto: https`), then counts `webhook_events` rows by `order_id`.

```
first_callback_http=200 second_callback_http=200 webhook_events_count_for_audit_order_1=1 expect=2xx/2xx/1
```

Single row despite two identical callbacks → dedup via `idx_webhook_events_dedup` (UNIQUE `order_id, gateway, status`) / SELECT-then-200 branch. Duplicate webhooks do not double-credit.
