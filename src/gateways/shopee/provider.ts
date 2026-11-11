/**
 * Shopee provider internals — ported from paygateme/shopee/{http,auth,feed,merchant}.go.
 *
 * ⚠️ EXPERIMENTAL: reverse-engineered private merchant API. Unverified
 * against live endpoints (no credentials available). Structure follows
 * paygateme exactly; wire-shape may drift when Shopee updates.
 *
 * SCOPE OF THIS MODULE:
 * - Session RESTORE + validation (consume sessions minted elsewhere, e.g.
 *   paygateme's cmd/login CLI).
 * - Cursor-paginated transaction feed with scope guards.
 * - Merchant profile + store list discovery.
 * - Token expiry surfacing (AUTH_REQUIRED signal).
 *
 * OUT OF SCOPE (TODO when live creds available):
 * - OTP login flow (RequestOtp / VerifyOtp / CompleteLogin).
 * - Device-risk fingerprint reporting.
 * - Password-migration pre-checks.
 */

import { GatewayError } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { readMerchantCredential } from "./amount";
import { CookieJar, type Cookie } from "./cookie";
import {
	ACCOUNT_BASE_URL,
	COMPLETED_TRANSACTION_STATUS,
	DEFAULT_LANGUAGE,
	DEFAULT_TIMEZONE,
	EP,
	INVALID_TOKEN_CODES,
	LIVE_TOKEN_COOKIE,
	PARTNER_API_BASE_URL,
	PARTNER_BASE_URL,
	PARTNER_LOGIN_FROM,
	PAY_BASE_URL,
	STORE_PAGE_SIZE,
	TRANSACTION_PAGE_SIZE,
	TRANSACTION_SERVICES,
} from "./constants";
import { normalizeShopeeTransaction } from "./feed";
import type { MerchantTransaction } from "../base";
import type {
	MerchantCredential,
	MerchantProfile,
	Session,
	Store,
} from "./types";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES_PER_TICK = 10;

/** Envelope shapes returned by Shopee's various APIs. */
interface AccountEnvelope {
	error: number;
	msg?: string;
	data?: Record<string, unknown>;
}
interface PartnerEnvelope {
	code: number;
	message?: string;
	data?: Record<string, unknown>;
}
interface PaymentEnvelope {
	code?: number;
	msg?: string;
	data?: Record<string, unknown>;
	error?: number;
}

/** Error codes signalling an invalid/rejected merchant token. */
class AuthRequiredError extends GatewayError {
	constructor(message: string) {
		super("shopee", message);
		this.name = "AuthRequiredError";
	}
}

function isAuthRequired(err: unknown): boolean {
	return err instanceof AuthRequiredError;
}

/** Decode a partner/payment envelope; throw AuthRequired on token-reject codes. */
function requirePartnerData(env: PartnerEnvelope): Record<string, unknown> {
	if (env.code !== 0) {
		const code = String(env.code);
		if (INVALID_TOKEN_CODES.has(code)) {
			throw new AuthRequiredError(
				"Shopee rejected the merchant token; session expired or invalid",
			);
		}
		throw new GatewayError(
			"shopee",
			env.message || `Shopee partner API error ${code}`,
		);
	}
	if (!env.data) throw new GatewayError("shopee", "Empty data in partner response");
	return env.data;
}

function requirePaymentData(env: PaymentEnvelope): Record<string, unknown> {
	const errCode = env.error ?? env.code ?? 0;
	if (errCode !== 0) {
		const code = String(errCode);
		if (INVALID_TOKEN_CODES.has(code)) {
			throw new AuthRequiredError(
				"Shopee rejected the merchant token; session expired or invalid",
			);
		}
		throw new GatewayError(
			"shopee",
			env.msg || `ShopeePay API error ${code}`,
		);
	}
	if (!env.data) throw new GatewayError("shopee", "Empty data in payment response");
	return env.data;
}

/** Headers builders — mirror paygateme/shopee/api.go. */
function partnerHeaders(token: string): Record<string, string> {
	return {
		Origin: PARTNER_BASE_URL,
		Referer: `${PARTNER_BASE_URL}/`,
		"X-Merchant-ToB-Clientid": "undefined",
		"X-Merchant-Login-From": PARTNER_LOGIN_FROM,
		"X-Merchant-From": PARTNER_LOGIN_FROM,
		"X-Merchant-Language": DEFAULT_LANGUAGE,
		"X-Merchant-Timezone": DEFAULT_TIMEZONE,
		"X-Merchant-RequestId": crypto.randomUUID(),
		"shopee-baggage": "PFB=undefined",
		"X-Merchant-Token": token,
	};
}

function paymentHeaders(): Record<string, string> {
	return {
		Origin: PARTNER_BASE_URL,
		Referer: `${PARTNER_BASE_URL}/`,
		"X-Timestamp-Ms": String(Date.now()),
		"X-Token": "",
	};
}

function paymentMetadata(token: string): Record<string, unknown> {
	return { token, language: DEFAULT_LANGUAGE, timezone: DEFAULT_TIMEZONE };
}

/**
 * ShopeeProvider — holds a restored session, exposes feed/profile/store reads.
 *
 * Construct via `ShopeeProvider.fromSession(json)` — sessions are minted
 * externally (paygateme CLI) and pasted into merchant_gateways.credentials.
 */
export class ShopeeProvider {
	private readonly jar = new CookieJar();
	private readonly session: Session;
	private readonly credential: MerchantCredential;

	private constructor(session: Session, credential: MerchantCredential) {
		this.session = session;
		this.credential = credential;
		this.jar.restore(session.cookies);
	}

	/** Parse + validate a persisted session JSON. Throws on invalid/expired. */
	static fromSession(raw: string | unknown): ShopeeProvider {
		let obj: unknown = raw;
		if (typeof raw === "string") {
			try {
				obj = JSON.parse(raw);
			} catch {
				throw new GatewayError("shopee", "Session JSON malformed");
			}
		}
		const session = obj as Session;
		if (
			!session ||
			typeof session !== "object" ||
			!Array.isArray(session.cookies) ||
			!session.accountId ||
			!session.merchant?.id
		) {
			throw new GatewayError("shopee", "Session missing required fields");
		}

		const liveCookie = session.cookies.find(
			(c) => c.name === LIVE_TOKEN_COOKIE,
		);
		if (!liveCookie?.value) {
			throw new GatewayError(
				"shopee",
				`Session missing ${LIVE_TOKEN_COOKIE} cookie`,
			);
		}

		const cred = readMerchantCredential(liveCookie.value);
		if (!cred) {
			throw new GatewayError("shopee", "Cannot decode merchant token from session");
		}

		if (cred.expiresAt > 0 && cred.expiresAt <= Date.now()) {
			throw new AuthRequiredError("Shopee session token expired; re-login required");
		}

		return new ShopeeProvider(session, cred);
	}

	/** Whether the in-memory credential is still believed-valid (local check only). */
	authenticated(): boolean {
		if (this.credential.expiresAt === 0) return true;
		return this.credential.expiresAt > Date.now();
	}

	accountToken(): string {
		return this.credential.token;
	}

	merchantId(): string {
		return this.session.merchant.id;
	}

	storeId(): string {
		return this.session.storeId ?? this.session.stores[0]?.id ?? "";
	}

	/** Export the current session (with refreshed cookies) for persistence. */
	exportSession(): Session {
		return {
			...this.session,
			cookies: this.jar.snapshot(),
		};
	}

	/** Low-level JSON POST with cookie application + Set-Cookie capture. */
	private async postJson<T>(
		url: string,
		headers: Record<string, string>,
		body: unknown,
	): Promise<T> {
		// Attach stored cookies matching this URL.
		const cookies = this.jar.getCookies(url);
		const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

		const res = await fetch(url, {
			method: "POST",
			headers: {
				...headers,
				"Content-Type": "application/json",
				...(cookieHeader ? { Cookie: cookieHeader } : {}),
			},
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		// Capture Set-Cookie headers back into the jar.
		const setCookies = res.headers.getSetCookie?.() ?? [];
		if (setCookies.length > 0) {
			this.jar.setCookies(
				url,
				parseSetCookieHeaders(setCookies),
			);
		}

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new GatewayError(
				"shopee",
				`HTTP ${res.status}: ${text.slice(0, 200)}`,
			);
		}

		return (await res.json()) as T;
	}

	/** Fetch merchant profile via partner API. Validates merchant-id match. */
	async getProfile(): Promise<MerchantProfile> {
		const env = await this.postJson<PartnerEnvelope>(
			`${PARTNER_API_BASE_URL}${EP.USER_INFO}`,
			partnerHeaders(this.credential.token),
			{},
		);
		const data = requirePartnerData(env);
		const merchantId = String(data.merchantId ?? "");
		if (!merchantId || merchantId !== this.session.merchant.id) {
			throw new GatewayError(
				"shopee",
				"Shopee returned a profile for a different merchant",
			);
		}
		return {
			merchantId,
			merchantName: String(data.merchantName ?? ""),
			storeId: String(data.store_id ?? ""),
			accountId: String(data.tocUid ?? this.session.accountId),
			userId: String(data.tobUserId ?? ""),
			userName: String(data.userName ?? data.tocUserName ?? ""),
			language: String(data.language ?? DEFAULT_LANGUAGE),
			shopeePayServiceStatus: Number(data.shopeepay_service_status ?? 0),
		};
	}

	/** List stores under the active merchant (paginated by lastStoreId cursor). */
	async listStores(maxPages = 20): Promise<Store[]> {
		const seen = new Map<string, Store>();
		let lastStoreId = 0;
		for (let page = 0; page < maxPages; page++) {
			const env = await this.postJson<PaymentEnvelope>(
				`${PAY_BASE_URL}${EP.STORES}`,
				paymentHeaders(),
				{
					data: {
						metadata: paymentMetadata(this.credential.token),
						storeName: "",
						lastStoreId,
						pageSize: STORE_PAGE_SIZE,
						serviceList: [1, 10],
					},
				},
			);
			const data = requirePaymentData(env);
			const list = Array.isArray(data.list) ? (data.list as Record<string, unknown>[]) : [];
			for (const r of list) {
				const id = String(r.storeId ?? "");
				if (!id) continue;
				seen.set(id, {
					id,
					name: String(r.storeName ?? ""),
					status: Number(r.status ?? 0),
				});
			}
			if (list.length < STORE_PAGE_SIZE) break;
			const lastRaw = list[list.length - 1] as Record<string, unknown>;
			const nextId = Number(lastRaw.storeId);
			if (!nextId || nextId === lastStoreId) break;
			lastStoreId = nextId;
		}
		return [...seen.values()];
	}

	/**
	 * Fetch recent transactions within [startTime, endTime], cursor-paginated.
	 *
	 * Scope guard: only records whose merchantId+storeId match the session are
	 * kept; everything else is dropped (logged as malformed/out-of-scope).
	 */
	async fetchTransactions(
		startTime: Date,
		endTime: Date,
		maxPages = MAX_PAGES_PER_TICK,
	): Promise<MerchantTransaction[]> {
		const merchantId = this.session.merchant.id;
		const storeId = this.storeId();
		const out: MerchantTransaction[] = [];
		const seenIds = new Set<string>();
		const seenCursors = new Set<string>();
		let nextPosition = "";
		let rejected = 0;

		for (let page = 0; page < maxPages; page++) {
			const env = await this.postJson<PaymentEnvelope>(
				`${PAY_BASE_URL}${EP.TRANSACTIONS}`,
				paymentHeaders(),
				{
					data: {
						metadata: paymentMetadata(this.credential.token),
						pageSize: TRANSACTION_PAGE_SIZE,
						filter: {
							startTime: Math.floor(startTime.getTime() / 1000),
							endTime: Math.floor(endTime.getTime() / 1000),
							serviceList: TRANSACTION_SERVICES,
						},
						sorter: { field: "createTime", order: "descend" },
						next_position: nextPosition,
					},
				},
			);
			const data = requirePaymentData(env);
			const list = Array.isArray(data.list) ? (data.list as Record<string, unknown>[]) : [];

			for (const r of list) {
				const tx = normalizeShopeeTransaction(r, merchantId, storeId);
				if (!tx) {
					rejected++;
					continue;
				}
				if (!seenIds.has(tx.transaction_id)) {
					seenIds.add(tx.transaction_id);
					out.push(tx);
				}
			}

			const cursor = typeof data.next_position === "string" ? data.next_position : "";
			if (!cursor) break;
			if (cursor === nextPosition || seenCursors.has(cursor)) {
				throw new GatewayError("shopee", "Transaction cursor did not advance");
			}
			seenCursors.add(cursor);
			nextPosition = cursor;
		}

		if (rejected > 0) {
			logger.warn("Shopee: ignored malformed/out-of-scope transactions", {
				count: rejected,
			});
		}

		return out;
	}
}

/**
 * Parse Set-Cookie header values into the shape CookieJar.setCookies expects.
 * Best-effort — ignores attributes beyond expires/max-age/domain/path/secure/httpOnly.
 */
function parseSetCookieHeaders(headers: string[]): Array<{
	name: string;
	value: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	expires?: number;
}> {
	const out = [];
	for (const h of headers) {
		const parts = h.split(";").map((s) => s.trim());
		if (parts.length === 0) continue;
		const eq = parts[0].indexOf("=");
		if (eq <= 0) continue;
		const name = parts[0].slice(0, eq);
		const value = parts[0].slice(eq + 1);
		const attrs: Record<string, string> = {};
		for (let i = 1; i < parts.length; i++) {
			const [k, ...rest] = parts[i].split("=");
			attrs[k.toLowerCase()] = rest.join("=");
		}
		let expires = 0;
		if (attrs["max-age"]) {
			const secs = Number(attrs["max-age"]);
			if (Number.isFinite(secs)) expires = Date.now() + secs * 1000;
		} else if (attrs.expires) {
			const t = Date.parse(attrs.expires);
			if (!Number.isNaN(t)) expires = t;
		}
		out.push({
			name,
			value,
			domain: attrs.domain,
			path: attrs.path,
			secure: "secure" in attrs,
			httpOnly: "httponly" in attrs,
			expires,
		});
	}
	return out;
}

export { isAuthRequired, AuthRequiredError };
