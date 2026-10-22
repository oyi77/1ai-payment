/**
 * Mutation fanout dead-letter queue.
 *
 * A bank-mutation delivery that never succeeds must leave a row operators
 * can find again. The DLQ insert originally omitted `id`, and SQLite allows
 * NULL in a TEXT PRIMARY KEY, so rows landed unaddressable — no replay by
 * id, and nothing distinguishing two failures of the same event.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDatabase } from "../../src/config/database";
import { resetConfigCache } from "../../src/config/env";
import type { NormalizedPaymentEvent } from "../../src/gateways/base";
import { fanoutMutation } from "../../src/services/mutation-forwarder.service";
import { encryptWebhookSecret } from "../../src/utils/crypto";

const TEST_DB = join(tmpdir(), `1pay-mutation-dlq-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-mutation-dlq";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-mutation-dlq";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

const originalFetch = globalThis.fetch;

/**
 * Run a callback with setTimeout replaced so retry backoff executes
 * instantly. Backoff is 2s + 10s, far past bun's per-test deadline.
 */
async function withInstantTimers<T>(fn: () => Promise<T>): Promise<T> {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((
		cb: (...args: unknown[]) => void,
		_ms?: number,
	) => originalSetTimeout(cb, 0)) as unknown as typeof globalThis.setTimeout;
	try {
		return await fn();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
}

const MUTATION: NormalizedPaymentEvent = {
	gateway: "moota",
	order_id: "",
	gateway_reference: "mut_1001",
	status: "success",
	amount: 50000,
	currency: "IDR",
	payment_method: "bank_transfer",
	paid_at: "2026-10-23T00:00:00.000Z",
	metadata: { direction: "CR", bank: "BCA", account_number: "1234567890" },
};

async function seedMerchant(
	id: string,
	callbackUrl: string,
	secret: string,
): Promise<void> {
	const db = getDb();
	await db.execute({
		sql: `INSERT INTO merchants
		        (id, name, api_key_hash, webhook_secret, default_callback_url, active)
		      VALUES (?, ?, ?, ?, ?, 1)`,
		args: [id, id, `hash_${id}`, encryptWebhookSecret(secret), callbackUrl],
	});
	await db.execute({
		sql: `INSERT INTO merchant_gateways
		        (id, merchant_id, gateway, credentials, environment, enabled)
		      VALUES (?, ?, 'moota', '{}', 'production', 1)`,
		args: [`mg_${id}`, id],
	});
}

async function deadLetters(): Promise<
	Array<{ id: unknown; type: string; payload: string }>
> {
	const res = await getDb().execute(
		"SELECT id, type, payload FROM dead_letter_queue ORDER BY rowid",
	);
	return res.rows.map((r: Record<string, unknown>) => ({
		id: r.id,
		type: String(r.type ?? ""),
		payload: String(r.payload ?? ""),
	}));
}

beforeAll(async () => {
	await initDatabase();
	await seedMerchant("merch_dlq_dead", "http://127.0.0.1:9/never", "whsec_dlq");
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {
		/* best-effort cleanup */
	}
});

describe("fanoutMutation dead-letter rows", () => {
	test("a permanently failing delivery is addressable by id", async () => {
		// Unroutable port: every attempt fails at the transport layer.
		globalThis.fetch = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;

		const result = await withInstantTimers(() => fanoutMutation(MUTATION));
		expect(result.failed).toBe(1);

		const rows = await deadLetters();
		expect(rows.length).toBe(1);
		expect(rows[0].type).toBe("mutation_fanout");
		expect(typeof rows[0].id).toBe("string");
		expect(String(rows[0].id)).not.toBe("null");
		expect(String(rows[0].id).length).toBeGreaterThan(20);

		const stored = JSON.parse(rows[0].payload) as Record<string, unknown>;
		expect(stored.event_id).toBe("mut_1001");
		expect(stored.reason).toBe("connection_error");
	});

	test("two failures of the same event produce two distinct ids", async () => {
		globalThis.fetch = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;

		await withInstantTimers(() => fanoutMutation(MUTATION));
		const rows = await deadLetters();
		const ids = rows.map((r) => String(r.id));
		expect(ids.length).toBe(2);
		expect(new Set(ids).size).toBe(2);
	});
});
