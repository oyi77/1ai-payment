/**
 * Platform-gateway credential resolution.
 *
 * Priority order for feed gateways (Shopee/GoPay):
 *   1. platform_gateways (admin-minted session JSON)
 *   2. merchant_gateways (merchant BYOK)
 *   3. platform env (SHOPEE_SESSION_JSON / GOPAY_SESSION_JSON)
 *
 * Customers never write here — only admin. Resolution is read-only for
 * merchants; writes go through /api/admin/platform/:gateway.
 */

import { getDb } from "../config/database";
import { decrypt } from "../utils/crypto";
import { getConfig } from "../config/env";
import { logger } from "../utils/logger";

export interface PlatformGatewayRecord {
	gateway: string;
	credentials: Record<string, unknown>;
	environment: string;
	enabled: boolean;
}

export const SUPPORTED_PLATFORM_GATEWAYS = ["shopee", "gopay"] as const;

export function isPlatformGateway(gateway: string): boolean {
	return (SUPPORTED_PLATFORM_GATEWAYS as readonly string[]).includes(gateway);
}

/** Read the admin-set platform credentials for a gateway (enabled rows only). */
export async function getPlatformGateway(
	gateway: string,
): Promise<PlatformGatewayRecord | null> {
	const db = getDb();
	const result = await db.execute({
		sql: `SELECT gateway, credentials, environment, enabled
          FROM platform_gateways
          WHERE gateway = ? AND enabled = 1`,
		args: [gateway],
	});
	if (result.rows.length === 0) return null;
	const row = result.rows[0] as Record<string, unknown>;
	let creds: Record<string, unknown>;
	try {
		creds = JSON.parse(decrypt(row.credentials as string));
	} catch (err) {
		logger.warn("Platform gateway credentials undecryptable", {
			gateway,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	return {
		gateway: String(row.gateway),
		credentials: creds,
		environment: String(row.environment ?? "sandbox"),
		enabled: Boolean(row.enabled),
	};
}

/**
 * Resolve the effective session JSON for a gateway, honoring the priority
 * order. Returns null when no session is configured at any level.
 */
export async function resolveSession(
	gateway: string,
	merchantId?: string,
): Promise<string | null> {
	const platform = await getPlatformGateway(gateway);
	if (platform && platform.credentials.session) {
		return platform.credentials.session as string;
	}

	// Merchant BYOK overrides platform env only when explicitly set.
	if (merchantId) {
		const { resolveGatewayConfig } = await import("../config/env");
		const m = (await resolveGatewayConfig(gateway, merchantId)) as Record<
			string,
			unknown
		>;
		if (m.session) return m.session as string;
	}

	const cfg = getConfig();
	if (gateway === "shopee" && cfg.SHOPEE_SESSION_JSON) return cfg.SHOPEE_SESSION_JSON;
	if (gateway === "gopay" && cfg.GOPAY_SESSION_JSON) return cfg.GOPAY_SESSION_JSON;
	return null;
}