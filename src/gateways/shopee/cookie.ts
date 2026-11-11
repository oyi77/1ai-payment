/**
 * Shopee cookie jar — ported from paygateme/shopee/cookie.go.
 *
 * Minimal RFC 6265 jar sufficient for Shopee's server-side login flow.
 * Pure logic — no network — offline-testable.
 * ponytail: no SameSite/Partitioned handling; add if Shopee requires them.
 */

export interface Cookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	/** epoch ms; 0 = session cookie. */
	expires: number;
	hostOnly: boolean;
}

/** isPublicSuffix — reject cookies for TLDs / public suffixes (e.g. "co.id"). */
function isPublicSuffix(domain: string): boolean {
	const ps = new Set([
		"co.id",
		"or.id",
		"go.id",
		"ac.id",
		"net.id",
		"sch.id",
		"web.id",
		"my.id",
		"com",
		"org",
		"net",
		"io",
		"dev",
	]);
	if (ps.has(domain)) return true;
	// Reject single-label domains (bare TLD).
	return !domain.includes(".");
}

function canonicalHost(host: string): string {
	return host.split(":")[0].toLowerCase();
}

function domainMatch(host: string, domain: string): boolean {
	host = host.toLowerCase().replace(/^\./, "");
	domain = domain.toLowerCase().replace(/^\./, "");
	if (host === domain) return true;
	return host.endsWith(`.${domain}`);
}

function pathMatch(requestPath: string, cookiePath: string): boolean {
	if (cookiePath === "" || cookiePath === "/") return true;
	if (requestPath === cookiePath) return true;
	if (requestPath.startsWith(cookiePath)) {
		if (cookiePath.endsWith("/")) return true;
		if (requestPath.length > cookiePath.length && requestPath[cookiePath.length] === "/")
			return true;
	}
	return false;
}

function defaultPath(requestPath: string): string {
	if (!requestPath.startsWith("/") || requestPath === "/") return "/";
	const lastSlash = requestPath.lastIndexOf("/");
	if (lastSlash <= 0) return "/";
	return requestPath.slice(0, lastSlash);
}

/** Serialize a Set-Cookie-style header into a Cookie record (best-effort). */
function normalizeCookie(
	setCookie: {
		name: string;
		value: string;
		domain?: string;
		path?: string;
		secure?: boolean;
		httpOnly?: boolean;
		expires?: number;
	},
	requestUrl: URL,
): Cookie | null {
	const domain = (setCookie.domain ?? requestUrl.hostname)
		.toLowerCase()
		.replace(/^\./, "");
	if (isPublicSuffix(domain)) return null;

	const path = setCookie.path ?? defaultPath(requestUrl.pathname);
	const expires = setCookie.expires ?? 0;

	return {
		name: setCookie.name,
		value: setCookie.value,
		domain,
		path,
		secure: setCookie.secure ?? false,
		httpOnly: setCookie.httpOnly ?? false,
		expires,
		hostOnly: setCookie.domain === undefined,
	};
}

/**
 * CookieJar — minimal in-memory cookie store for the Shopee login flow.
 * Serializes to/from a snapshot for session persistence.
 */
export class CookieJar {
	private cookies: Cookie[] = [];

	/** Store cookies returned by a response for the given URL. */
	setCookies(
		url: string,
		cookies: Array<{
			name: string;
			value: string;
			domain?: string;
			path?: string;
			secure?: boolean;
			httpOnly?: boolean;
			expires?: number;
		}>,
	): void {
		const requestUrl = new URL(url);
		for (const c of cookies) {
			const normalized = normalizeCookie(c, requestUrl);
			if (!normalized) continue;
			// RFC 6265: same (name, domain, path) replaces existing.
			this.cookies = this.cookies.filter(
				(x) =>
					x.name !== normalized.name ||
					x.domain !== normalized.domain ||
					x.path !== normalized.path,
			);
			this.cookies.push(normalized);
		}
	}

	/** Return cookies matching the URL (respecting expiry, secure, domain, path). */
	getCookies(url: string): Cookie[] {
		const requestUrl = new URL(url);
		const host = canonicalHost(requestUrl.host);
		const now = Date.now();
		const out: Cookie[] = [];
		for (const c of this.cookies) {
			if (c.expires > 0 && c.expires <= now) continue;
			if (c.secure && requestUrl.protocol !== "https:") continue;
			if (!domainMatch(host, c.domain)) continue;
			if (!pathMatch(requestUrl.pathname, c.path)) continue;
			out.push(c);
		}
		return out;
	}

	/** Cookie value by name for the URL, or empty string. */
	get(name: string, url: string): string {
		return this.getCookies(url).find((c) => c.name === name)?.value ?? "";
	}

	/** Snapshot — serializable cookie list for session persistence. */
	snapshot(): Cookie[] {
		return [...this.cookies];
	}

	/** Restore — replace contents from a snapshot. */
	restore(cookies: Cookie[]): void {
		this.cookies = cookies.map((c) => ({ ...c }));
	}

	/** Clear all cookies. */
	clear(): void {
		this.cookies = [];
	}
}
