/**
 * GoPay token lifecycle — ported from paygateme/gopay/token.go.
 *
 * TokenManager: proactive pre-expiry refresh, 401-forced refresh, and
 * concurrent-call deduplication (single in-flight refresh).
 * Pure logic + injectable refresher — offline-testable.
 */

import { DEFAULT_REFRESH_BEFORE_EXPIRY_MS } from "./constants";

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	tokenType: string;
	/** epoch ms; 0 = unknown. */
	expiresAt: number;
}

export interface TokenRefresher {
	/** Obtain a fresh token set from a refresh token. Throws on rejection. */
	refresh(refreshToken: string): Promise<TokenSet>;
}

export interface TokenManagerConfig {
	/** Invoked after a successful refresh, BEFORE adoption. Must not throw. */
	onTokenRefreshed?: (tokens: TokenSet) => void | Promise<void>;
	/** Refresh tokens this many ms before expiry. Default: 5 minutes. */
	refreshBeforeExpiryMs?: number;
}

export class TokenManager {
	private tokens: TokenSet;
	private expiresAt: number;
	private buffer: number;
	private inflight: Promise<TokenSet> | null = null;

	constructor(
		private readonly refresher: TokenRefresher,
		initial: TokenSet,
		private readonly config: TokenManagerConfig = {},
	) {
		this.tokens = initial;
		this.buffer = config.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
		this.expiresAt = calculateExpiry(initial);
	}

	accessToken(): string {
		return this.tokens.accessToken;
	}

	/** Current token set with populated expiry. */
	getTokens(): TokenSet {
		return { ...this.tokens, expiresAt: this.expiresAt };
	}

	/** Local belief that the token is live (expiry not passed). */
	authenticated(): boolean {
		return this.expiresAt > Date.now();
	}

	/**
	 * GetValidAccessToken — returns a valid token, refreshing when within the
	 * pre-expiry buffer. Concurrent callers share one in-flight refresh.
	 */
	async getValidAccessToken(): Promise<string> {
		if (Date.now() < this.expiresAt - this.buffer) {
			return this.tokens.accessToken;
		}
		const tokens = await this.refreshOnce();
		return tokens.accessToken;
	}

	/**
	 * ForceRefresh — unconditional refresh. A server-side 401 contradicts the
	 * local expiry estimate, so callers MUST use this there.
	 */
	async forceRefresh(): Promise<TokenSet> {
		return this.refreshOnce();
	}

	/** Collapse concurrent callers onto a single in-flight refresh. */
	private refreshOnce(): Promise<TokenSet> {
		if (this.inflight) return this.inflight;
		this.inflight = this.performRefresh().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async performRefresh(): Promise<TokenSet> {
		const previous = this.tokens.refreshToken;
		const refreshed = await this.refresher.refresh(previous);
		// Adopt a rotated refresh token when supplied; fall back to current.
		const candidate: TokenSet = {
			accessToken: refreshed.accessToken,
			refreshToken: refreshed.refreshToken || previous,
			tokenType: refreshed.tokenType || "Bearer",
			expiresAt: calculateExpiry(refreshed),
		};
		// Persistence callback must succeed BEFORE adoption.
		if (this.config.onTokenRefreshed) {
			await this.config.onTokenRefreshed(candidate);
		}
		this.tokens = candidate;
		this.expiresAt = candidate.expiresAt;
		return candidate;
	}
}

/**
 * calculateExpiry — three strategies:
 * 1. explicit expiresAt from the auth response;
 * 2. the JWT `exp` claim;
 * 3. fallback of 30 minutes.
 */
export function calculateExpiry(tokens: TokenSet): number {
	if (tokens.expiresAt > 0) return tokens.expiresAt;
	const exp = parseJWTExp(tokens.accessToken);
	if (exp > 0) return exp * 1000;
	return Date.now() + 30 * 60 * 1000;
}

/** parseJWTExp — extract the `exp` claim (seconds) from a JWT access token. */
export function parseJWTExp(accessToken: string): number {
	const parts = accessToken.split(".");
	if (parts.length < 2 || parts[1] === "") return 0;
	let seg = parts[1].replaceAll("-", "+").replaceAll("_", "/");
	const pad = seg.length % 4;
	if (pad !== 0) seg += "=".repeat(4 - pad);
	try {
		const claims = JSON.parse(Buffer.from(seg, "base64").toString("utf-8")) as {
			exp?: number;
		};
		return typeof claims.exp === "number" && Number.isFinite(claims.exp)
			? claims.exp
			: 0;
	} catch {
		return 0;
	}
}
