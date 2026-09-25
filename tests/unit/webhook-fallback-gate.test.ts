/**
 * Unit tests for the webhook merchant-key fallback gate.
 *
 * verifyAgainstMerchantKeys retries per-merchant credentials only for
 * gateways whose verify honors opts.merchantId. Platform-credential
 * gateways (paypal, telegram x2, x402, erc8183) verify against platform
 * config only — retrying per merchant repeats the identical check
 * (worst case: N remote PayPal API calls per webhook). Saweria webhooks are
 * 501-disabled at the route head, so it never reaches merchant-key retry.
 */
import { describe, expect, test } from "bun:test";
import { MERCHANT_VERIFY_GATEWAYS } from "../../src/routes/webhook";

describe("MERCHANT_VERIFY_GATEWAYS", () => {
	test("covers exactly the 7 HMAC/token gateways that honor opts.merchantId", () => {
		expect(Object.keys(MERCHANT_VERIFY_GATEWAYS).sort()).toEqual(
			[
				"duitku",
				"ipaymu",
				"midtrans",
				"nowpayments",
				"scalev",
				"tripay",
				"xendit",
			].sort(),
		);
	});

	test("excludes saweria (credential-free reconciliation) and platform-credential gateways", () => {
		for (const g of [
			"saweria",
			"paypal",
			"telegram_stars",
			"telegram_payments",
			"x402",
			"erc8183",
		]) {
			expect(MERCHANT_VERIFY_GATEWAYS[g]).toBeUndefined();
		}
	});
});
