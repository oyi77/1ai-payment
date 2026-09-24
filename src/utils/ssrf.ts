/**
 * SSRF guard for server-side fetches to merchant-controlled URLs.
 *
 * Threat: `callback_url` is merchant input; the forwarder POSTs payment
 * events to it. Without validation it reaches cloud metadata
 * (169.254.169.254), localhost admin ports, and intranet hosts — with
 * payment data in the body.
 *
 * Two layers:
 * 1. `isPublicHostname` — sync check for literal IPs (incl. decimal/octal/
 *    hex forms attackers use to dodge string filters). Used in Zod refine
 *    for fast 400s at creation time.
 * 2. `fetchPublic` — resolves DNS per attempt, rejects private ranges,
 *    and follows redirects MANUALLY (max 3) validating each hop. Undici
 *    follows redirects by default, so a public initial URL 302ing to
 *    169.254.169.254 would bypass a create-time-only check.
 *
 * Residual: DNS-rebinding TOCTOU (record changes between lookup and
 * connect). Mitigated to a millisecond race window; documented, accepted.
 */
import dns from "node:dns";
import net from "node:net";

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let n = 0;
	for (const part of parts) {
		// Leading-zero octets ("0177") and hex ("0x7f") are parser-dependent:
		// some stacks read octal, others decimal. Only the exact string "0"
		// may carry a leading zero; anything else ambiguous is rejected by
		// the caller (null here must ALSO fail closed downstream).
		if (!/^([0-9]|[1-9][0-9]*|0[xX][0-9a-fA-F]+)$/.test(part)) return null;
		const v =
			part.startsWith("0x") || part.startsWith("0X")
				? Number.parseInt(part, 16)
				: Number.parseInt(part, 10);
		if (!Number.isInteger(v) || v < 0 || v > 255) return null;
		n = n * 256 + v;
	}
	return n >>> 0;
}

function parseNumericHostname(host: string): number | null {
	// All-digits decimal (http://2130706433/ == 127.0.0.1)
	if (/^[0-9]+$/.test(host)) {
		const n = Number(host);
		if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) return n >>> 0;
		return null;
	}
	return ipv4ToInt(host);
}

/** True when an IPv4 int or IPv6 string is loopback/private/link-local/reserved. */
export function isPrivateIP(ip: string): boolean {
	if (net.isIP(ip) === 4) {
		const n = ipv4ToInt(ip);
		if (n === null) return true; // unparseable literal — treat as hostile
		const first = n >>> 24;
		const second = (n >>> 16) & 0xff;
		return (
			first === 10 || // 10.0.0.0/8
			(first === 172 && second >= 16 && second <= 31) || // 172.16.0.0/12
			(first === 192 && second === 168) || // 192.168.0.0/16
			first === 127 || // 127.0.0.0/8 loopback
			first === 0 || // 0.0.0.0/8 (current network)
			(first === 169 && second === 254) || // 169.254.0.0/16 link-local + cloud metadata
			first >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
		);
	}
	if (net.isIP(ip) === 6) {
		const low = ip.toLowerCase();
		if (low === "::1" || low === "::") return true; // loopback / unspecified
		const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return isPrivateIP(mapped[1]); // v4-mapped — unwrap
		const firstHextet = Number.parseInt(low.split(":")[0] || "0", 16);
		if (!Number.isInteger(firstHextet)) return true; // unparseable — hostile
		if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
		if ((firstHextet & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still reserved)
		if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
		return false;
	}
	return true; // not an IP at all — caller must resolve via DNS
}

/**
 * Sync hostname check: catches literal IPs in ANY numeric form without DNS.
 * Returns false for regular hostnames (DNS check still required at fetch).
 */
export function isPublicHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const bare =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bare === "localhost") return false;
	const numeric = parseNumericHostname(bare);
	if (numeric !== null) {
		const dotted = `${numeric >>> 24}.${(numeric >>> 16) & 0xff}.${(numeric >>> 8) & 0xff}.${numeric & 0xff}`;
		return !isPrivateIP(dotted);
	}
	if (
		net.isIP(bare) === 0 &&
		parseNumericHostname(bare) === null &&
		/^[0-9a-fA-FxXoObB.]+$/.test(bare) &&
		/[0-9]/.test(bare)
	) {
		// Only hex/octal/binary digits and dots, yet not a valid IP —
		// an ambiguous numeric form (0177.0.0.1, 0x7f.0.0.1 with bad octet,
		// 1.2.3.4.5). Hostnames containing g-z, hyphens, or other letters
		// pass through to DNS validation. Reject the ambiguous.
		return false;
	}
	if (net.isIP(bare) !== 0) {
		// v4-mapped v6 needs unwrapping: ::ffff:127.0.0.1
		const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) return !isPrivateIP(mapped[1]);
		return !isPrivateIP(bare);
	}
	return true; // regular hostname — must still pass DNS check at fetch time
}

/** Resolve a hostname and verify EVERY returned address is public. */
export async function resolveHostnamePublic(
	hostname: string,
): Promise<{ ok: boolean; reason?: string }> {
	if (!isPublicHostname(hostname)) {
		return { ok: false, reason: `blocked literal host: ${hostname}` };
	}
	let addresses: Array<{ address: string }>;
	try {
		addresses = await dns.promises.lookup(hostname, { all: true });
	} catch {
		// Unresolvable: let the fetch attempt proceed — it will fail
		// naturally (retry → dead letter). Failing closed here would turn
		// transient resolver outages into silent forward drops.
		return { ok: true };
	}
	for (const { address } of addresses) {
		const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		const check = mapped ? mapped[1] : address;
		if (isPrivateIP(check)) {
			return { ok: false, reason: `resolves to private IP: ${address}` };
		}
	}
	return { ok: true };
}

export interface GuardedFetchResult {
	blocked: boolean;
	reason?: string;
	response?: Response;
}

/**
 * fetch() with per-hop SSRF validation. Follows redirects manually (undici
 * auto-follow would skip validation on hop 2+). Relative Location headers
 * resolve against the current URL.
 */
export async function fetchPublic(
	url: string,
	init?: RequestInit,
	maxRedirects = 3,
): Promise<GuardedFetchResult> {
	let current = url;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		let parsed: URL;
		try {
			parsed = new URL(current);
		} catch {
			return { blocked: true, reason: `invalid URL: ${current}` };
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { blocked: true, reason: `blocked scheme: ${parsed.protocol}` };
		}
		const check = await resolveHostnamePublic(parsed.hostname);
		if (!check.ok) return { blocked: true, reason: check.reason };
		const response = await fetch(current, { ...init, redirect: "manual" });
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			if (hop === maxRedirects) {
				await response.body?.cancel().catch(() => {});
				return { blocked: true, reason: "too many redirects" };
			}
			const next = new URL(location, current).toString();
			await response.body?.cancel().catch(() => {});
			current = next;
			continue;
		}
		return { blocked: false, response };
	}
	return { blocked: true, reason: "too many redirects" };
}
