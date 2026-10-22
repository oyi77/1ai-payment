/**
 * Scalev webhook reality check — payloads captured from production.
 *
 * The fixture below is a verbatim copy of a real Scalev webhook stored in
 * webhook_events (order gp19d-JQcPnnC3r6G3FcG, 2026-08-06). It proves two
 * things the synthetic tests never did:
 *   1. Scalev sends `status: "paid"`, not our normalized "success".
 *   2. Scalev does NOT send an `items` array, so the variant cannot be
 *      recovered from the payload alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-scalev-real-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-scalevreal";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-scalevreal";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
delete process.env.NEXUS_TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.NEXUS_TELEGRAM_CHANNEL_ID;
resetConfigCache();

import type { Client } from "@libsql/client";
import { initDatabase, getDb } from "../../src/config/database";
import { getGateway } from "../../src/gateways";
import { extractVariantFromPayload } from "../../src/services/nexus-config";
import { handleNexusPayment } from "../../src/services/nexus-fulfillment";

/** Verbatim production payload. Do not "improve" it — it is the evidence. */
const REAL_SCALEV_WEBHOOK = {
	id: "019fd841-73e0-705b-9ce9-a61b4ff90676",
	secret_slug: "e2e123456789",
	status: "paid",
	total_amount: 149000,
	currency: "IDR",
	payment_method: "qris",
	paid_at: "2026-08-06T18:07:00+07:00",
	created_at: "2026-08-06T18:06:36+07:00",
	notes: "1ai-payment:gp19d-JQcPnnC3r6G3FcG",
};

let db: Client;

beforeAll(async () => {
	await initDatabase();
	db = getDb();
});

afterAll(() => {
	db.close();
});

describe("real Scalev payload shape", () => {
	test("normalizes status 'paid' to 'success'", () => {
		const gateway = getGateway("scalev");
		expect(gateway).toBeDefined();
		const event = gateway?.normalizeEvent(REAL_SCALEV_WEBHOOK);
		expect(event?.status).toBe("success");
	});

	test("recovers our internal order id from the notes field", () => {
		const gateway = getGateway("scalev");
		const event = gateway?.normalizeEvent(REAL_SCALEV_WEBHOOK);
		expect(event?.order_id).toBe("gp19d-JQcPnnC3r6G3FcG");
		expect(event?.gateway_reference).toBe(REAL_SCALEV_WEBHOOK.id);
	});

	test("carries no variant information — extraction must return null", () => {
		// Guards the known gap: a fix that starts minting subscriptions must
		// also change this test, so nobody assumes the payload has items.
		expect(extractVariantFromPayload(REAL_SCALEV_WEBHOOK)).toBeNull();
	});

	test("fulfillment accepts Scalev's 'paid' status", async () => {
		// Before the fix this returned "Payment not successful" because the
		// gate only accepted our normalized "success" while being handed the
		// raw body. It must now get past the status gate and fail on the
		// genuinely missing variant instead.
		const result = await handleNexusPayment(
			"scalev",
			REAL_SCALEV_WEBHOOK as unknown as Record<string, unknown>,
			"buyer@example.com",
			"Buyer",
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe("Unknown variant");
	});

	test("non-paid statuses still fail closed", async () => {
		for (const status of ["pending", "cancelled", "expired", "failed", ""]) {
			const result = await handleNexusPayment(
				"scalev",
				{ ...REAL_SCALEV_WEBHOOK, status } as unknown as Record<
					string,
					unknown
				>,
				"buyer@example.com",
				"Buyer",
			);
			expect(result.success).toBe(false);
			expect(result.error).toBe("Payment not successful");
		}
	});

	test("no subscription is minted for the real payload", async () => {
		const rows = await db.execute({
			sql: "SELECT COUNT(*) AS n FROM nexus_subscriptions WHERE scalev_order_id = ?",
			args: [REAL_SCALEV_WEBHOOK.id],
		});
		expect(Number(rows.rows[0].n)).toBe(0);
	});
});

describe("API-created order path (metadata carries the variant)", () => {
	test("metadata.variant resolves the product the raw payload cannot", async () => {
		// Mirrors what the webhook route now builds: the raw Scalev body (no
		// variant) merged with the order's metadata. Before that merge this
		// route could never fulfill, because Scalev sends no items array.
		const orderId = `scv-meta-${Date.now()}`;
		const result = await handleNexusPayment(
			"scalev",
			{
				...REAL_SCALEV_WEBHOOK,
				id: orderId,
				metadata: { variant: "Bot Crypto", telegram_username: "buyer_tg" },
			} as unknown as Record<string, unknown>,
			"buyer@example.com",
			"Buyer",
		);
		expect(result.success).toBe(true);

		const rows = await db.execute({
			sql: "SELECT tier, scalev_order_id FROM nexus_subscriptions WHERE scalev_order_id = ?",
			args: [orderId],
		});
		expect(rows.rows.length).toBe(1);
		expect(String(rows.rows[0].tier)).toBe("auto_bot");
	});

	test("fulfillment stays idempotent for the same Scalev order", async () => {
		const orderId = `scv-idem-${Date.now()}`;
		const payload = {
			...REAL_SCALEV_WEBHOOK,
			id: orderId,
			metadata: { variant: "Bot Crypto" },
		} as unknown as Record<string, unknown>;
		const first = await handleNexusPayment("scalev", payload, "b@example.com", "B");
		const second = await handleNexusPayment("scalev", payload, "b@example.com", "B");
		expect(first.success).toBe(true);
		expect(second.subscriptionId).toBe(first.subscriptionId);
		const rows = await db.execute({
			sql: "SELECT COUNT(*) AS n FROM nexus_subscriptions WHERE scalev_order_id = ?",
			args: [orderId],
		});
		expect(Number(rows.rows[0].n)).toBe(1);
	});
});
