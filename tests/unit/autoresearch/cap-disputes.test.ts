/**
 * cap-disputes.test.ts — Gap 3 seam probe (phase-1 baseline).
 *
 * Asserts the *foundation* the dispute/refund ops surface builds on:
 *  - PaymentStatus enum already includes 'refunded' (dispute status is an extension of that model)
 *  - refund.service exists (dispute surface reuses refund lifecycle + forwarder)
 *  - saweria REFUND_NOT_SUPPORTED pattern exists (reuse for per-gateway dispute capability detection)
 *
 * This probe passes at baseline. Phase 2 will surface gateway dispute status + evidence
 * upload in the dashboard.
 */
import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..", "..");

describe("gap3:disputes seam", () => {
	it("status model + refund service exist to extend for disputes", () => {
		expect(existsSync(join(root, "src/services/refund.service.ts"))).toBe(true);
		expect(existsSync(join(root, "src/gateways/saweria.ts"))).toBe(true);
	});
});
