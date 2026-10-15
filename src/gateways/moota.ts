/**
 * Moota — bank mutation aggregator gateway.
 *
 * Like Mutasiku, Moota does not create payments. It aggregates bank
 * mutations from connected accounts and delivers them as webhooks or
 * via REST API pull.
 *
 * Flow:
 * 1. Operator connects bank accounts in Moota dashboard
 * 2. Moota sends mutation webhooks to /webhook/moota
 * 3. This gateway verifies the HMAC-SHA256 signature
 * 4. normalizeEvent maps the mutation to a NormalizedPaymentEvent
 * 5. forwardEvent sends it to the project's callback_url
 *
 * Webhook signature: HMAC-SHA256 over raw request body.
 * Header: X-Webhook-Signature (raw hex)
 * Payload: { mutation_id, amount, type:"CR"|"DB", description, date, ... }
 *
 * Pull API: GET /api/moota/mutations (merchant-scoped, uses stored
 * API key to fetch from Moota REST API).
 */

import crypto from "node:crypto";
import { getConfig, resolveGatewayConfig } from "../config/env";
import { GatewayError } from "../utils/errors";
import { logger } from "../utils/logger";
import type {
	CreatePaymentParams,
	CreatePaymentResult,
	GatewayVerifyOpts,
	NormalizedPaymentEvent,
	PaymentGateway,
	PaymentMethod,
	PaymentStatus,
} from "./base";

const MOOTA_BASE_URL = "https://app.moota.co";

interface MootaMerchantConfig {
	apiKey?: string;
	webhookSecret?: string;
}

interface MootaMutation {
	mutation_id?: string;
	id?: string;
	amount?: number;
	type?: string;
	description?: string;
	note?: string;
	date?: string;
	created_at?: string;
	balance?: number | string | null;
	account_number?: string;
	bank?: string;
	bank_name?: string;
	bank_type?: string;
	reference?: string;
}

interface MootaApiResponse {
	data?: MootaMutation[] | MootaMutation;
	next_page_url?: string | null;
}

export class MootaGateway implements PaymentGateway {
	readonly name = "moota";

	async createPayment(
		_params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		throw new GatewayError(
			"moota",
			"Moota is a mutation aggregator (read-only), not a payment gateway. Use the pull API or webhook.",
		);
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "BANK_TRANSFER_MUTATION", name: "Bank Mutation (Moota)", currencies: ["IDR"] },
		];
	}

	async verifySignature(
		body: unknown,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		return this.verifySignatureRaw(
			JSON.stringify(body),
			headers,
			opts,
		);
	}

	async verifySignatureRaw(
		rawBody: string,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"moota",
					opts.merchantId,
				)) as unknown as MootaMerchantConfig)
			: null;
		const secret = m?.webhookSecret || base.MOOTA_WEBHOOK_SECRET;

		if (!secret) {
			logger.error("MOOTA_WEBHOOK_SECRET not configured");
			return false;
		}

		const signature =
			headers["x-webhook-signature"] ||
			headers["X-Webhook-Signature"] ||
			"";
		if (!signature) {
			logger.warn("Moota: missing X-Webhook-Signature header");
			return false;
		}

		// Moota signs over the raw request body bytes
		const expected = crypto
			.createHmac("sha256", secret)
			.update(rawBody)
			.digest("hex");

		// Accept sha256=<hex> prefix (GitHub-style) or raw hex
		const provided = signature.trim().toLowerCase();
		const cleanSig = provided.startsWith("sha256=")
			? provided.slice(7)
			: provided;

		try {
			return crypto.timingSafeEqual(
				Buffer.from(cleanSig, "hex"),
				Buffer.from(expected, "hex"),
			);
		} catch {
			return false;
		}
	}

	normalizeEvent(
		body: unknown,
		metadata?: Record<string, unknown> | null,
	): NormalizedPaymentEvent {
		const item = body as MootaMutation;

		const amount = Math.abs(Number(item.amount ?? 0));

		const typeRaw = String(item.type || "").toUpperCase();
		const isDebit = typeRaw.startsWith("D");
		const isCredit = typeRaw.startsWith("C");

		const mutationId = String(item.mutation_id || item.id || "");

		const created = String(
			item.date || item.created_at || "",
		);
		const date = created.length >= 10 ? created.substring(0, 10) : created;

		const desc = String(item.description || "").trim();
		const note = String(item.note || "").trim();
		const description = `${desc} ${note}`.trim() || "MOOTA";

		const bank = String(item.bank || item.bank_name || "");
		const bankType = String(item.bank_type || "").toUpperCase();
		const accountNumber = String(item.account_number || "");

		const status: PaymentStatus = isDebit ? "pending" : "success";

		const gatewayRef = mutationId || crypto
			.createHash("sha256")
			.update(`${date}|${amount}|${description}`)
			.digest("hex")
			.substring(0, 24);

		return {
			gateway: this.name,
			order_id: accountNumber || bank || "moota",
			gateway_reference: gatewayRef,
			status,
			amount,
			currency: "IDR",
			payment_method: bank || bankType || "BANK_TRANSFER",
			paid_at: isCredit ? date : null,
			metadata: {
				...metadata,
				direction: isDebit ? "DB" : "CR",
				description,
				bank: bank || bankType || "BANK",
				account_number: accountNumber,
				bank_type: bankType,
				balance: item.balance != null ? String(item.balance) : null,
				raw: item,
			},
		};
	}

	async refundPayment(
		_gatewayRef: string,
		_amount: number,
	): Promise<{ gatewayRefundId: string; status: "success" | "pending" | "failed" }> {
		throw new GatewayError("moota", "REFUND_NOT_SUPPORTED");
	}
}

// ── Pull API helpers ──────────────────────────────────────────────────

export interface MootaPullParams {
	apiKey: string;
	accountId: string;
	page?: number;
}

export interface MootaPullResult {
	mutations: MootaMutation[];
	nextPageUrl: string | null;
}

/**
 * Pull mutations from Moota REST API for one bank account.
 * Moota requires a bank_id (account_id) — there is no global mutation list.
 */
export async function pullMutations(
	params: MootaPullParams,
): Promise<MootaPullResult> {
	const { apiKey, accountId } = params;

	if (!apiKey) {
		throw new GatewayError("moota", "MOOTA_API_KEY not configured");
	}
	if (!accountId) {
		throw new GatewayError(
			"moota",
			"Moota mutation fetch requires an account (bank_id)",
		);
	}

	const url = `${MOOTA_BASE_URL}/api/v1/bank/${accountId}/mutation/`;
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
	});

	if (response.status === 401 || response.status === 403) {
		throw new GatewayError("moota", "Invalid Moota API token");
	}
	if (!response.ok) {
		throw new GatewayError(
			"moota",
			`Moota API error: ${response.status} ${await response.text()}`.substring(0, 200),
		);
	}

	const body = (await response.json()) as MootaApiResponse;
	const data = body.data;
	const mutations: MootaMutation[] = Array.isArray(data)
		? data
		: data
			? [data]
			: [];

	return {
		mutations,
		nextPageUrl: body.next_page_url ?? null,
	};
}

/**
 * List connected bank accounts.
 */
export async function listAccounts(apiKey: string): Promise<unknown[]> {
	if (!apiKey) {
		throw new GatewayError("moota", "MOOTA_API_KEY not configured");
	}

	const response = await fetch(`${MOOTA_BASE_URL}/api/v1/bank`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
	});

	if (response.status === 401 || response.status === 403) {
		throw new GatewayError("moota", "Invalid Moota API token");
	}
	if (!response.ok) {
		throw new GatewayError(
			"moota",
			`Moota accounts error: ${response.status}`,
		);
	}

	const body = (await response.json()) as MootaApiResponse;
	const data = body.data;
	return Array.isArray(data) ? data : [];
}
