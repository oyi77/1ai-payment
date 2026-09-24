/**
 * Gateway-name safety test (Sweep153).
 *
 * The dashboard concatenates gateway names raw into element ids, onclick
 * handlers and attribute values, guarded by an allowlist
 * (/^[a-z0-9_]+$/, dashboard index.html loadGateways). This pins the
 * server side of that contract: every registered gateway name passes the
 * allowlist, so the guard never hides a legitimate gateway - and any
 * future rogue name fails closed (hidden) instead of becoming stored XSS.
 */
import { describe, expect, test } from "bun:test";
import { getGatewayNames } from "../../src/gateways";

const DASHBOARD_ALLOWLIST = /^[a-z0-9_]+$/;

describe("gateway names (Sweep153 dashboard contract)", () => {
	test("every registered name passes the dashboard allowlist", () => {
		const names = getGatewayNames();
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(DASHBOARD_ALLOWLIST.test(name)).toBe(true);
		}
	});

	test("rogue names fail the allowlist (guard hides them)", () => {
		const rogues = [
			"x' onclick='alert(1)",
			"a<b",
			"a;b",
			"A-B",
			"",
		];
		for (const rogue of rogues) {
			expect(DASHBOARD_ALLOWLIST.test(rogue)).toBe(false);
		}
	});
});
