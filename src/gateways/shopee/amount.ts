/**
 * Shopee pure helpers — ported from paygateme/shopee/amount.go and token.go.
 *
 * ⚠️ EXPERIMENTAL: pure, offline-testable helpers only. No network calls.
 */

/**
 * parseShopeeAmount — parses Shopee's Indonesian grouped integer format into
 * whole rupiah. Returns null when the value cannot be parsed safely.
 *
 * Examples: "30.000" → 30000, "1.250.000" → 1250000, "30000" → 30000.
 * Rejects: "30.00", "30,000", "30.000.00", "-100", "1e5", decimals.
 */
export function parseShopeeAmount(value: string): number | null {
	const v = value.trim();
	if (v === "") return null;

	const plainDigits = /^\d+$/;
	const indonesianGroup = /^\d{1,3}(?:\.\d{3})+$/;

	if (!plainDigits.test(v) && !indonesianGroup.test(v)) return null;

	const normalized = v.replaceAll(".", "");
	const amount = Number(normalized);
	// Safe-integer check (mirrors Go int64 bound pragmatically in JS).
	if (!Number.isSafeInteger(amount) || amount < 0) return null;
	return amount;
}

/**
 * decodeJWTPayload — extracts the payload claims from a JWT without
 * verifying the signature (Shopee's dashboard cookie is a signed JWT whose
 * claims include the inner merchant token).
 */
export function decodeJWTPayload(
	jwt: string,
): Record<string, unknown> | null {
	const segments = jwt.split(".");
	if (segments.length !== 3 || segments[1] === "") return null;

	let payloadB64 = segments[1]
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.replace(/=+$/, "");

	const pad = payloadB64.length % 4;
	if (pad !== 0) payloadB64 += "=".repeat(4 - pad);

	try {
		const decoded = Buffer.from(payloadB64, "base64").toString("utf-8");
		const parsed = JSON.parse(decoded) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * ReadMerchantCredential — extracts the inner merchant token from Shopee's
 * signed dashboard JWT cookie (`__shopee_partner_website_x_token_live`).
 * Returns null when the cookie is missing or unreadable.
 */
export function readMerchantCredential(
	liveTokenCookie: string,
): {
	token: string;
	accountId: string;
	businessId: string;
	expiresAt: number; // epoch ms; 0 = unknown
} | null {
	if (!liveTokenCookie) return null;

	const payload = decodeJWTPayload(liveTokenCookie);
	if (!payload) return null;

	const token = payload.token;
	if (typeof token !== "string" || token === "") return null;

	const accountId = toStringValue(payload.userid);
	if (accountId === "") return null;

	const businessId = toStringValue(payload.businessId);

	let expiresAt = 0;
	if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
		expiresAt = payload.exp * 1000;
	}

	return { token, accountId, businessId, expiresAt };
}

function toStringValue(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
	return "";
}
