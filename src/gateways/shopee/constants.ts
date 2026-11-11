/**
 * Shopee provider constants — ported from paygateme/shopee/constants.go.
 *
 * ⚠️ EXPERIMENTAL: These are reverse-engineered endpoints from the Shopee
 * Merchant web dashboard, not an official API. Endpoints may break at any
 * time. Auth/feed paths are UNVERIFIED — only pure helpers (amount parse,
 * JWT decode, feed normalization) have offline test coverage.
 */

/** Canonical provider identifier (matches 1ai-payment gateway key "shopee"). */
export const PROVIDER_ID = "shopee";

/** Base URLs. */
export const ACCOUNT_BASE_URL =
	"https://partner.business.accounts.shopee.co.id";
export const PARTNER_BASE_URL = "https://partner.shopee.co.id";
export const PARTNER_API_BASE_URL = "https://api.partner.shopee.co.id";
export const PAY_BASE_URL = "https://shopeepay.shopee.co.id";
export const DEVICE_FINGERPRINT_URL =
	"https://df.infra.sz.shopee.co.id/v2/shpsec/web/report";
export const SZ_SDK_VERSION = "1.12.26-user.1";

/** Endpoint paths. */
export const EP = {
	// Account auth (passport)
	CHECK_PASSWORD_MIGRATION:
		"/api/v4/account/business/check_password_migrate",
	CHECK_ACCOUNT_BY_PASSWORD:
		"/api/v4/account/business/check_account_exist_by_password",
	AUTHENTICATE_BY_PASSWORD:
		"/api/v4/account/business/authenticate_toc_by_password",
	OTP_SETTINGS: "/api/v4/account/business/get_otp_settings",
	SEND_OTP: "/api/v4/account/business/send_otp",
	VERIFY_OTP: "/api/v4/account/business/verify_otp",
	AUTHENTICATE_BY_OTP: "/api/v4/account/business/authenticate_toc_by_otp",
	LOGIN_TOC: "/api/v4/account/business/login_toc",
	LOGIN_STATUS: "/api/v4/account/business/login_status",
	// Partner / merchant
	MERCHANT_DETECT:
		"/nb/mss/mer-detect-api/PartnerMerchantDetectServer/MerchantDetect",
	SWITCH_MERCHANT:
		"/nb/mss/mer-detect-api/PartnerMerchantDetectServer/SwitchMerchant",
	USER_INFO: "/nb/mss/web-api/PartnerAccountServer/GetUserInfo",
	ACCOUNT_LOGIN: "/account/login/auth",
	ACCOUNT_LOGIN_TOKEN: "/authenticate/login/token/",
	ACCOUNT_TOB_AUTH: "/account/login/tob/auth",
	PARTNER_LOGIN_AUTH: "/login/auth",
	STORES: "/merchant/v1/partner-web/get-store-list",
	TRANSACTIONS: "/merchant/v1/partner-web/get-transaction-list",
} as const;

/** OTP constants. */
export const OTP_OPERATION = 50001;
export const DEFAULT_OTP_CHANNEL = 3; // WhatsApp
export const DEFAULT_LANGUAGE = "id";
export const DEFAULT_TIMEZONE = "Asia/Jakarta";

/** Auth constants. */
export const PARTNER_LOGIN_FROM = "12";
export const BUSINESS_CLIENT_ID = "1";
export const ACCOUNT_CLIENT_ID = "5";

/** Transaction feed constants. */
export const COMPLETED_TRANSACTION_STATUS = 3;
export const TRANSACTION_PAGE_SIZE = 10;
export const STORE_PAGE_SIZE = 30;

/** Cookie names. */
export const LIVE_TOKEN_COOKIE =
	"__shopee_partner_website_x_token_live";
export const CLIENT_ID_COOKIE = "SPC_CLIENTID";

/** Auth error codes (passport). */
export const AUTH_ERROR_NEED_OTP = 48401102;
export const AUTH_ERROR_NOT_LOGIN = 48500102;

/** Token rejection codes — session invalid, re-login required. */
export const INVALID_TOKEN_CODES = new Set([
	"200020",
	"200021",
	"200022",
	"200023",
]);

/** Transaction service filter values for the feed. */
export const TRANSACTION_SERVICES = [1, 3];

/** Store service filter values for discovery. */
export const STORE_SERVICES = [1, 10];
