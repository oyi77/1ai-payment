/**
 * Admin platform-gateway routes — admin-owned third-party connections.
 *
 * Customers never touch these. Every connection to a third-party payment
 * provider (Shopee/GoPay) is admin-owned: the admin pastes a session JSON
 * (minted via paygateme CLI or the OTP endpoints) or manages the static QRIS.
 *
 * - GET    /api/admin/platform — list connected platform gateways (masked)
 * - GET    /api/admin/platform/:gateway — status of one connection
 * - PUT    /api/admin/platform/:gateway — set/replace credentials (session, staticQris)
 * - PATCH  /api/admin/platform/:gateway — toggle enabled
 * - DELETE /api/admin/platform/:gateway — remove connection
 *
 * Plain Hono (not OpenAPI): these are internal admin ops, not customer-facing
 * API surface, so they stay out of /doc. All protected by adminAuthMiddleware.
 * Credentials AES-256-GCM encrypted at rest; never returned in full.
 */

import { Hono } from "hono";
import { getDb } from "../../config/database";
import { adminAuthMiddleware } from "../../middleware/admin-auth";
import {
	SUPPORTED_PLATFORM_GATEWAYS,
	isPlatformGateway,
} from "../../services/platform-gateway.service";
import { encrypt } from "../../utils/crypto";
import { logger } from "../../utils/logger";

export const platformGatewaysRouter = new Hono();

platformGatewaysRouter.use("*", adminAuthMiddleware());

const err = (code: string, message: string, status: number) =>
	new Response(
		JSON.stringify({ success: false, error: { code, message } }),
		{ status, headers: { "Content-Type": "application/json" } },
	);

function maskCredentials(creds: Record<string, unknown>): Record<string, unknown> {
	const masked: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(creds)) {
		if (k === "session") masked[k] = typeof v === "string" ? `<${v.length} chars>` : "***";
		else if (k === "staticQris")
			masked[k] = typeof v === "string" ? `${v.slice(0, 24)}…` : "***";
		else masked[k] = "***";
	}
	return masked;
}

// ── GET /api/admin/platform ─────────────────────────────────────
platformGatewaysRouter.get("/platform", async (c) => {
	const db = getDb();
	const result = await db.execute(
		"SELECT gateway, environment, enabled, updated_at FROM platform_gateways ORDER BY gateway",
	);
	const connected = new Set(result.rows.map((r) => String(r.gateway)));
	return c.json({
		success: true,
		data: {
			supported: SUPPORTED_PLATFORM_GATEWAYS,
			connections: result.rows.map((r) => ({
				gateway: String(r.gateway),
				environment: String(r.environment),
				enabled: Boolean(r.enabled),
				updated_at: String(r.updated_at),
			})),
			not_connected: SUPPORTED_PLATFORM_GATEWAYS.filter((g) => !connected.has(g)),
		},
	});
});

// ── GET /api/admin/platform/:gateway ────────────────────────────
platformGatewaysRouter.get("/platform/:gateway", async (c) => {
	const gateway = c.req.param("gateway");
	if (!isPlatformGateway(gateway)) {
		return err("INVALID_GATEWAY", `Unsupported platform gateway: ${gateway}`, 400);
	}
	const db = getDb();
	const result = await db.execute({
		sql: "SELECT gateway, credentials, environment, enabled, updated_at FROM platform_gateways WHERE gateway = ?",
		args: [gateway],
	});
	if (result.rows.length === 0) {
		return err("NOT_FOUND", `Not connected: ${gateway}`, 404);
	}
	const row = result.rows[0] as Record<string, unknown>;
	let creds: Record<string, unknown> = {};
	try {
		const { decrypt } = await import("../../utils/crypto");
		creds = JSON.parse(decrypt(row.credentials as string));
	} catch {
		creds = {};
	}
	return c.json({
		success: true,
		data: {
			gateway: String(row.gateway),
			environment: String(row.environment),
			enabled: Boolean(row.enabled),
			updated_at: String(row.updated_at),
			credentials: maskCredentials(creds),
		},
	});
});

// ── PUT /api/admin/platform/:gateway ────────────────────────────
platformGatewaysRouter.put("/platform/:gateway", async (c) => {
	const gateway = c.req.param("gateway");
	if (!isPlatformGateway(gateway)) {
		return err("INVALID_GATEWAY", `Unsupported platform gateway: ${gateway}`, 400);
	}
	let body: { credentials?: Record<string, unknown>; environment?: string };
	try {
		body = await c.req.json();
	} catch {
		return err("INVALID_BODY", "Invalid JSON body", 400);
	}
	const creds = body.credentials ?? {};
	if (typeof creds !== "object" || Object.keys(creds).length === 0) {
		return err(
			"INVALID_BODY",
			"At least one of session/staticQris required",
			400,
		);
	}
	const env = body.environment === "production" ? "production" : "sandbox";
	const db = getDb();
	const encrypted = encrypt(JSON.stringify(creds));
	await db.execute({
		sql: `INSERT INTO platform_gateways (id, gateway, credentials, environment, enabled)
          VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(gateway) DO UPDATE SET
            credentials = excluded.credentials,
            environment = excluded.environment,
            enabled = 1,
            updated_at = datetime('now')`,
		args: [`pgw_${gateway}`, gateway, encrypted, env],
	});
	logger.info("Platform gateway credentials updated", { gateway });
	return c.json({
		success: true,
		data: { gateway, environment: env, credentials: maskCredentials(creds) },
	});
});

// ── PATCH /api/admin/platform/:gateway ──────────────────────────
platformGatewaysRouter.patch("/platform/:gateway", async (c) => {
	const gateway = c.req.param("gateway");
	if (!isPlatformGateway(gateway)) {
		return err("INVALID_GATEWAY", `Unsupported platform gateway: ${gateway}`, 400);
	}
	let body: { enabled?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return err("INVALID_BODY", "Invalid JSON body", 400);
	}
	if (typeof body.enabled !== "boolean") {
		return err("INVALID_BODY", "enabled must be a boolean", 400);
	}
	const db = getDb();
	const result = await db.execute({
		sql: "UPDATE platform_gateways SET enabled = ?, updated_at = datetime('now') WHERE gateway = ?",
		args: [body.enabled ? 1 : 0, gateway],
	});
	if ((result.rowsAffected ?? 0) === 0) {
		return err("NOT_FOUND", `Not connected: ${gateway}`, 404);
	}
	return c.json({ success: true, data: { gateway, enabled: body.enabled } });
});

// ── DELETE /api/admin/platform/:gateway ─────────────────────────
platformGatewaysRouter.delete("/platform/:gateway", async (c) => {
	const gateway = c.req.param("gateway");
	if (!isPlatformGateway(gateway)) {
		return err("INVALID_GATEWAY", `Unsupported platform gateway: ${gateway}`, 400);
	}
	const db = getDb();
	await db.execute({
		sql: "DELETE FROM platform_gateways WHERE gateway = ?",
		args: [gateway],
	});
	logger.info("Platform gateway connection removed", { gateway });
	return c.json({ success: true, data: { removed: gateway } });
});

// ── OTP connect flow (Shopee, admin-only, experimental) ──────────
//
// Mints a merchant session from inside the dashboard so no external CLI is
// needed. Challenge state is sensitive + short-lived → in-memory with a TTL,
// keyed by an opaque id. Gated by ADMIN_AUTH_EXPERIMENTAL.

import { getConfig } from "../../config/env";
import type { OtpChallenge } from "../../gateways/shopee/types";

const OTP_TTL_MS = 5 * 60 * 1000;
const pendingChallenges = new Map<string, { challenge: OtpChallenge; expiresAt: number }>();

function requireExperimental(): boolean {
	return getConfig().ADMIN_AUTH_EXPERIMENTAL;
}

function gcChallenges(): void {
	const now = Date.now();
	for (const [id, v] of pendingChallenges) {
		if (v.expiresAt <= now) pendingChallenges.delete(id);
	}
}

// POST /api/admin/platform/shopee/otp/start { phone, channel? }
platformGatewaysRouter.post("/platform/shopee/otp/start", async (c) => {
	if (!requireExperimental()) {
		return err(
			"FEATURE_DISABLED",
			"Admin OTP connect is disabled. Set ADMIN_AUTH_EXPERIMENTAL=true or paste a session JSON instead.",
			403,
		);
	}
	let body: { phone?: unknown; channel?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return err("INVALID_BODY", "Invalid JSON body", 400);
	}
	if (typeof body.phone !== "string" || !body.phone.trim()) {
		return err("INVALID_BODY", "phone is required", 400);
	}
	gcChallenges();
	try {
		const { ShopeeAuthClient } = await import("../../gateways/shopee/auth");
		const client = new ShopeeAuthClient();
		const challenge = await client.requestOtp(body.phone.trim(), {
			channel: typeof body.channel === "number" ? body.channel : undefined,
		});
		const id = crypto.randomUUID();
		pendingChallenges.set(id, { challenge, expiresAt: Date.now() + OTP_TTL_MS });
		return c.json({
			success: true,
			data: {
				challenge_id: id,
				channel: challenge.channel,
				available_channels: challenge.availableChannels ?? [],
				has_password: challenge.hasPassword,
				expires_in_ms: OTP_TTL_MS,
			},
		});
	} catch (e) {
		logger.error("Shopee OTP start failed", {
			error: e instanceof Error ? e.message : String(e),
		});
		return err(
			"OTP_START_FAILED",
			e instanceof Error ? e.message : "OTP start failed",
			502,
		);
	}
});

// POST /api/admin/platform/shopee/otp/verify { challenge_id, otp, merchant_id? }
platformGatewaysRouter.post("/platform/shopee/otp/verify", async (c) => {
	if (!requireExperimental()) {
		return err("FEATURE_DISABLED", "Admin OTP connect is disabled.", 403);
	}
	let body: { challenge_id?: unknown; otp?: unknown; merchant_id?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return err("INVALID_BODY", "Invalid JSON body", 400);
	}
	const id = typeof body.challenge_id === "string" ? body.challenge_id : "";
	const otp = typeof body.otp === "string" ? body.otp.trim() : "";
	if (!id || !otp) return err("INVALID_BODY", "challenge_id and otp required", 400);

	gcChallenges();
	const pending = pendingChallenges.get(id);
	if (!pending) {
		return err("CHALLENGE_EXPIRED", "OTP challenge not found or expired. Start again.", 410);
	}

	try {
		const { ShopeeAuthClient } = await import("../../gateways/shopee/auth");
		const client = new ShopeeAuthClient();
		const verification = await client.verifyOtp(pending.challenge, otp);

		// Multiple merchants → ask the admin to pick before completing.
		const usable = verification.merchants.filter((m) => m.isActive && !m.isBanned);
		const requested = typeof body.merchant_id === "string" ? body.merchant_id : "";
		if (!requested && usable.length > 1) {
			// Keep challenge alive for the selection round-trip.
			pendingChallenges.set(id, {
				challenge: { ...pending.challenge },
				expiresAt: Date.now() + OTP_TTL_MS,
			});
			return c.json({
				success: true,
				data: {
					status: "merchant-selection-required",
					challenge_id: id,
					merchants: usable.map((m) => ({ id: m.id, name: m.name })),
				},
			});
		}

		const session = await client.completeLogin(verification, requested || undefined);
		pendingChallenges.delete(id);

		// Persist the minted session as platform credentials (encrypted).
		const db = getDb();
		await db.execute({
			sql: `INSERT INTO platform_gateways (id, gateway, credentials, environment, enabled)
            VALUES ('pgw_shopee', 'shopee', ?, 'production', 1)
            ON CONFLICT(gateway) DO UPDATE SET
              credentials = excluded.credentials, enabled = 1, updated_at = datetime('now')`,
			args: [encrypt(JSON.stringify({ session: JSON.stringify(session) }))],
		});
		logger.info("Shopee platform session minted via OTP", {
			merchant: session.merchant.name,
		});
		return c.json({
			success: true,
			data: {
				status: "connected",
				gateway: "shopee",
				merchant: { id: session.merchant.id, name: session.merchant.name },
				expires_at: session.expiresAt ?? null,
			},
		});
	} catch (e) {
		logger.error("Shopee OTP verify failed", {
			error: e instanceof Error ? e.message : String(e),
		});
		return err(
			"OTP_VERIFY_FAILED",
			e instanceof Error ? e.message : "OTP verify failed",
			502,
		);
	}
});
