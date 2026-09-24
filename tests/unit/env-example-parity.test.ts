/**
 * .env.example parity test (Sweep147).
 *
 * Every env var consumed via required()/optional()/bool() in
 * src/config/env.ts must be documented in .env.example, and every key in
 * .env.example must be consumed (no dead aspirational keys, no undocumented
 * vars a fresh deploy would miss). Pure file-text comparison — no config
 * import, no DB, no env mutation.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_TS = join(import.meta.dir, "../../src/config/env.ts");
const EXAMPLE = join(import.meta.dir, "../../.env.example");

function consumedKeys(): Set<string> {
	const src = readFileSync(ENV_TS, "utf8");
	const out = new Set<string>();
	for (const m of src.matchAll(/(?:required|optional|bool)\(\s*"([A-Z0-9_]+)"/g)) {
		out.add(m[1]);
	}
	return out;
}

function exampleKeys(): Set<string> {
	const out = new Set<string>();
	for (const line of readFileSync(EXAMPLE, "utf8").split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#") || !t.includes("=")) continue;
		out.add(t.split("=")[0].trim());
	}
	return out;
}

describe(".env.example parity (Sweep147)", () => {
	test("every consumed var is documented", () => {
		const missing = [...consumedKeys()].filter((k) => !exampleKeys().has(k));
		expect(missing).toEqual([]);
	});

	test("no dead keys in .env.example", () => {
		const dead = [...exampleKeys()].filter((k) => !consumedKeys().has(k));
		expect(dead).toEqual([]);
	});

	test("parity set is non-trivial (guard against empty-file false pass)", () => {
		expect(consumedKeys().size).toBeGreaterThan(50);
	});
});
