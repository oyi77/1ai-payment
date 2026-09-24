/**
 * SSRF guard tests (Sweep77).
 *
 * callback_url is merchant input; the forwarder POSTs payment events to it.
 * Layer 1 (schema): https-only + literal private hosts rejected in ANY
 * numeric form. Layer 2 (fetchPublic): DNS + redirect-hop validation.
 */
import { describe, expect, test } from "bun:test";
import {
	fetchPublic,
	isPrivateIP,
	isPublicHostname,
	resolveHostnamePublic,
} from "../../src/utils/ssrf";
import { callbackUrlSchema } from "../../src/schemas";

describe("isPrivateIP", () => {
	test("flags RFC1918, loopback, link-local, metadata, multicast", () => {
		for (const ip of [
			"10.0.0.1",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"127.0.0.1",
			"0.0.0.0",
			"169.254.169.254",
			"224.0.0.1",
			"::1",
			"::",
			"fe80::1",
			"fc00::1",
			"fd00::1",
			"::ffff:127.0.0.1",
		]) {
			expect(isPrivateIP(ip)).toBe(true);
		}
	});

	test("passes public v4 and v6", () => {
		for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:db8::1"]) {
			expect(isPrivateIP(ip)).toBe(false);
		}
	});
});

describe("isPublicHostname", () => {
	test("blocks localhost and every numeric dodge", () => {
		for (const h of [
			"localhost",
			"127.0.0.1",
			"2130706433", // 127.0.0.1 decimal
			"0x7f.0.0.1", // hex octet
			"0177.0.0.1", // octal octet
			"169.254.169.254",
			"10.0.0.1",
			"::1",
			"[::1]",
			"::ffff:127.0.0.1",
		]) {
			expect(isPublicHostname(h)).toBe(false);
		}
	});

	test("passes regular hostnames (DNS check happens at fetch)", () => {
		expect(isPublicHostname("example.com")).toBe(true);
		expect(isPublicHostname("8.8.8.8")).toBe(true);
	});
});

describe("callbackUrlSchema", () => {
	test("accepts public https", () => {
		expect(
			callbackUrlSchema.safeParse("https://my-app.com/callback").success,
		).toBe(true);
	});

	test("rejects http, private literals, localhost", () => {
		for (const u of [
			"http://my-app.com/callback",
			"https://127.0.0.1/callback",
			"https://2130706433/callback",
			"https://169.254.169.254/latest/meta-data/",
			"https://localhost:3000/callback",
			"https://10.0.0.5/callback",
			"ftp://my-app.com/callback",
			"not-a-url",
		]) {
			expect(callbackUrlSchema.safeParse(u).success).toBe(false);
		}
	});
});

describe("resolveHostnamePublic + fetchPublic", () => {
	test("blocks literal private host without DNS", async () => {
		const r = await resolveHostnamePublic("127.0.0.1");
		expect(r.ok).toBe(false);
		const f = await fetchPublic("http://127.0.0.1:9/nope", {
			signal: AbortSignal.timeout(5000),
		});
		expect(f.blocked).toBe(true);
	});

	test("blocks non-http schemes", async () => {
		const f = await fetchPublic("file:///etc/passwd");
		expect(f.blocked).toBe(true);
		expect(f.reason).toMatch(/scheme/);
	});
});
