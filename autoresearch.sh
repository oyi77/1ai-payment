#!/usr/bin/env bash
# Autoresearch benchmark harness for 1ai-payment.
# Goal: close all the gaps -> be the best payment gateway aggregator in the market.
# Metric: tests_passed (higher = more behavioral coverage / gaps closed).
# Workload: the project's own unit-test suite, offline-deterministic subset
# (the only network-dependent file, forwarder.service.test.ts, is excluded
# because it performs live HTTP calls and would make the metric non-deterministic).
set -uo pipefail

cd "$(dirname "$0")" || exit 1

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun not found" >&2
  exit 1
fi

# Collect offline-safe unit test files (exclude network-dependent forwarder test).
mapfile -t FILES < <(find tests/unit -name '*.test.ts' ! -name 'forwarder.service.test.ts' | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "ERROR: no unit test files found" >&2
  exit 1
fi

# Run the workload. bun test exits non-zero when failures exist; capture regardless.
OUT="$(bun test "${FILES[@]}" 2>&1)" || true

# Parse the bun summary lines: "  N pass" / "  M fail".
PASS="$(printf '%s\n' "$OUT" | grep -oE '^[[:space:]]*[0-9]+ pass' | grep -oE '[0-9]+' | head -1)"
FAIL="$(printf '%s\n' "$OUT" | grep -oE '^[[:space:]]*[0-9]+ fail' | grep -oE '[0-9]+' | head -1)"
PASS="${PASS:-0}"
FAIL="${FAIL:-0}"

# Secondary: gateway implementations present (market breadth).
GW="$(find src/gateways -maxdepth 1 -mindepth 1 \( -type d -o -name '*.ts' \) ! -name 'base.ts' ! -name 'index.ts' | wc -l)"

if [ "$FAIL" -ne 0 ]; then
  echo "METRIC tests_failed=$FAIL"
  echo "METRIC gateways_implemented=$GW"
  exit 1
fi

echo "METRIC tests_passed=$PASS"
echo "METRIC tests_failed=$FAIL"
echo "METRIC gateways_implemented=$GW"
exit 0
