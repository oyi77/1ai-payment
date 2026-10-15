/**
 * Mutasiku — bank & e-wallet mutation aggregator gateway.
 *
 * Unlike conventional payment gateways, Mutasiku does not create payments.
 * It aggregates bank mutations from connected accounts (the operator
 * connects their own bank/e-wallet accounts via OTP in the Mutasiku
 * dashboard) and delivers them as webhooks.
 *
 * Flow:
 * 1. Operator connects bank accounts in Mutasiku dashboard
 * 2. Mutasiku sends mutation webhooks to /webhook/mutasiku
 * 3. This gateway verifies the HMAC-SHA256 signature over compact JSON
 * 4. normalizeEvent maps the mutation to a NormalizedPaymentEvent
 * 5. forwardEvent sends it to the project's callback_url
 *
 * Webhook signature: HMAC-SHA256 over JSON.stringify(body, separators
 * compact) using the Mutasiku webhook secret.
 * Header: X-Webhook-Signature
 * Payload: { nominal, jenis, keterangan, tanggal, rekening, bank, ... }
 *
 * Pull API: GET /api/mutasiku/mutations (merchant-scoped, uses stored
 * API key to fetch from Mutasiku REST API).
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

// ── Mutasiku API ──────────────────────────────────────────────────────

const MUTASIKU_BASE_URL = "https://mutasiku.co.id/api/v1";

interface MutasikuMerchantConfig {
	apiKey?: string;
	webhookSecret?: string;
}

interface MutasikuMutation {
	id?: string;
	nominal?: number;
	amount?: number;
	jenis?: string;
	type?: string;
	direction?: string;
	keterangan?: string;
	description?: string;
	note?: string;
	tanggal?: string;
	date?: string;
	created_at?: string;
	createdAt?: string;
	rekening?: string;
	account_number?: string;
	bank?: string;
	bank_name?: string;
	reference?: string;
	status?: string;
	// Nested account/provider (REST API shape)
	account?: {
		id?: string;
		accountName?: string;
		provider?: { name?: string; code?: string };
	};
	senderName?: string;
	recipientName?: string;
}

interface MutasikuApiResponse {
	status: string;
	data: MutasikuMutation[] | { mutations?: MutasikuMutation[] };
	pagination?: { hasMore?: boolean };
}

// ── Gateway ───────────────────────────────────────────────────────────

export class MutasikuGateway implements PaymentGateway {
	readonly name = "mutasiku";

	async createPayment(
		_params: CreatePaymentParams,
	): Promise<CreatePaymentResult> {
		throw new GatewayError(
			"mutasiku",
			"Mutasiku is a mutation aggregator (read-only), not a payment gateway. Use the pull API or webhook.",
		);
	}

	getPaymentMethods(): PaymentMethod[] {
		return [
			{ code: "BANK_TRANSFER_MUTATION", name: "Bank Mutation (Mutasiku)", currencies: ["IDR"] },
		];
	}

	async verifySignature(
		body: unknown,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		// Mutasiku signs over compact JSON of the parsed body, not raw bytes.
		// Re-serialize to match.
		const compact = JSON.stringify(body, Object.keys(body as object).sort());
		return this.verifySignatureRaw(compact, headers, opts);
	}

	async verifySignatureRaw(
		rawBody: string,
		headers: Record<string, string>,
		opts?: GatewayVerifyOpts,
	): Promise<boolean> {
		const base = getConfig();
		const m = opts?.merchantId
			? ((await resolveGatewayConfig(
					"mutasiku",
					opts.merchantId,
				)) as unknown as MutasikuMerchantConfig)
			: null;
		const secret = m?.webhookSecret || base.MUTASIKU_WEBHOOK_SECRET;

		if (!secret) {
			logger.error("MUTASIKU_WEBHOOK_SECRET not configured");
			return false;
		}

		const signature =
			headers["x-webhook-signature"] ||
			headers["X-Webhook-Signature"] ||
			"";
		if (!signature) {
			logger.warn("Mutasiku: missing X-Webhook-Signature header");
			return false;
		}

		// Mutasiku computes HMAC over JSON.stringify(body) with compact
		// separators — re-serialize the raw body to compact form to match.
		// If the raw body is already compact JSON, this is a no-op.
		let compactBody: string;
		try {
			const parsed = JSON.parse(rawBody);
			compactBody = JSON.stringify(parsed, Object.keys(parsed).sort());
		} catch {
			// Non-JSON body — sign over raw bytes as-is
			compactBody = rawBody;
		}

		const expected = crypto
			.createHmac("sha256", secret)
			.update(compactBody)
			.digest("hex");

		try {
			return crypto.timingSafeEqual(
				Buffer.from(signature.trim().toLowerCase(), "hex"),
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
		const item = body as MutasikuMutation;

		// Amount: prefer nominal (webhook), fall back to amount (REST API)
		const amount = Math.abs(
			Number(item.nominal ?? item.amount ?? 0),
		);

		// Direction: webhook uses Indonesian (jenis: kredit/debit),
		// REST API uses English (type: CREDIT/DEBIT)
		const jenis = String(
			item.jenis || item.type || item.direction || "kredit",
		).toLowerCase();
		const isDebit = jenis.includes("deb") || jenis.includes("keluar");
		const isCredit = jenis.includes("kre") || jenis.includes("credit");

		// Transaction ID
		const txId = String(item.id || "");

		// Date
		const date = String(item.tanggal || item.date || item.created_at || item.createdAt || "");

		// Description: combine keterangan + counterparty
		const desc = String(item.keterangan || item.description || item.note || "");
		const counterparty = isCredit
			? String(item.senderName || "")
			: String(item.recipientName || "");
		const description = `${desc} ${counterparty}`.trim() || "MUTASIKU";

		// Bank / account
		const bank = String(item.bank || item.bank_name || "");
		const rekening = String(item.rekening || item.account_number || "");

		// Provider code from nested account (REST API shape)
		const acct = item.account;
		let providerCode = "";
		if (acct && typeof acct === "object") {
			const prov = acct.provider;
			if (prov && typeof prov === "object" && prov.code) {
				providerCode = String(prov.code).toUpperCase();
			}
		}

		// Status: credit mutations are "success" (money arrived),
		// debit mutations are "pending" (money left, needs reconciliation)
		const status: PaymentStatus = isDebit ? "pending" : "success";

		// gateway_reference: unique mutation id
		const gatewayRef = txId || crypto
			.createHash("sha256")
			.update(`${date}|${amount}|${description}`)
			.digest("hex")
			.substring(0, 24);

		return {
			gateway: this.name,
			// Mutasiku mutations don't have an order_id — the project
			// reconciles by unique code in the description.
			// Use rekening (account number) as a routing hint so the
			// forwarder can find the owning project.
			order_id: rekening || bank || "mutasiku",
			gateway_reference: gatewayRef,
			status,
			amount,
			currency: "IDR",
			payment_method: bank || providerCode || "BANK_TRANSFER",
			paid_at: isCredit ? date : null,
			metadata: {
				...metadata,
				// Preserve full mutation context for project-side reconciliation
				direction: isDebit ? "DB" : "CR",
				description,
				bank: bank || providerCode || "BANK",
				account_number: rekening,
				provider_code: providerCode,
				raw: item,
			},
		};
	}

	async refundPayment(
		_gatewayRef: string,
		_amount: number,
	): Promise<{ gatewayRefundId: string; status: "success" | "pending" | "failed" }> {
		throw new GatewayError("mutasiku", "REFUND_NOT_SUPPORTED");
	}
}

// ── Pull API helper (used by routes/mutasiku.ts) ──────────────────────

export interface MutasikuPullParams {
	apiKey: string;
	startDate?: string;
	endDate?: string;
	accountId?: string;
	page?: number;
	limit?: number;
}

export interface MutasikuPullResult {
	mutations: MutasikuMutation[];
	hasMore: boolean;
}

/**
 * Pull mutations from Mutasiku REST API.
 * Used by the /api/mutasiku/mutations route (merchant-scoped).
 */
export async function pullMutations(
	params: MutasikuPullParams,
): Promise<MutasikuPullResult> {
	const {
		apiKey,
		startDate,
		endDate,
		accountId,
		page = 1,
		limit = 100,
	} = params;

	if (!apiKey) {
		throw new GatewayError("mutasiku", "MUTASIKU_API_KEY not configured");
	}

	// Default date range: yesterday to today
	const today = new Date().toISOString().split("T")[0]!;
	const yesterday = new Date(Date.now() - 86400000)
		.toISOString()
		.split("T")[0]!;
	const start = startDate || yesterday;
	const end = endDate || today;

	const url = new URL(`${MUTASIKU_BASE_URL}/mutations`);
	url.searchParams.set("startDate", start);
	url.searchParams.set("endDate", end);
	url.searchParams.set("page", String(page));
	url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
	if (accountId) {
		url.searchParams.set("accountId", accountId);
	}

	const response = await fetch(url.toString(), {
		headers: { "x-api-key": apiKey },
	});

	if (response.status === 401 || response.status === 403) {
		throw new GatewayError("mutasiku", "Invalid Mutasiku API key");
	}
	if (!response.ok) {
		throw new GatewayError(
			"mutasiku",
			`Mutasiku API error: ${response.status} ${await response.text()}`.substring(0, 200),
		);
	}

	const body = (await response.json()) as MutasikuApiResponse;
	if (body.status !== "success") {
		throw new GatewayError("mutasiku", `Mutasiku error: ${JSON.stringify(body).substring(0, 120)}`);
	}

	const data = body.data;
	let mutations: MutasikuMutation[];
	if (Array.isArray(data)) {
		mutations = data;
	} else if (data && Array.isArray(data.mutations)) {
		mutations = data.mutations;
	} else {
		mutations = [];
	}

	return {
		mutations,
		hasMore: Boolean(body.pagination?.hasMore),
	};
}

/**
 * List connected bank/e-wallet accounts.
 */
export async function listAccounts(apiKey: string): Promise<unknown[]> {
	if (!apiKey) {
		throw new GatewayError("mutasiku", "MUTASIKU_API_KEY not configured");
	}

	const response = await fetch(
		`${MUTASIKU_BASE_URL}/accounts?isActive=true&limit=100`,
		{ headers: { "x-api-key": apiKey } },
	);

	if (response.status === 401 || response.status === 403) {
		throw new GatewayError("mutasiku", "Invalid Mutasiku API key");
	}
	if (!response.ok) {
		throw new GatewayError(
			"mutasiku",
			`Mutasiku accounts error: ${response.status}`,
		);
	}

	const body = (await response.json()) as MutasikuApiResponse;
	const data = body.data;
	return Array.isArray(data) ? data : [];
}
