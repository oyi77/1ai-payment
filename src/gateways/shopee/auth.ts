/**
 * Shopee OTP login flow — ported from paygateme/shopee/auth.go.
 *
 * ⚠️ EXPERIMENTAL and admin-only: drives Shopee's private passport OTP
 * endpoints to mint a merchant session without external tooling. Unverified
 * against live endpoints; wire-shape may drift. Guarded behind
 * ADMIN_AUTH_EXPERIMENTAL=true.
 *
 * Flow: bootstrap session → device fingerprint → check password migration →
 * account exists → authenticate (password or OTP) → get OTP settings → send
 * OTP → verify OTP → authenticate TOC → merchant detect → select merchant →
 * complete login → extract merchant token + cookies.
 *
 * Not wired into the gateway registry — the ShopeeGateway restores a session
 * produced by this module.
 */

import {
	ACCOUNT_BASE_URL as AccountBaseURL,
	AUTH_ERROR_NEED_OTP,
	ACCOUNT_CLIENT_ID,
	BUSINESS_CLIENT_ID,
	DEFAULT_LANGUAGE,
	DEFAULT_OTP_CHANNEL,
	DEFAULT_TIMEZONE,
	DEVICE_FINGERPRINT_URL,
	EP,
	OTP_OPERATION,
	PARTNER_API_BASE_URL,
	PARTNER_BASE_URL,
	PARTNER_LOGIN_FROM,
} from "./constants";
import { readMerchantCredential } from "./amount";
import { CookieJar, type Cookie } from "./cookie";
import type {
	MerchantSummary,
	OtpChallenge,
	OtpVerification,
	Session,
	Store,
	SwitchCredential,
} from "./types";
import { GatewayError } from "../../utils/errors";

// Browser identity the passport flow requires to receive OTP delivery.
const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
	Accept: "application/json, text/plain, */*",
	"Accept-Language": "id,en-US;q=0.9,en;q=0.8",
	"Sec-Fetch-Dest": "empty",
	"Sec-Fetch-Mode": "cors",
	"Sec-Fetch-Site": "same-site",
};

const REQUEST_TIMEOUT_MS = 20_000;

const CLIENT_ID_COOKIE = "SPC_CLIENTID";

export interface OtpRequestOptions {
	password?: string;
	channel?: number;
	language?: string;
	timezone?: string;
}

class AuthGatewayError extends GatewayError {
	constructor(message: string) {
		super("shopee-auth", message);
		this.name = "AuthGatewayError";
	}
}

function defaultString(v: string | undefined, fallback: string): string {
	return v ? v : fallback;
}

function md5Hex(input: string): string {
	const h = Bun.CryptoHasher.hash("md5", input);
	return Buffer.from(h).toString("hex");
}
function sha256Hex(input: string): string {
	const h = Bun.CryptoHasher.hash("sha256", input);
	return Buffer.from(h).toString("hex");
}
/** HashShopeePassword — SHA-256 over the lowercase MD5 hex digest. */
export function hashShopeePassword(password: string): string {
	return sha256Hex(md5Hex(password));
}

/** ShopeeURL — build a URL from a base and path. */
function shopeeUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface AuthHttpClient {
	jar: CookieJar;
}

/** Minimal HTTP client with manual redirect-following + cookie capture. */
class HttpClient {
	jar: CookieJar = new CookieJar();

	private async request(
		method: string,
		url: string,
		headers: Record<string, string>,
		body?: unknown,
		rawBody?: string,
	): Promise<Response> {
		const cookies = this.jar.getCookies(url);
		const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

		const init: RequestInit = {
			method,
			headers: {
				...BROWSER_HEADERS,
				...headers,
				...(cookieHeader ? { Cookie: cookieHeader } : {}),
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: "manual", // we follow manually to capture cookies each hop
		};

		if (rawBody !== undefined) {
			init.body = rawBody;
			init.headers = { ...init.headers, "Content-Type": "text/plain;charset=UTF-8" };
		} else if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const res = await fetch(url, init);
		this.captureCookies(url, res);
		return res;
	}

	private captureCookies(url: string, res: Response): void {
		const setCookies = res.headers.getSetCookie?.() ?? [];
		if (setCookies.length === 0) return;
		this.jar.setCookies(url, parseSetCookie(setCookies));
	}

	/** JSON call; throws on HTTP >= 400. Returns parsed body. */
	async json<T>(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<T> {
		const res = await this.request(method, url, headers, body);
		if (res.status >= 400) {
			const text = await res.text().catch(() => "");
			throw new AuthGatewayError(`Shopee HTTP ${res.status}: ${text.slice(0, 200)}`);
		}
		const text = await res.text();
		if (!text) return {} as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new AuthGatewayError("Shopee returned unreadable JSON");
		}
	}

	/** GET following redirects manually (captures cookies each hop). */
	async followGet(url: string, headers: Record<string, string> = {}): Promise<ResponseLikeBody> {
		let current = url;
		for (let redirect = 0; redirect <= 5; redirect++) {
			const res = await this.request("GET", current, headers);
			if (res.status < 300 || res.status >= 400) {
				return { status: res.status, body: await res.arrayBuffer() };
			}
			const location = res.headers.get("Location");
			if (!location) {
				throw new AuthGatewayError(`Shopee redirect without location (${res.status})`);
			}
			current = new URL(location, current).toString();
		}
		throw new AuthGatewayError("Shopee redirect limit exceeded");
	}
}

interface ResponseLikeBody {
	status: number;
	body: ArrayBuffer;
}

/** Envelope shapes. */
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

function requireAccountData(env: AccountEnvelope, path: string): Record<string, unknown> {
	if (env.error !== 0 && env.error !== AUTH_ERROR_NEED_OTP) {
		throw new AuthGatewayError(
			env.msg || `Shopee account API error ${env.error} (${path})`,
		);
	}
	if (env.data == null) throw new AuthGatewayError(`Shopee empty data (${path})`);
	return env.data;
}

function requirePartnerData(env: PartnerEnvelope, path: string): Record<string, unknown> {
	if (env.code !== 0) {
		throw new AuthGatewayError(
			env.message || `Shopee partner API error ${env.code} (${path})`,
		);
	}
	if (env.data == null) throw new AuthGatewayError(`Shopee partner empty data (${path})`);
	return env.data;
}

function partnerState(): string {
	const params = new URLSearchParams({
		business_next: shopeeUrl(PARTNER_BASE_URL, EP.PARTNER_LOGIN_AUTH),
		business_state: PARTNER_BASE_URL,
		business_client_id: BUSINESS_CLIENT_ID,
	});
	return `${PARTNER_BASE_URL}/?${params.toString()}`;
}

function loginReferer(businessNext: string): string {
	const u = new URL(shopeeUrl(AccountBaseURL, "/authenticate/login/"));
	u.searchParams.set("lang", DEFAULT_LANGUAGE);
	u.searchParams.set("should_hide_back", "true");
	u.searchParams.set("state", partnerState());
	u.searchParams.set("client_id", ACCOUNT_CLIENT_ID);
	u.searchParams.set("next", shopeeUrl(PARTNER_BASE_URL, EP.ACCOUNT_LOGIN));
	return u.toString();
}

function accountHeaders(jar: CookieJar, riskToken: string): Record<string, string> {
	const h: Record<string, string> = {
		Origin: AccountBaseURL,
		Referer: loginReferer(shopeeUrl(PARTNER_BASE_URL, EP.PARTNER_LOGIN_AUTH)),
		"X-App-Type": "2",
		"Sec-Fetch-Dest": "empty",
		"Sec-Fetch-Mode": "cors",
		"Sec-Fetch-Site": "same-origin",
		Priority: "u=0",
	};
	const csrf = jar.get("csrftoken", AccountBaseURL);
	if (riskToken) {
		h["af-ac-enc-sz-token"] = riskToken;
		h["x-sz-sdk-version"] = "1.12.26-user.1";
	}
	if (csrf) h["X-CSRFToken"] = csrf;
	return h;
}

function partnerHeaders(opts: { token?: string; tocNonce?: string }): Record<string, string> {
	const h: Record<string, string> = {
		Origin: PARTNER_BASE_URL,
		Referer: `${PARTNER_BASE_URL}/`,
		"X-Merchant-ToB-Clientid": "undefined",
		"X-Merchant-Login-From": PARTNER_LOGIN_FROM,
		"X-Merchant-From": PARTNER_LOGIN_FROM,
		"X-Merchant-Language": DEFAULT_LANGUAGE,
		"X-Merchant-Timezone": DEFAULT_TIMEZONE,
		"X-Merchant-RequestId": crypto.randomUUID(),
		"shopee-baggage": "PFB=undefined",
	};
	if (opts.token) h["X-Merchant-Token"] = opts.token;
	if (opts.tocNonce) h["X-Merchant-ToC-Nonce"] = opts.tocNonce;
	return h;
}

/** value helpers */
function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	return 0;
}
function bool(v: unknown): boolean {
	return typeof v === "boolean" ? v : false;
}
function intoMap(v: unknown): Record<string, unknown> {
	return v != null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

function normalizeMerchants(detected: Record<string, unknown>): MerchantSummary[] {
	const selectMerchant = intoMap(detected["selectMerchant"]);
	const list = Array.isArray(selectMerchant["merchantList"])
		? selectMerchant["merchantList"]
		: [];
	const out: MerchantSummary[] = [];
	for (const raw of list) {
		const m = intoMap(raw);
		const merchantId = num(m["merchantId"]);
		const staffUserId = num(m["staffTobUid"]);
		if (!merchantId || !staffUserId) continue;
		out.push({
			id: String(merchantId),
			name: str(m["merchantName"]),
			status: num(m["merchantStatus"]),
			staffUserId,
			staffRole: num(m["staffRole"]),
			staffStatus: num(m["staffStatus"]),
			isActive: bool(m["isActive"]),
			isBanned: bool(m["isBanned"]),
			isCurrentLoginUser: bool(m["isCurrentLoginUser"]),
		});
	}
	return out;
}

function usableMerchants(merchants: MerchantSummary[]): MerchantSummary[] {
	return merchants.filter((m) => m.isActive && !m.isBanned);
}

function selectMerchant(merchants: MerchantSummary[], requestedId: string): MerchantSummary {
	if (requestedId) {
		const hit = merchants.find((m) => m.id === requestedId);
		if (hit) return hit;
		throw new AuthGatewayError(
			`Configured Shopee merchantId not accessible: ${requestedId} (available: ${merchants.map((m) => `${m.id}:${m.name}`).join(", ")})`,
		);
	}
	const usable = usableMerchants(merchants);
	const current = usable.filter((m) => m.isCurrentLoginUser);
	if (current.length === 1) return current[0];
	if (usable.length === 1) return usable[0];
	throw new AuthGatewayError(
		`merchantId required — ${usable.length} usable Shopee merchants`,
	);
}

/**
 * ShopeeAuthClient — mint a merchant session via the private OTP flow.
 * Stateless: each method spawns its own jar; the final session contains the
 * cookies + merchant token for later payment-service restore.
 */
export class ShopeeAuthClient {
	private readonly http: HttpClient;
	private readonly locale: { language: string; timezone: string };

	constructor(opts: { locale?: { language?: string; timezone?: string } } = {}) {
		this.http = new HttpClient();
		this.locale = {
			language: defaultString(opts.locale?.language, DEFAULT_LANGUAGE),
			timezone: defaultString(opts.locale?.timezone, DEFAULT_TIMEZONE),
		};
	}

	jar(): CookieJar {
		return this.http.jar;
	}

	private async accountRequest(
		path: string,
		body: Record<string, unknown>,
		riskToken: string,
	): Promise<Record<string, unknown>> {
		const env = await this.http.json<AccountEnvelope>(
			"POST",
			shopeeUrl(AccountBaseURL, path),
			accountHeaders(this.http.jar, riskToken),
			body,
		);
		return requireAccountData(env, path);
	}

	private async bootstrap(): Promise<void> {
		// Login page must be requested with text/html Accept so the gateway
		// issues anonymous SPC_* session cookies.
		await this.http.followGet(`${AccountBaseURL}/login`, { Accept: "text/html" });
	}

	private async acquireDeviceFingerprint(_deviceReport?: string): Promise<string> {
		// Device-risk telemetry requires a real-browser blob we don't have
		// server-side; the endpoint still returns a risk token for a baseline
		// JSON probe. ponytail: pass through a captured deviceReport when an
		// admin supplies one; ceiling = send the blob verbatim as text/plain.
		const resp = await this.http.json<{
			code: number;
			msg: string;
			data: { riskToken?: string };
		}>("POST", DEVICE_FINGERPRINT_URL, {
			Origin: AccountBaseURL,
			Referer: `${AccountBaseURL}/`,
		}, {});
		if (resp.code !== 0 || !resp.data?.riskToken) {
			throw new AuthGatewayError("Shopee device-risk service returned no risk token");
		}
		return resp.data.riskToken;
	}

	/**
	 * RequestOtp — triggers an OTP for a phone number.
	 * Returns a challenge the caller keeps until VerifyOtp.
	 */
	async requestOtp(phoneNumber: string, opts: OtpRequestOptions = {}): Promise<OtpChallenge> {
		this.http.jar.clear();
		await this.bootstrap();
		const riskToken = await this.acquireDeviceFingerprint();

		// Password migration check.
		await this.accountRequest(EP.CHECK_PASSWORD_MIGRATION, { phone: phoneNumber }, riskToken);

		// Get OTP settings.
		const settings = await this.accountRequest(
			EP.OTP_SETTINGS,
			{
				operation: OTP_OPERATION,
				phone: phoneNumber,
				security_device_fingerprint: riskToken,
				support_session: false,
				supported_channels: [1, 2, 3, 5],
			},
			riskToken,
		);

		const availableChannels = (
			Array.isArray(settings["available_channel_list"])
				? settings["available_channel_list"]
				: []
		).map((v) => num(v)).filter((n) => n > 0);

		const hasPassword = bool(intoMap(settings["toc_account"])["has_password"])
			|| num(settings["has_password"]) === 1;

		let channel = opts.channel ?? (num(settings["default_channel"]) || DEFAULT_OTP_CHANNEL);
		if (availableChannels.length > 0 && !availableChannels.includes(channel)) {
			channel = availableChannels[0];
		}

		// Send OTP.
		await this.accountRequest(
			EP.SEND_OTP,
			{
				operation: OTP_OPERATION,
				phone: phoneNumber,
				security_device_fingerprint: riskToken,
				support_session: false,
				supported_channels: [1, 2, 3, 5, 4],
				channel,
				captcha_signature: "",
			},
			riskToken,
		);

		return {
			version: 1,
			phoneNumber,
			channel,
			availableChannels,
			deviceFingerprint: riskToken,
			riskToken,
			hasPassword,
			cookies: this.http.jar.snapshot(),
			requestedAt: Date.now(),
		};
	}

	/**
	 * VerifyOtp — submit the SMS/whatsapp OTP, returning merchant-list state.
	 */
	async verifyOtp(challenge: OtpChallenge, otp: string): Promise<OtpVerification> {
		if (challenge.version !== 1) throw new AuthGatewayError("Unsupported challenge version");
		if (!/^\d{4,10}$/.test(otp)) throw new AuthGatewayError("Shopee OTP must be 4-10 digits");

		this.http.jar.restore(challenge.cookies);

		const verified = await this.accountRequest(
			EP.VERIFY_OTP,
			{
				operation: OTP_OPERATION,
				otp,
				phone: challenge.phoneNumber,
				security_device_fingerprint: challenge.deviceFingerprint,
				support_session: false,
			},
			challenge.riskToken || challenge.deviceFingerprint,
		);
		const otpToken = str(verified["otp_token"]);
		if (!otpToken) throw new AuthGatewayError("Shopee OTP verification returned no token");

		const authenticated = await this.accountRequest(
			EP.AUTHENTICATE_BY_OTP,
			{
				otp_token: otpToken,
				security_device_fingerprint: challenge.deviceFingerprint,
				is_signup: false,
			},
			challenge.riskToken || challenge.deviceFingerprint,
		);

		const tocNonce = str(authenticated["toc_nonce"]);
		const tocAccount = intoMap(authenticated["toc_account"]);
		const tocUserId = num(tocAccount.userid);
		if (!tocNonce || !tocUserId) {
			throw new AuthGatewayError("Shopee OTP auth incomplete account session");
		}

		const spcClientId = this.http.jar.get(CLIENT_ID_COOKIE, AccountBaseURL);
		if (!spcClientId) throw new AuthGatewayError("Shopee auth returned no client session id");

		// Account login redirect.
		const accountLoginUrl = new URL(shopeeUrl(PARTNER_BASE_URL, EP.ACCOUNT_LOGIN));
		accountLoginUrl.searchParams.set("lang", this.locale.language);
		accountLoginUrl.searchParams.set("spc_clientid", spcClientId);
		accountLoginUrl.searchParams.set("state", partnerState());
		accountLoginUrl.searchParams.set("toc_nonce", tocNonce);
		await this.http.followGet(accountLoginUrl.toString());

		// Merchant detect.
		const detect = await this.http.json<PartnerEnvelope>(
			"POST",
			shopeeUrl(PARTNER_API_BASE_URL, EP.MERCHANT_DETECT),
			partnerHeaders({ tocNonce }),
			{},
		);
		const detected = requirePartnerData(detect, EP.MERCHANT_DETECT);
		const merchants = normalizeMerchants(detected);
		if (merchants.length === 0) {
			throw new AuthGatewayError("The Shopee account has no accessible merchant");
		}

		return {
			version: 1,
			tocNonce,
			tocUserId,
			spcClientId,
			deviceFingerprint: challenge.deviceFingerprint,
			cookies: this.http.jar.snapshot(),
			merchants,
			verifiedAt: Date.now(),
		};
	}

	/**
	 * CompleteLogin — exchange verified OTP state for a merchant session.
	 */
	async completeLogin(
		verification: OtpVerification,
		merchantId?: string,
	): Promise<Session> {
		if (verification.version !== 1) throw new AuthGatewayError("Unsupported verification version");
		this.http.jar.restore(verification.cookies);

		const merchant = selectMerchant(verification.merchants, merchantId ?? "");
		if (!merchant.isActive || merchant.isBanned) {
			throw new AuthGatewayError("Selected Shopee merchant is inactive or banned");
		}

		// Token page redirect.
		const tokenPage = new URL(shopeeUrl(AccountBaseURL, EP.ACCOUNT_LOGIN_TOKEN));
		tokenPage.searchParams.set("lang", this.locale.language);
		tokenPage.searchParams.set("spc_clientid", verification.spcClientId);
		tokenPage.searchParams.set("state", partnerState());
		tokenPage.searchParams.set("tob_userid", String(merchant.staffUserId));
		tokenPage.searchParams.set("next", shopeeUrl(PARTNER_BASE_URL, EP.ACCOUNT_TOB_AUTH));
		tokenPage.searchParams.set("client_id", ACCOUNT_CLIENT_ID);
		tokenPage.searchParams.set("toc_nonce", verification.tocNonce);
		await this.http.followGet(tokenPage.toString());

		// Login TOC → auth code.
		const loginData = await this.accountRequest(
			EP.LOGIN_TOC,
			{
				toc_nonce: verification.tocNonce,
				tob_userid: merchant.staffUserId,
				security_device_fingerprint: verification.deviceFingerprint,
			},
			verification.deviceFingerprint,
		);
		const nonce = str(loginData["nonce"]);
		if (!nonce) throw new AuthGatewayError("Shopee merchant login returned no auth code");

		// Exchange redirect → final session token.
		const exchange = new URL(shopeeUrl(PARTNER_BASE_URL, EP.ACCOUNT_TOB_AUTH));
		exchange.searchParams.set("code", nonce);
		exchange.searchParams.set("lang", this.locale.language);
		exchange.searchParams.set("spc_clientid", verification.spcClientId);
		exchange.searchParams.set("state", partnerState());
		await this.http.followGet(exchange.toString());

		const liveCookie = this.http.jar.get(
			"__shopee_partner_website_x_token_live",
			PARTNER_BASE_URL,
		);
		const credential = readMerchantCredential(liveCookie);
		if (!credential) {
			throw new AuthGatewayError("Shopee token exchange returned no merchant session");
		}

		return {
			version: 1,
			cookies: this.http.jar.snapshot(),
			accountId: credential.accountId,
			merchant,
			merchants: verification.merchants,
			stores: [] as Store[],
			storeId: undefined,
			createdAt: Date.now(),
			expiresAt: credential.expiresAt,
			switchCredential: {
				tocNonce: verification.tocNonce,
				spcClientId: verification.spcClientId,
				deviceFingerprint: verification.deviceFingerprint,
			} as SwitchCredential,
		};
	}
}

function parseSetCookie(headers: string[]): Array<{
	name: string;
	value: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	expires?: number;
}> {
	const out: Array<{
		name: string;
		value: string;
		domain?: string;
		path?: string;
		secure?: boolean;
		httpOnly?: boolean;
		expires?: number;
	}> = [];
	for (const h of headers) {
		const parts = h.split(";").map((s) => s.trim());
		if (!parts[0]) continue;
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