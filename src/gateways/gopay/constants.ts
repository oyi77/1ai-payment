/**
 * GoPay provider constants — ported from paygateme/gopay/constants.go.
 *
 * ⚠️ EXPERIMENTAL: reverse-engineered GoBiz merchant-dashboard endpoints.
 * Upstream (paygateme) marks this provider as in-development / untested
 * against the live API. Auth/feed paths are UNVERIFIED.
 */

/** GoBiz merchant API host. */
export const GOBIZ_API_BASE_URL = "https://api.gobiz.co.id";
/** GoID/Gojek host (login/token flows + transaction feed). */
export const GOJEK_API_BASE_URL = "https://api.gojekapi.com";

/** Endpoint paths. */
export const EP = {
	LOGIN_REQUEST: "/goid/login/request",
	TOKEN: "/goid/token",
	USERS_ME: "/v1/users/me",
	MERCHANTS_SEARCH: "/v1/merchants/search",
	TRANSACTIONS: "/merchant-analytics/v2/merchants/transactions",
} as const;

/** merchantDetail — endpoint for a specific merchant. */
export function merchantDetail(merchantId: string): string {
	return `/v1/merchants/${merchantId}`;
}

/** GoID client identifiers used by the web dashboard. */
export const DEFAULT_GOID_CLIENT_ID = "go-biz-web-new";
export const DEFAULT_APP_ID = "go-biz-web-dashboard";
export const DEFAULT_APP_VERSION = "platform-v3.109.0-d4b20f12";

/**
 * DefaultStaticHeaders — baseline headers required by the GoID/GoBiz gateway.
 * The dashboard identifies itself as a web merchant client.
 */
export function defaultStaticHeaders(): Record<string, string> {
	return {
		Accept: "application/json, text/plain, */*",
		"Authentication-Type": "go-id",
		"X-PhoneMake": "Web",
		"X-PhoneModel": "Node.js Client",
		"x-DeviceOS": "Web",
		"X-User-Locale": "id",
		"Gojek-Country-Code": "ID",
		"Gojek-Timezone": "Asia/Jakarta",
		"X-Platform": "Web",
		"X-User-Type": "merchant",
		"x-appId": DEFAULT_APP_ID,
	};
}

/** Statuses representing money actually received by the merchant. */
export const PAID_TRANSACTION_STATUSES = ["settlement", "capture"];

/** Payment types the gateway polls for. GoPay QRIS is the primary channel. */
export const DEFAULT_PAYMENT_TYPES = ["qris", "gopay"];

/** Timings (ms). */
export const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 20_000;

/** Feed page sizing. */
export const MAX_TRANSACTION_PAGE_SIZE = 100;
export const DEFAULT_TRANSACTION_PAGE_SIZE = MAX_TRANSACTION_PAGE_SIZE;

/**
 * TransactionAmountScale — divisor converting merchant-analytics amounts
 * (minor units) into whole rupiah. The feed sends 300100 for Rp 3.001.
 */
export const TRANSACTION_AMOUNT_SCALE = 100;
