/**
 * Unit tests for Nexus product config (Sweep83).
 *
 * Covers variant extraction patterns (items/name/notes/metadata), the
 * default map, env-map parsing incl. duration fallback + malformed JSON,
 * and the lazy-singleton reset.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resetConfigCache } from "../../src/config/env";
import {
	extractVariantFromPayload,
	getProductByVariant,
	getVariantMap,
	resetVariantMap,
} from "../../src/services/nexus-config";

const SAVED_ENV = { ...process.env };

function setEnv(map?: string) {
	for (const k of Object.keys(process.env)) delete process.env[k];
	process.env.API_KEY = "test-api-key-nexuscfg";
	process.env.ADMIN_API_KEY = "test-admin-key-nexuscfg";
	process.env.ENCRYPTION_KEY =
		"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
	process.env.NODE_ENV = "test";
	if (map !== undefined) process.env.NEXUS_VARIANT_MAP = map;
	resetConfigCache();
	resetVariantMap();
}

afterEach(() => {
	for (const k of Object.keys(process.env)) delete process.env[k];
	Object.assign(process.env, SAVED_ENV);
	resetConfigCache();
	resetVariantMap();
});

describe("extractVariantFromPayload", () => {
	test("pattern A: items[0].variant_name wins", () => {
		expect(
			extractVariantFromPayload({
				items: [{ variant_name: "V1", name: "N1" }],
			}),
		).toBe("V1");
	});

	test("pattern A fallback: items[0].name when variant_name missing", () => {
		expect(extractVariantFromPayload({ items: [{ name: "N1" }] })).toBe(
			"N1",
		);
	});

	test("pattern B: notes.variant", () => {
		expect(extractVariantFromPayload({ notes: { variant: "V2" } })).toBe(
			"V2",
		);
	});

	test("pattern C: metadata.variant", () => {
		expect(
			extractVariantFromPayload({ metadata: { variant: "V3" } }),
		).toBe("V3");
	});

	test("null when nothing matches (empty, wrong types, blank strings)", () => {
		expect(extractVariantFromPayload({})).toBeNull();
		expect(extractVariantFromPayload({ items: [] })).toBeNull();
		expect(extractVariantFromPayload({ items: [{ variant_name: "" }] })).toBeNull();
		expect(extractVariantFromPayload({ notes: "nope" })).toBeNull();
		expect(extractVariantFromPayload({ metadata: { variant: 42 } })).toBeNull();
	});
});

describe("variant map", () => {
	test("default map ships 3 products at 30 days", () => {
		setEnv();
		const map = getVariantMap();
		expect(Object.keys(map).sort()).toEqual(
			["Bot Crypto", "Channel Signal Crypto", "Nexus Data Intelligent"].sort(),
		);
		expect(getProductByVariant("Bot Crypto")).toMatchObject({
			tier: "auto_bot",
			durationDays: 30,
		});
		expect(getProductByVariant("Nope")).toBeNull();
	});

	test("env map parses durations, unknown duration falls back to 30", () => {
		setEnv(
			JSON.stringify({
				"My Variant": { tier: "auto_bot", duration: "yearly" },
				"Weird Variant": { tier: "signal_channel", duration: "fortnightly" },
			}),
		);
		expect(getProductByVariant("My Variant")).toMatchObject({
			tier: "auto_bot",
			label: "My Variant",
			durationDays: 365,
		});
		expect(getProductByVariant("Weird Variant")).toMatchObject({
			durationDays: 30,
		});
	});

	test("malformed JSON falls back to defaults", () => {
		setEnv("{not-json");
		expect(getProductByVariant("Bot Crypto")).not.toBeNull();
	});

	test("singleton caches until reset", () => {
		setEnv();
		const first = getVariantMap();
		process.env.NEXUS_VARIANT_MAP = JSON.stringify({
			"Late Variant": { tier: "auto_bot", duration: "monthly" },
		});
		resetConfigCache();
		// Stale cache: new env invisible until resetVariantMap
		expect(getProductByVariant("Late Variant")).toBeNull();
		expect(getVariantMap()).toBe(first);
		resetVariantMap();
		expect(getProductByVariant("Late Variant")).not.toBeNull();
	});
});
