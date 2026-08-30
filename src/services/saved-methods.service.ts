/**
 * Saved payment methods — merchant-scoped vault of reusable gateway tokens
 * (saved cards, e-wallets, bank accounts). Customers choose a previously
 * stored method instead of re-entering details at checkout.
 *
 * Isolation: every row is keyed to merchant_id; cross-merchant reads are
 * impossible by construction. Idempotency: UNIQUE(merchant_id, gateway,
 * gateway_token) collapses re-stores into the existing row.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../config/database.js";
import { DuplicateSavedMethodError } from "../utils/errors.js";

export interface SavedMethod {
	id: string;
	merchant_id: string;
	gateway: string;
	method_code: string;
	method_name: string;
	gateway_token: string;
	masked_identifier: string | null;
	expires_at: string | null;
	created_at: string;
}

export interface CreateSavedMethodInput {
	gateway: string;
	method_code: string;
	method_name: string;
	gateway_token: string;
	masked_identifier?: string | null;
	expires_at?: string | null;
}

export async function listSavedMethods(
	merchantId: string,
): Promise<SavedMethod[]> {
	const db = getDb();
	const result = await db.execute({
		sql: `
			SELECT id, merchant_id, gateway, method_code, method_name,
			       gateway_token, masked_identifier, expires_at, created_at
			FROM saved_payment_methods
			WHERE merchant_id = ?
			ORDER BY created_at DESC
		`,
		args: [merchantId],
	});
	return (result.rows as unknown as SavedMethod[]).map(rowToSavedMethod);
}

export async function createSavedMethod(
	merchantId: string,
	input: CreateSavedMethodInput,
): Promise<SavedMethod> {
	const db = getDb();
	// Idempotent re-store: same merchant + gateway + token returns existing row.
	const existing = await findByUniqueKey(
		merchantId,
		input.gateway,
		input.gateway_token,
	);
	if (existing) return existing;

	const id = randomUUID();
	await db.execute({
		sql: `
			INSERT INTO saved_payment_methods
				(id, merchant_id, gateway, method_code, method_name,
				 gateway_token, masked_identifier, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			merchantId,
			input.gateway,
			input.method_code,
			input.method_name,
			input.gateway_token,
			input.masked_identifier ?? null,
			input.expires_at ?? null,
		],
	});
	const created = await getSavedMethod(merchantId, id);
	if (!created) {
		throw new DuplicateSavedMethodError(
			merchantId,
			input.gateway,
			input.gateway_token,
		);
	}
	return created;
}

/**
 * Owner-scoped delete. Returns the number of rows removed (0 or 1).
 * A merchant can only delete their own method — no cross-merchant delete.
 */
export async function deleteSavedMethod(
	merchantId: string,
	id: string,
): Promise<number> {
	const db = getDb();
	const result = await db.execute({
		sql: "DELETE FROM saved_payment_methods WHERE merchant_id = ? AND id = ?",
		args: [merchantId, id],
	});
	return Number(result.rowsAffected ?? 0);
}

export async function findByUniqueKey(
	merchantId: string,
	gateway: string,
	gateway_token: string,
): Promise<SavedMethod | null> {
	const db = getDb();
	const result = await db.execute({
		sql: `
			SELECT id, merchant_id, gateway, method_code, method_name,
			       gateway_token, masked_identifier, expires_at, created_at
			FROM saved_payment_methods
			WHERE merchant_id = ? AND gateway = ? AND gateway_token = ?
			LIMIT 1
		`,
		args: [merchantId, gateway, gateway_token],
	});
	const row = result.rows[0] as unknown as SavedMethod | undefined;
	return row ? rowToSavedMethod(row) : null;
}

async function getSavedMethod(
	merchantId: string,
	id: string,
): Promise<SavedMethod | null> {
	const db = getDb();
	const result = await db.execute({
		sql: `
			SELECT id, merchant_id, gateway, method_code, method_name,
			       gateway_token, masked_identifier, expires_at, created_at
			FROM saved_payment_methods
			WHERE merchant_id = ? AND id = ?
			LIMIT 1
		`,
		args: [merchantId, id],
	});
	const row = result.rows[0] as unknown as SavedMethod | undefined;
	return row ? rowToSavedMethod(row) : null;
}

function rowToSavedMethod(row: SavedMethod): SavedMethod {
	return {
		id: String(row.id),
		merchant_id: String(row.merchant_id),
		gateway: String(row.gateway),
		method_code: String(row.method_code),
		method_name: String(row.method_name),
		gateway_token: String(row.gateway_token),
		masked_identifier:
			row.masked_identifier == null ? null : String(row.masked_identifier),
		expires_at: row.expires_at == null ? null : String(row.expires_at),
		created_at: String(row.created_at),
	};
}
/**
 * Public lookup by id — used by routes for GET /saved-methods/:methodId
 * Returns null if not found (caller decides 404 vs existing).
 */
export async function getSavedMethodById(
	merchantId: string,
	id: string,
): Promise<SavedMethod | null> {
	const db = getDb();
	const result = await db.execute({
		sql: `
			SELECT id, merchant_id, gateway, method_code, method_name,
			       gateway_token, masked_identifier, expires_at, created_at
			FROM saved_payment_methods
			WHERE merchant_id = ? AND id = ?
		`,
		args: [merchantId, id],
	});
	if (result.rows.length === 0) return null;
	return rowToSavedMethod(result.rows[0] as unknown as SavedMethod);
}
