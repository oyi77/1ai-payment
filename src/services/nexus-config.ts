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
 * NOTE (ops): Scalev integration is parked — quota exhausted, dashboard form
 * removed. Variant keys below are best-effort until a real test order exists.
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
	// Short variant keys; getProductByVariant also matches Scalev's composed
	// "<Product> - <Variant>" names by suffix, so renames keep working.
	return {
		"Bot Crypto": { tier: "auto_bot", label: "Auto Bot", durationDays: 30 },
		"Channel Signal Crypto": {
			tier: "signal_channel",
			label: "Signal Channel",
			durationDays: 30,
		},
		"Nexus Data Intelligent": {
			tier: "nexus_terminal",
			label: "Nexus Terminal",
			durationDays: 30,
		},
	};
}

/** Lazy-loaded singleton */
let variantMap: Record<string, NexusProduct> | null = null;

/** Reset the cached map. Used in tests so NEXUS_VARIANT_MAP changes apply. */
export function resetVariantMap(): void {
	variantMap = null;
}

export function getVariantMap(): Record<string, NexusProduct> {
	if (!variantMap) variantMap = loadVariantMap();
	return variantMap;
}

/**
 * Lowercase, strip diacritics, collapse punctuation/whitespace to single
 * spaces. Scalev composes variant names as "<Product> - <Variant>", so the
 * separators around the variant suffix must not affect matching.
 */
function normalizeVariantKey(value: string): string {
	return (
		value
			.normalize("NFKD")
			.replace(/\p{Diacritic}/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim()
			// Historical spellings that exist in live Scalev data and in older
			// NEXUS_VARIANT_MAP values. Folding them keeps existing paid orders
			// resolvable after the keys were corrected.
			.replace(/\bchanel\b/g, "channel")
			.replace(/\bintelegent\b/g, "intelligent")
	);
}

/**
 * Resolve a product from a Scalev variant name.
 *
 * Scalev sends the FULL composed name ("Vilona Crypto Trading Assistant -
 * Bot Crypto"), while operators configure short keys ("Bot Crypto"). Exact
 * matching alone therefore never fired for real traffic. Resolution order:
 *
 *   1. exact key match (keeps any existing full-name config working)
 *   2. normalized equality ("Intelegent" vs "Intelligent" aside, spacing and
 *      punctuation differences collapse)
 *   3. normalized suffix match ("<anything> - <key>")
 *
 * Returns null when nothing matches or when a suffix matches more than one
 * product — guessing between tiers would grant the wrong access, so an
 * ambiguous name fails closed instead.
 */
export function getProductByVariant(variantName: string): NexusProduct | null {
	const map = getVariantMap();
	if (map[variantName]) return map[variantName];

	const target = normalizeVariantKey(variantName);
	if (!target) return null;

	const entries = Object.entries(map);
	for (const [key, product] of entries) {
		if (normalizeVariantKey(key) === target) return product;
	}

	const suffixMatches = entries.filter(([key]) => {
		const normalizedKey = normalizeVariantKey(key);
		return normalizedKey.length > 0 && target.endsWith(` ${normalizedKey}`);
	});
	return suffixMatches.length === 1 ? suffixMatches[0][1] : null;
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
