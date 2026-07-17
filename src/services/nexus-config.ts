/**
 * Nexus product configuration —
 * maps Scalev variant identifiers to product tiers with
 * Telegram channel IDs and subscription durations.
 *
 * Scalev sends webhook payloads that include order metadata.
 * We extract the variant from either:
 *   a) `items[0].variant_name` (if Scalev includes items array)
 *   b) `notes.variant` (if sent in checkout request)
 *
 * @todo verify real Scalev webhook payload structure with 1 test order
 *       and update variant name keys accordingly.
 */

import { getConfig } from "../config/env";

/** Subscription duration in days */
const DURATION_MAP: Record<string, number> = {
	monthly: 30,
	quarterly: 90,
	yearly: 365,
} as const;

export interface NexusProduct {
	tier: "signal_channel" | "auto_bot" | "nexus_terminal";
	label: string;
	durationDays: number;
}

/**
 * Parse NEXUS_VARIANT_MAP (JSON string from env, too large for a simple env var otherwise)
 * or fall back to defaults.
 *
 * Expected JSON shape:
 * ```json
 * {
 *   "Signal Channel": { "tier": "signal_channel", "duration": "monthly" },
 *   "Auto Bot":       { "tier": "auto_bot",       "duration": "monthly" },
 *   "Nexus Terminal": { "tier": "nexus_terminal", "duration": "monthly" }
 * }
 * ```
 */
function loadVariantMap(): Record<string, NexusProduct> {
	const raw = getConfig().NEXUS_VARIANT_MAP;
	if (!raw || raw === "{}") return getDefaultVariantMap();
	try {
		const map: Record<string, { tier: string; duration: string }> =
			JSON.parse(raw);
		const result: Record<string, NexusProduct> = {};
		for (const [variant, cfg] of Object.entries(map)) {
			const durationDays = DURATION_MAP[cfg.duration] ?? 30;
			result[variant] = {
				tier: cfg.tier as NexusProduct["tier"],
				label: variant,
				durationDays,
			};
		}
		return result;
	} catch {
		return getDefaultVariantMap();
	}
}

function getDefaultVariantMap(): Record<string, NexusProduct> {
	// keys must match `variant_name` from Scalev webhook payload
	return {
		"Bot Crypto": { tier: "auto_bot", label: "Auto Bot", durationDays: 30 },
		"Chanel Signal Crypto": {
			tier: "signal_channel",
			label: "Signal Channel",
			durationDays: 30,
		},
		"Nexus Data Intelegent": {
			tier: "nexus_terminal",
			label: "Nexus Terminal",
			durationDays: 30,
		},
	};
}

/** Lazy-loaded singleton */
let variantMap: Record<string, NexusProduct> | null = null;

export function getVariantMap(): Record<string, NexusProduct> {
	if (!variantMap) variantMap = loadVariantMap();
	return variantMap;
}

export function getProductByVariant(variantName: string): NexusProduct | null {
	return getVariantMap()[variantName] ?? null;
}

/**
 * Extract variant name from a Scalev webhook payload.
 *
 * Scalev payload structure is **not yet confirmed**.
 * This tries known patterns and falls back to a best guess.
 */
export function extractVariantFromPayload(
	payload: Record<string, unknown>,
): string | null {
	// Pattern A: items[0].variant_name
	const items = payload.items;
	if (Array.isArray(items) && items.length > 0) {
		const first = items[0];
		if (typeof first === "object" && first !== null) {
			const vn = (first as Record<string, unknown>).variant_name;
			if (typeof vn === "string" && vn) return vn;
			const name = (first as Record<string, unknown>).name;
			if (typeof name === "string" && name) return name;
		}
	}

	// Pattern B: notes.variant (echoed from checkout request)
	const notes = payload.notes;
	if (typeof notes === "object" && notes !== null) {
		const v = (notes as Record<string, unknown>).variant;
		if (typeof v === "string" && v) return v;
	}

	// Pattern C: metadata.variant
	const meta = payload.metadata;
	if (typeof meta === "object" && meta !== null) {
		const v = (meta as Record<string, unknown>).variant;
		if (typeof v === "string" && v) return v;
	}

	return null;
}
