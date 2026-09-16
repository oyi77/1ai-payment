/**
 * Merchant-key webhook verification proof.
 *
 * Closes the verify-side gap: createPayment already resolved per-merchant
 * credentials, but verifySignature ignored opts.merchantId — the webhook
 * merchant-key fallback in src/routes/webhook.ts could never match.
 * These tests prove a signature made with the STORED merchant key verifies
 * via opts.merchantId while the platform key does not (and vice versa).
 *
 * Covers one gateway per verify shape:
 * - midtrans: parsed-field hash (SHA-512 over fields + key)
 * - xendit: header token compare
 * - tripay: raw-body HMAC (verifySignatureRaw)
 * Other gateways share the identical resolveGatewayConfig shape.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import crypto from "node:crypto";
import { sha256Hash } from "../../src/utils/crypto";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-merchant-verify-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-mverify";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-mverify";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
// Platform keys — deliberately different from stored merchant keys
process.env.MIDTRANS_SERVER_KEY = "platform-mt-key";
process.env.XENDIT_CALLBACK_TOKEN = "platform-xe-token";
process.env.TRIPAY_PRIVATE_KEY = "platform-tp-priv";
resetConfigCache();

import { initDatabase, getDb } from "../../src/config/database";
import type { Client } from "@libsql/client";
import { MidtransGateway } from "../../src/gateways/midtrans";
import { XenditGateway } from "../../src/gateways/xendit";
import { TripayGateway } from "../../src/gateways/tripay";

let db: Client;

async function seedMerchantCreds(
	merchantId: string,
	gateway: string,
	creds: Record<string, string>,
) {
	const { encrypt } = await import("../../src/utils/crypto");
	const enc = encrypt(JSON.stringify(creds));
	await db.execute({
		sql: `INSERT INTO merchant_gateways (id, merchant_id, gateway, credentials, environment, enabled)
		      VALUES (?, ?, ?, ?, ?, 1)
		      ON CONFLICT(merchant_id, gateway) DO UPDATE SET credentials = ?, environment = ?, enabled = 1, updated_at = datetime('now')`,
		args: [`mgw_mv_${gateway}`, merchantId, gateway, enc, "sandbox", enc, "sandbox"],
	});
}

beforeAll(async () => {
	await initDatabase();
	db = getDb();
	await db.execute({
		sql: "INSERT INTO merchants (id, name, api_key_hash, webhook_secret) VALUES (?, ?, ?, ?)",
		args: ["merch_mv", "MV Merchant", sha256Hash("mv-key"), "sec_mv"],
	});
	await seedMerchantCreds("merch_mv", "midtrans", { apiKey: "merchant-mt-key" });
	await seedMerchantCreds("merch_mv", "xendit", { callbackToken: "merchant-xe-token" });
	await seedMerchantCreds("merch_mv", "tripay", { privateKey: "merchant-tp-priv" });
});

afterAll(() => {
	try {
		db.close();
		rmSync(TEST_DB);
	} catch {}
});

function midtransPayload(key: string) {
	const body = {
		order_id: "pay_mv1",
		status_code: "200",
		gross_amount: "50000",
		signature_key: "",
		transaction_status: "settlement",
		payment_type: "qris",
		transaction_time: "2026-09-16T00:00:00Z",
	};
	const sig = crypto
		.createHash("sha512")
		.update(`${body.order_id}${body.status_code}${body.gross_amount}${key}`)
		.digest("hex");
	return { ...body, signature_key: sig };
}

describe("merchant-key webhook verification", () => {
	test("midtrans: merchant-key signature verifies via opts, platform path rejects it", async () => {
		const gw = new MidtransGateway();
		expect(await gw.verifySignature(midtransPayload("merchant-mt-key"), {}, { merchantId: "merch_mv" })).toBe(true);
		// Same payload against platform key must fail (keys differ)
		expect(await gw.verifySignature(midtransPayload("merchant-mt-key"), {})).toBe(false);
		// Platform-key signature still verifies on the platform path
		expect(await gw.verifySignature(midtransPayload("platform-mt-key"), {})).toBe(true);
	});

	test("xendit: merchant callback token verifies via opts, platform path rejects it", async () => {
		const gw = new XenditGateway();
		const body = { id: "inv_mv", external_id: "pay_mv2", status: "PAID", amount: 50000 };
		expect(
			await gw.verifySignature(body, { "x-callback-token": "merchant-xe-token" }, { merchantId: "merch_mv" }),
		).toBe(true);
		expect(await gw.verifySignature(body, { "x-callback-token": "merchant-xe-token" })).toBe(false);
		expect(
			await gw.verifySignature(body, { "x-callback-token": "platform-xe-token" }),
		).toBe(true);
	});

	test("tripay raw: merchant HMAC verifies via opts, platform path rejects it", async () => {
		const gw = new TripayGateway();
		const rawBody = JSON.stringify({ merchant_ref: "pay_mv3", status: "PAID" });
		const merchantSig = crypto.createHmac("sha256", "merchant-tp-priv").update(rawBody).digest("hex");
		const platformSig = crypto.createHmac("sha256", "platform-tp-priv").update(rawBody).digest("hex");
		const mHeaders = { "x-signature": merchantSig };
		const pHeaders = { "x-signature": platformSig };
		expect(await gw.verifySignatureRaw(rawBody, mHeaders, { merchantId: "merch_mv" })).toBe(true);
		expect(await gw.verifySignatureRaw(rawBody, mHeaders)).toBe(false);
		expect(await gw.verifySignatureRaw(rawBody, pHeaders)).toBe(true);
	});
});
