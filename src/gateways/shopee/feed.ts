/**
 * Shopee transaction-feed normalization — ported from paygateme/shopee/feed.go.
 *
 * ⚠️ EXPERIMENTAL: pure normalization only. Network fetch lives in provider.ts.
 */

import type { MerchantTransaction } from "../base";
import { parseShopeeAmount } from "./amount";
import { COMPLETED_TRANSACTION_STATUS } from "./constants";

/**
 * jsonNumberToString renders a JSON value the way the reference client's
 * String() does: numbers as plain integers (never scientific notation), so
 * float64(17190191) becomes "17190191" — required for the scope check.
 */
function jsonNumberToString(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
	return "";
}

/**
 * normalizeShopeeTransaction converts one raw Shopee feed item into a
 * normalized MerchantTransaction. Returns null when the record is malformed
 * or belongs to a different merchant/store than expected (scope guard).
 *
 * Amounts arrive as Indonesian-grouped strings ("30.000"); converted to whole
 * rupiah via parseShopeeAmount. Timestamps are unix seconds → ISO string.
 */
export function normalizeShopeeTransaction(
	raw: Record<string, unknown>,
	expectedMerchantId: string,
	expectedStoreId: string,
): MerchantTransaction | null {
	const id = typeof raw.transactionId === "string" ? raw.transactionId.trim() : "";
	if (!id) return null;

	const amountStr = typeof raw.amount === "string" ? raw.amount : "";
	const amount = parseShopeeAmount(amountStr);
	if (amount === null) return null;

	const createTime = Number(raw.createTime);
	if (!Number.isFinite(createTime) || createTime <= 0) return null;
	const createdAt = new Date(createTime * 1000).toISOString();

	// Scope guard: never settle another merchant's transactions.
	const rawMerchantId = jsonNumberToString(raw.merchantId);
	const rawStoreId = jsonNumberToString(raw.storeId);
	if (rawMerchantId !== expectedMerchantId || rawStoreId !== expectedStoreId) {
		return null;
	}

	const status = Number(raw.status);
	const completed = status === COMPLETED_TRANSACTION_STATUS;
	const statusLabel = completed ? "completed" : `shopee:${status}`;

	const orderId =
		(typeof raw.externalTransactionId === "string" && raw.externalTransactionId) ||
		(typeof raw.displayTransactionId === "string" && raw.displayTransactionId) ||
		id;

	const paymentType =
		`shopee:${jsonNumberToString(raw.service ?? raw.transactionType)}`;

	return {
		transaction_id: id,
		amount,
		status: statusLabel,
		created_at: createdAt,
		raw: { ...raw, _orderId: orderId, _paymentType: paymentType },
	};
}
