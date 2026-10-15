/**
 * Unit tests for the Mutasiku + Moota aggregator gateways.
 *
 * Both are read-only (no order checkout): createPayment must throw. The
 * valuable surface is signature verification (accept valid HMAC, reject
 * tampered/wrong-secret/absent) and normalizeEvent (map upstream shapes
 * to the canonical event, compute direction + reconciliation keys).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { initDatabase } from "../../src/config/database";
import { resetConfigCache } from "../../src/config/env";
import { MutasikuGateway } from "../../src/gateways/mutasiku";
import { MootaGateway } from "../../src/gateways/moota";

const TEST_DB = join(tmpdir(), `1pay-mutasi-gw-${Date.now()}.db`);
const SECRET = "whsec_mutasi_test_secret";

// Env must be set at module scope (runs after static imports initialize,
// before beforeAll/tests). Gateway methods call getConfig() lazily at
// call-time, so resetConfigCache() in beforeAll makes them pick these up.
process.env.API_KEY = "test-api-key-mutasi";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-mutasi";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
process.env.MUTASIKU_WEBHOOK_SECRET = SECRET;
process.env.MOOTA_WEBHOOK_SECRET = SECRET;

beforeAll(async () => {
	resetConfigCache();
	await initDatabase();
});

afterAll(() => {
	if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

function signMutasiku(body: unknown, secret = SECRET): string {
	const compact = JSON.stringify(body, Object.keys(body as object).sort());
	return createHmac("sha256", secret).update(compact).digest("hex");
}

describe("MutasikuGateway", () => {
	test("createPayment throws — aggregators are read-only", async () => {
		const gw = new MutasikuGateway();
		await expect(
			gw.createPayment({
				orderId: "o1",
				amount: 1000,
				currency: "IDR",
				callbackUrl: "https://example.com/cb",
			}),
		).rejects.toThrow();
	});

	test("verifySignatureRaw accepts a valid compact-JSON HMAC", async () => {
		const gw = new MutasikuGateway();
		const body = { id: "tx-1", nominal: 50000, jenis: "kredit", rekening: "1234567890" };
		const sig = signMutasiku(body);
		const ok = await gw.verifySignatureRaw(
			JSON.stringify(body),
			{ "x-webhook-signature": sig },
		);
		expect(ok).toBe(true);
	});

	test("verifySignatureRaw rejects a tampered body", async () => {
		const gw = new MutasikuGateway();
		const body = { id: "tx-2", nominal: 50000, jenis: "kredit" };
		const sig = signMutasiku(body);
		const tampered = JSON.stringify({ ...body, nominal: 999999 });
		const ok = await gw.verifySignatureRaw(
			tampered,
			{ "x-webhook-signature": sig },
		);
		expect(ok).toBe(false);
	});

	test("verifySignatureRaw rejects a wrong secret", async () => {
		const gw = new MutasikuGateway();
		const body = { id: "tx-3", nominal: 1000 };
		const sig = signMutasiku(body, "attacker-secret");
		const ok = await gw.verifySignatureRaw(
			JSON.stringify(body),
			{ "x-webhook-signature": sig },
		);
		expect(ok).toBe(false);
	});

	test("verifySignatureRaw rejects a missing header", async () => {
		const gw = new MutasikuGateway();
		const ok = await gw.verifySignatureRaw(JSON.stringify({ id: "tx-4" }), {});
		expect(ok).toBe(false);
	});

	test("normalizeEvent maps a credit mutation (Indonesian keys)", () => {
		const gw = new MutasikuGateway();
		const ev = gw.normalizeEvent({
			id: "mut-123",
			nominal: 75000,
			jenis: "kredit",
			keterangan: "TRSF Budi",
			senderName: "Budi",
			bank: "BCA",
			rekening: "0580771556",
			tanggal: "2026-01-15",
		});
		expect(ev.gateway).toBe("mutasiku");
		expect(ev.gateway_reference).toBe("mut-123");
		expect(ev.amount).toBe(75000);
		expect(ev.currency).toBe("IDR");
		expect(ev.status).toBe("success");
		expect((ev.metadata as Record<string, unknown>).direction).toBe("CR");
		expect((ev.metadata as Record<string, unknown>).account_number).toBe("0580771556");
		expect(ev.paid_at).toBe("2026-01-15");
	});

	test("normalizeEvent maps a debit mutation to pending/DB", () => {
		const gw = new MutasikuGateway();
		const ev = gw.normalizeEvent({
			id: "mut-456",
			nominal: 20000,
			jenis: "debit",
			keterangan: "Tarik ATM",
			bank: "BCA",
		});
		expect(ev.status).toBe("pending");
		expect((ev.metadata as Record<string, unknown>).direction).toBe("DB");
		expect(ev.paid_at).toBeNull();
	});

	test("normalizeEvent falls back to a deterministic ref when id is absent", () => {
		const gw = new MutasikuGateway();
		const a = gw.normalizeEvent({
			nominal: 1000,
			jenis: "kredit",
			keterangan: "x",
			tanggal: "2026-01-01",
		});
		const b = gw.normalizeEvent({
			nominal: 1000,
			jenis: "kredit",
			keterangan: "x",
			tanggal: "2026-01-01",
		});
		expect(a.gateway_reference).toBe(b.gateway_reference);
		expect(a.gateway_reference.length).toBeGreaterThan(0);
	});
});

describe("MootaGateway", () => {
	test("createPayment throws — aggregators are read-only", async () => {
		const gw = new MootaGateway();
		await expect(
			gw.createPayment({
				orderId: "o1",
				amount: 1000,
				currency: "IDR",
				callbackUrl: "https://example.com/cb",
			}),
		).rejects.toThrow();
	});

	test("verifySignatureRaw accepts a raw-body HMAC", async () => {
		const gw = new MootaGateway();
		const raw = JSON.stringify({ mutation_id: "m1", amount: 50000, type: "CR" });
		const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
		expect(await gw.verifySignatureRaw(raw, { "x-webhook-signature": sig })).toBe(true);
	});

	test("verifySignatureRaw accepts a sha256= prefixed signature", async () => {
		const gw = new MootaGateway();
		const raw = JSON.stringify({ mutation_id: "m2", amount: 1000, type: "CR" });
		const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
		expect(
			await gw.verifySignatureRaw(raw, { "x-webhook-signature": `sha256=${sig}` }),
		).toBe(true);
	});

	test("verifySignatureRaw rejects a tampered body", async () => {
		const gw = new MootaGateway();
		const raw = JSON.stringify({ mutation_id: "m3", amount: 1000, type: "CR" });
		const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
		const tampered = JSON.stringify({ mutation_id: "m3", amount: 9000000, type: "CR" });
		expect(await gw.verifySignatureRaw(tampered, { "x-webhook-signature": sig })).toBe(false);
	});

	test("normalizeEvent maps a CR mutation to success", () => {
		const gw = new MootaGateway();
		const ev = gw.normalizeEvent({
			mutation_id: "mm-1",
			amount: 125000,
			type: "CR",
			description: "TRANSFER MASUK",
			note: "Setoran",
			bank: "BCA",
			account_number: "998877",
			date: "2026-02-01 10:00:00",
		});
		expect(ev.gateway).toBe("moota");
		expect(ev.gateway_reference).toBe("mm-1");
		expect(ev.amount).toBe(125000);
		expect(ev.status).toBe("success");
		expect((ev.metadata as Record<string, unknown>).direction).toBe("CR");
		expect(ev.paid_at).toBe("2026-02-01");
	});

	test("normalizeEvent maps a DB mutation to pending", () => {
		const gw = new MootaGateway();
		const ev = gw.normalizeEvent({
			mutation_id: "mm-2",
			amount: 30000,
			type: "DB",
			description: "TRANSFER KELUAR",
			bank: "BNI",
		});
		expect(ev.status).toBe("pending");
		expect((ev.metadata as Record<string, unknown>).direction).toBe("DB");
		expect(ev.paid_at).toBeNull();
	});
});
