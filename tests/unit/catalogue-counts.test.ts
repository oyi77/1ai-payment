/**
 * Catalogue-number drift guard.
 *
 * The gateway count has been wrong in four places at once before (13 vs 16
 * in the title, trust bar, hero, and docs). These tests fail the moment a
 * human-readable number stops matching the registry, so the fix is a real
 * check rather than another round of find-and-replace.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCatalogueCounts, getGatewayNames } from "../../src/gateways";

const ROOT = join(import.meta.dir, "../..");

function read(rel: string): string {
	return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * Total-catalogue claims: "<n> gateways" where n is the size of the whole
 * catalogue. Deliberately narrow so it does not flag:
 *   - "5 gateways live on platform" (a subset, not the total)
 *   - "x402" / "erc8183" (digits that are part of a gateway name)
 */
function claimedCounts(text: string): number[] {
	const out: number[] = [];
	for (const m of text.matchAll(/(?<![\w-])(\d+)\s+gateways?\b/gi)) {
		// Skip subset phrasing like "5 gateways aktif/live on platform" — the
		// qualifier can sit on either side of the number.
		const around = text.slice(
			Math.max(0, m.index - 40),
			m.index + m[0].length + 40,
		);
		if (/\b(active|aktif|live|on platform|terdaftar|inbound)\b/i.test(around))
			continue;
		out.push(Number(m[1]));
	}
	return out;
}

describe("catalogue counts", () => {
	test("registered count matches the registry", () => {
		expect(getCatalogueCounts().registered).toBe(getGatewayNames().length);
	});

	test("selectable count excludes parked gateways", () => {
		const { registered, selectable } = getCatalogueCounts();
		expect(selectable).toBeLessThanOrEqual(registered);
		expect(selectable).toBeGreaterThan(0);
	});
});

describe("no stale gateway counts in human-facing surfaces", () => {
	// A number in these files must be one of the two true values. Any other
	// value means someone hardcoded a count that no longer holds.
	const { registered, selectable } = getCatalogueCounts();
	const allowed = new Set<number>([registered, selectable]);

	for (const file of ["src/dashboard/index.html", "src/landing/index.html", "llms.txt"]) {
		test(`${file} only states a true gateway count`, () => {
			const counts = claimedCounts(read(file));
			const wrong = counts.filter((n) => !allowed.has(n));
			expect(wrong).toEqual([]);
		});
	}
});

describe("dashboard and landing derive the number instead of hardcoding it", () => {
	test("dashboard hydrates from /health", () => {
		const html = read("src/dashboard/index.html");
		expect(html).toContain("gwCountHero");
		expect(html).toContain("/health");
		expect(html).toContain("selectable");
	});

	test("landing hydrates [data-gw-count] from /health", () => {
		const html = read("src/landing/index.html");
		expect(html).toContain("data-gw-count");
		expect(html).toContain("hydrateGatewayCount");
		expect(html).toContain("selectable");
	});
});
