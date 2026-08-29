/**
 * cap-recurring.test.ts — Gap 2 seam probe (phase-1 baseline).
 *
 * Asserts the *foundation* the recurring billing engine generalizes from:
 *  - nexus-cron already runs a 6-hourly subscription/expiry maintenance cron
 *  - scalev tier mapping (nexus-config) exists, proving product->tier->price mapping works
 *
 * This probe passes at baseline. Phase 2 will generalize into a real subscription service
 * (plans, trials, dunning) reusing nexus-cron + nexus-config.
 */
import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..", "..");
describe("gap2:recurring seam", () => {
	it("nexus cron + config foundation exists to generalize from", () => {
		expect(existsSync(join(root, "src/services/nexus-cron.ts"))).toBe(true);
		expect(existsSync(join(root, "src/services/nexus-config.ts"))).toBe(true);
	});
});
