/**
 * GoPay OTP login flow — ported from paygateme/gopay/auth.go + merchant.go.
 *
 * ⚠️ EXPERIMENTAL and admin-only: drives GoPay's private GoID endpoints to
 * mint a merchant session. Upstream marks GoPay as in-development / untested
 * against the live API. Guarded behind ADMIN_AUTH_EXPERIMENTAL=true.
 *
 * Flow (simpler than Shopee — no device fingerprint, no redirect chain):
 *   1. POST /goid/login/request { client_id, phone_number, country_code }
 *      → { success, data: { otp_token } }
 *   2. POST /goid/token { client_id, data: { otp, otp_token }, grant_type: "otp" }
 *      → { access_token, refresh_token, token_type, expires_in }
 *   3. GET /v1/users/me → { user: { merchant_id } }
 *   4. GET /v1/merchants/:id → merchant profile with pops[].gopay.aspi_qr_string
 *
 * OTP challenge state is carried by the CALLER (otp_token round-trips through
 * the admin) — no server-side challenge store needed.
 */

import {
	DEFAULT_GOID_CLIENT_ID,
	EP,
	GOJEK_API_BASE_URL,
	REQUEST_TIMEOUT_MS,
	defaultStaticHeaders,
	merchantDetail,
} from "./constants";
import { GatewayError } from "../../utils/errors";
import type { TokenSet } from "./token";
import type { GoPaySessionState } from "./provider";

/** GoID response envelope. */
interface GoIDEnvelope {
	success: boolean;
	data?: unknown;
	errors?: Array<{ code: string; message?: string; message_title?: string }>;
}

/** GoID token response payload. */
interface GoIDTokenPayload {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
}

export class GoPayAuthRequiredError extends GatewayError {
	constructor(message: string) {
		super("gopay-auth", message);
		this.name = "GoPayAuthRequiredError";
	}
}

/** assertSuccess — check the GoID envelope; throw with first error detail. */
function assertSuccess(raw: GoIDEnvelope, context: string): void {
	if (raw.success) return;
	let detail = JSON.stringify(raw).slice(0, 200);
	if (raw.errors && raw.errors.length > 0) {
		const e = raw.errors[0];
		detail = e.message || e.message_title || e.code || detail;
	}
	throw new GatewayError("gopay-auth", `${context}: ${detail}`);
}

/** normalizePhone — strip non-digits, then leading zeros. */
export function normalizePhone(phone: string): string {
	return phone.replace(/[^0-9]/g, "").replace(/^0+/, "");
}

async function goidPost<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${GOJEK_API_BASE_URL}${path}`, {
		method: "POST",
		headers: {
			...defaultStaticHeaders(),
			Authorization: "Bearer", // deliberately empty — no retry loop here
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		if (res.status === 400 || res.status === 401) {
			throw new GoPayAuthRequiredError(
				`GoID rejected the request (${res.status}); re-login required`,
			);
		}
		throw new GatewayError("gopay-auth", `GoID HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}

/** Result of requesting an OTP. */
export interface GoPayOtpChallenge {
	otpToken: string;
	/** Masked phone as sent (normalized). */
	phone: string;
	countryCode: string;
}

/**
 * requestGoPayOtp — step 1. Sends an OTP for the phone number.
 * Returns the otp_token that VerifyOtp needs.
 */
export async function requestGoPayOtp(
	phone: string,
	countryCode = "62",
): Promise<GoPayOtpChallenge> {
	const raw = await goidPost<GoIDEnvelope>(EP.LOGIN_REQUEST, {
		client_id: DEFAULT_GOID_CLIENT_ID,
		phone_number: normalizePhone(phone),
		country_code: countryCode,
	});
	assertSuccess(raw, "Failed to request OTP");

	const data = (raw.data ?? {}) as Record<string, unknown>;
	const otpToken =
		(typeof data.otp_token === "string" && data.otp_token) ||
		(typeof data.token === "string" && data.token) ||
		"";
	if (!otpToken) {
		throw new GatewayError("gopay-auth", "GoID OTP response missing otp_token");
	}
	return { otpToken, phone: normalizePhone(phone), countryCode };
}

/** toTokenSet — raw payload → normalized TokenSet. */
function toTokenSet(payload: GoIDTokenPayload): TokenSet {
	if (!payload.access_token) {
		throw new GoPayAuthRequiredError("Token response missing access token");
	}
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token ?? "",
		tokenType: payload.token_type || "Bearer",
		expiresAt: payload.expires_in && payload.expires_in > 0
			? Date.now() + payload.expires_in * 1000
			: 0,
	};
}

/**
 * verifyGoPayOtp — step 2. Exchanges OTP + otp_token for the token pair.
 */
export async function verifyGoPayOtp(
	otp: string,
	otpToken: string,
): Promise<TokenSet> {
	if (!otpToken) {
		throw new GoPayAuthRequiredError(
			"otpToken is required; pass the value returned by requestGoPayOtp",
		);
	}
	const raw = await goidPost<GoIDTokenPayload>(EP.TOKEN, {
		client_id: DEFAULT_GOID_CLIENT_ID,
		data: { otp, otp_token: otpToken },
		grant_type: "otp",
	});
	return toTokenSet(raw);
}

/** GET with Bearer against GoBiz (no auto-retry here — minting only). */
async function gobizGet<T>(path: string, accessToken: string): Promise<T> {
	const res = await fetch(`https://api.gobiz.co.id${path}`, {
		method: "GET",
		headers: { ...defaultStaticHeaders(), Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		if (res.status === 401) {
			throw new GoPayAuthRequiredError("GoBiz rejected the fresh token; re-login required");
		}
		throw new GatewayError("gopay-auth", `GoBiz HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}

interface UsersMeResponse {
	user?: { merchant_id?: string };
}

interface MerchantDetailResponse {
	id?: string;
	merchant_name?: string;
	pops?: Array<{
		pop_id?: string;
		name?: string;
		status?: string;
		gopay?: { gopay_receiver_id?: string; gopay_qr_string?: string; aspi_qr_string?: string };
	}>;
}

/**
 * Complete the login: tokens → merchant id → profile w/ static QRIS.
 * Produces a GoPaySessionState ready for platform_gateways storage.
 */
export async function completeGoPayLogin(
	tokens: TokenSet,
): Promise<GoPaySessionState> {
	const me = await gobizGet<UsersMeResponse>(EP.USERS_ME, tokens.accessToken);
	const merchantId = me.user?.merchant_id ?? "";
	if (!merchantId) {
		throw new GatewayError(
			"gopay-auth",
			"GoBiz /users/me returned no merchant_id; account may not be a merchant",
		);
	}

	let merchantName = "";
	let staticQris = "";
	try {
		const detail = await gobizGet<MerchantDetailResponse>(
			merchantDetail(merchantId),
			tokens.accessToken,
		);
		merchantName = detail.merchant_name ?? "";
		const outletWithQr = (detail.pops ?? []).find(
			(p) => p.gopay && (p.gopay.aspi_qr_string || p.gopay.gopay_qr_string),
		);
		if (outletWithQr?.gopay) {
			staticQris = outletWithQr.gopay.aspi_qr_string || outletWithQr.gopay.gopay_qr_string || "";
		}
	} catch (err) {
		// Profile fetch is best-effort; session remains valid without QRIS —
		// admin can paste staticQris separately.
		if (!isGoPayAuthRequired(err)) throw err;
		throw err;
	}

	return {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		tokenType: tokens.tokenType,
		expiresAt: tokens.expiresAt,
		merchantId,
		merchantName,
		staticQris,
	};
}

export function isGoPayAuthRequired(err: unknown): boolean {
	return err instanceof GoPayAuthRequiredError;
}
