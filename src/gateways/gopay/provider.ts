/**
 * GoPay provider internals — ported from paygateme/gopay/{auth,http,merchant}.go.
 *
 * ⚠️ EXPERIMENTAL: reverse-engineered GoBiz merchant-dashboard API.
 * Upstream (paygateme) marks this provider in-development / untested against
 * the live GoBiz API. Structure follows paygateme exactly; wire-shape may drift.
 *
 * SCOPE OF THIS MODULE:
 * - Session RESTORE from persisted token set (consume sessions minted
 *   externally, e.g. paygateme's cmd/login CLI).
 * - TokenManager lifecycle (pre-expiry + 401-forced refresh) against GoID.
 * - Merchant profile / outlets with static QRIS discovery.
 * - Offset-based transaction feed (minor-unit → whole-rupiah normalization).
 *
 * OUT OF SCOPE (TODO when live creds available):
 * - OTP login flow (RequestOTP / VerifyOTP).
 */

import { GatewayError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { staticToDynamicQris } from "../../utils/qris";
import type { MerchantTransaction } from "../base";
import {
	DEFAULT_GOID_CLIENT_ID,
	DEFAULT_PAYMENT_TYPES,
	DEFAULT_TRANSACTION_PAGE_SIZE,
	EP,
	GOBIZ_API_BASE_URL,
	GOJEK_API_BASE_URL,
	PAID_TRANSACTION_STATUSES,
	REQUEST_TIMEOUT_MS,
	defaultStaticHeaders,
	merchantDetail,
} from "./constants";
import { normalizeGoPayTransaction, type RawGoPayTransaction } from "./feed";
import { TokenManager, type TokenSet } from "./token";

/** Persisted GoPay session (exported by paygateme's CLI). */
export interface GoPaySessionState {
	accessToken: string;
	refreshToken: string;
	tokenType?: string;
	/** epoch ms; 0 = unknown. */
	expiresAt?: number;
	/** Merchant id resolved at login time (feed scope). */
	merchantId?: string;
	merchantName?: string;
	/** Static QRIS from outlet profile (gopay_qr_string / aspi_qr_string). */
	staticQris?: string;
	/** Raw outlet/merchant metadata for debugging. */
	raw?: unknown;
}

/** Error signalling the refresh token was rejected — re-login required. */
export class AuthRequiredError extends GatewayError {
	constructor(message: string) {
		super("gopay", message);
		this.name = "AuthRequiredError";
	}
}

export function isAuthRequired(err: unknown): boolean {
	return err instanceof AuthRequiredError;
}

interface GoIDTokenPayload {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number; // seconds
}

/**
 * GoPayProvider — holds a restored token session, exposes feed/profile reads.
 * Construct via `GoPayProvider.fromSession(json)`.
 */
export class GoPayProvider {
	private readonly tokenManager: TokenManager;
	readonly merchantId: string;
	readonly merchantName: string;
	readonly staticQris: string;

	private constructor(
		tokenManager: TokenManager,
		merchantId: string,
		merchantName: string,
		staticQris: string,
	) {
		this.tokenManager = tokenManager;
		this.merchantId = merchantId;
		this.merchantName = merchantName;
		this.staticQris = staticQris;
	}

	/** Parse + validate a persisted session. Throws on invalid/expired-refresh. */
	static fromSession(raw: string | unknown): GoPayProvider {
		let obj: unknown = raw;
		if (typeof raw === "string") {
			try {
				obj = JSON.parse(raw);
			} catch {
				throw new GatewayError("gopay", "Session JSON malformed");
			}
		}
		const s = obj as GoPaySessionState;
		if (!s || typeof s !== "object" || !s.accessToken) {
			throw new GatewayError("gopay", "Session missing accessToken");
		}
		if (!s.refreshToken) {
			throw new AuthRequiredError(
				"Session missing refresh token; re-login required",
			);
		}

		const tokenSet: TokenSet = {
			accessToken: s.accessToken,
			refreshToken: s.refreshToken,
			tokenType: s.tokenType ?? "Bearer",
			expiresAt: s.expiresAt ?? 0,
		};

		const tokenManager = new TokenManager(
			{
				refresh: async (refreshToken: string): Promise<TokenSet> => {
					return refreshGoIDTokens(refreshToken);
				},
			},
			tokenSet,
		);

		return new GoPayProvider(
			tokenManager,
			s.merchantId ?? "",
			s.merchantName ?? "",
			s.staticQris ?? "",
		);
	}

	authenticated(): boolean {
		return this.tokenManager.authenticated();
	}

	/** Current token set (for session re-persist). */
	exportSession(): GoPaySessionState {
		const t = this.tokenManager.getTokens();
		return {
			accessToken: t.accessToken,
			refreshToken: t.refreshToken,
			tokenType: t.tokenType,
			expiresAt: t.expiresAt,
			merchantId: this.merchantId,
			merchantName: this.merchantName,
			staticQris: this.staticQris,
		};
	}

	/** Low-level authenticated GET against GoBiz. Retries once on 401. */
	private async getJson<T>(path: string): Promise<T> {
		const token = await this.tokenManager.getValidAccessToken();
		const url = `${GOBIZ_API_BASE_URL}${path}`;
		const res = await fetch(url, {
			method: "GET",
			headers: {
				...defaultStaticHeaders(),
				Authorization: `Bearer ${token}`,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (res.status === 401) {
			// Server rejected the token — local expiry estimate is wrong. Force
			// one refresh and retry (paygateme's 401-retry interceptor).
			const fresh = await this.tokenManager.forceRefresh();
			const retry = await fetch(url, {
				method: "GET",
				headers: {
					...defaultStaticHeaders(),
					Authorization: `Bearer ${fresh.accessToken}`,
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!retry.ok) {
				const text = await retry.text().catch(() => "");
				if (retry.status === 401) {
					throw new AuthRequiredError("GoPay rejected refreshed token; re-login required");
				}
				throw new GatewayError("gopay", `HTTP ${retry.status}: ${text.slice(0, 200)}`);
			}
			return (await retry.json()) as T;
		}

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new GatewayError("gopay", `HTTP ${res.status}: ${text.slice(0, 200)}`);
		}
		return (await res.json()) as T;
	}

	/**
	 * Fetch recent settled transactions. Offset-based pagination; amounts are
	 * minor units (÷100 → whole rupiah) in normalizeGoPayTransaction.
	 */
	async fetchTransactions(
		startTime: Date,
		endTime: Date,
		maxPages = 10,
	): Promise<MerchantTransaction[]> {
		if (!this.merchantId) {
			throw new GatewayError(
				"gopay",
				"Session missing merchantId; re-export session from paygateme CLI",
			);
		}

		const out: MerchantTransaction[] = [];
		let from = 0;
		for (let page = 0; page < maxPages; page++) {
			const params = new URLSearchParams({
				from: String(from),
				size: String(DEFAULT_TRANSACTION_PAGE_SIZE),
				start_time: startTime.toISOString(),
				end_time: endTime.toISOString(),
				merchant_ids: this.merchantId,
				statuses: PAID_TRANSACTION_STATUSES.join(","),
				payment_types: DEFAULT_PAYMENT_TYPES.join(","),
			});
			const raw = await this.getJson<{
				transactions?: RawGoPayTransaction[];
				total?: number;
			}>(`${EP.TRANSACTIONS}?${params.toString()}`);

			const list = raw.transactions ?? [];
			for (const t of list) out.push(normalizeGoPayTransaction(t));

			from += list.length;
			if (list.length < DEFAULT_TRANSACTION_PAGE_SIZE) break;
			if (raw.total !== undefined && from >= raw.total) break;
		}
		return out;
	}

	/** Generate a dynamic QRIS payload for a unique amount from the static QR. */
	dynamicQris(amount: number): string {
		if (!this.staticQris) {
			throw new GatewayError("gopay", "No static QRIS bound to this session");
		}
		return staticToDynamicQris(this.staticQris, amount);
	}
}

/**
 * refreshGoIDTokens — POST /goid/token with grant_type=refresh_token.
 * The refresh token nests under `data`; a flat top-level refresh_token is
 * rejected with 401 by GoID. Bearer header deliberately empty — auth
 * endpoints must never re-enter the 401 auto-retry loop.
 */
export async function refreshGoIDTokens(refreshToken: string): Promise<TokenSet> {
	const body = {
		client_id: DEFAULT_GOID_CLIENT_ID,
		data: { refresh_token: refreshToken },
		grant_type: "refresh_token",
	};
	const res = await fetch(`${GOJEK_API_BASE_URL}${EP.TOKEN}`, {
		method: "POST",
		headers: {
			...defaultStaticHeaders(),
			Authorization: "Bearer",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		if (res.status === 400 || res.status === 401) {
			throw new AuthRequiredError(
				"Refresh token expired or invalid; GoPay re-login required",
			);
		}
		throw new GatewayError("gopay", `Token refresh failed: ${res.status} ${text.slice(0, 200)}`);
	}

	const payload = (await res.json()) as GoIDTokenPayload;
	if (!payload.access_token) {
		throw new AuthRequiredError("Token response missing access token; re-login required");
	}

	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token || refreshToken,
		tokenType: payload.token_type || "Bearer",
		expiresAt: payload.expires_in
			? Date.now() + payload.expires_in * 1000
			: 0,
	};
}

export { logger as gopayLogger };
