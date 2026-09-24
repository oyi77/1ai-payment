/**
 * Unit tests for Sweep41 env externalization:
 * TRUST_PROXY (bool, default false) and ERC8183_EVALUATOR_PUBLIC_KEY
 * (legacy alias — ADDRESS wins when both set).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getConfig, resetConfigCache } from "../../src/config/env";

const SAVED = { ...process.env };

beforeEach(() => {
	for (const k of Object.keys(process.env)) delete process.env[k];
	process.env.API_KEY = "test-api-key";
	process.env.ADMIN_API_KEY = "test-admin-key";
	process.env.ENCRYPTION_KEY =
		"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
});

afterEach(() => {
	for (const k of Object.keys(process.env)) delete process.env[k];
	Object.assign(process.env, SAVED);
	resetConfigCache();
});

describe("TRUST_PROXY externalization", () => {
	test("defaults to false when unset", () => {
		resetConfigCache();
		expect(getConfig().TRUST_PROXY).toBe(false);
	});

	test("parses true/1/yes as true, other values as false", () => {
		for (const v of ["true", "1", "yes", "TRUE"]) {
			process.env.TRUST_PROXY = v;
			resetConfigCache();
			expect(getConfig().TRUST_PROXY).toBe(true);
		}
		for (const v of ["false", "0", "no", ""]) {
			process.env.TRUST_PROXY = v;
			resetConfigCache();
			expect(getConfig().TRUST_PROXY).toBe(false);
		}
	});
});

describe("ERC8183_EVALUATOR_PUBLIC_KEY alias", () => {
	test("defaults to empty string when unset", () => {
		resetConfigCache();
		expect(getConfig().ERC8183_EVALUATOR_PUBLIC_KEY).toBe("");
	});

	test("reflects the env value when set", () => {
		process.env.ERC8183_EVALUATOR_PUBLIC_KEY = "0xabc";
		resetConfigCache();
		expect(getConfig().ERC8183_EVALUATOR_PUBLIC_KEY).toBe("0xabc");
	});
});

describe("evaluator alias precedence (ADDRESS wins)", () => {
	test("PUBLIC_KEY alone authenticates when ADDRESS unset", async () => {
		const { privateKeyToAccount } = await import("viem/accounts");
		const { ERC8183Gateway } = await import("../../src/gateways/erc8183");
		const { buildAttestationMessage } = await import(
			"../../src/gateways/erc8183/webhook"
		);
		const { resetConfigCache } = await import("../../src/config/env");
		const signer = privateKeyToAccount(`0x${"33".repeat(32)}`);
		delete process.env.ERC8183_EVALUATOR_ADDRESS;
		process.env.ERC8183_EVALUATOR_PUBLIC_KEY = signer.address;
		resetConfigCache();
		const gw = new ERC8183Gateway();
		const signature = await signer.signMessage({
			message: buildAttestationMessage({
				escrowId: "escrow_alias_1",
				evaluator: signer.address,
				approved: true,
				notes: null,
			}),
		});
		const result = await gw.verifySignature(
			{
				escrow_id: "escrow_alias_1",
				evaluator: signer.address,
				approved: true,
				signature,
			},
			{},
		);
		expect(result).toBe(true);
		delete process.env.ERC8183_EVALUATOR_PUBLIC_KEY;
		resetConfigCache();
	});
	test("ADDRESS wins when both set (alias signature rejected)", async () => {
		const { privateKeyToAccount } = await import("viem/accounts");
		const { ERC8183Gateway } = await import("../../src/gateways/erc8183");
		const { buildAttestationMessage } = await import(
			"../../src/gateways/erc8183/webhook"
		);
		const { resetConfigCache } = await import("../../src/config/env");
		const addrSigner = privateKeyToAccount(`0x${"44".repeat(32)}`);
		const aliasSigner = privateKeyToAccount(`0x${"55".repeat(32)}`);
		process.env.ERC8183_EVALUATOR_ADDRESS = addrSigner.address;
		process.env.ERC8183_EVALUATOR_PUBLIC_KEY = aliasSigner.address;
		resetConfigCache();
		const gw = new ERC8183Gateway();
		const sig = await aliasSigner.signMessage({
			message: buildAttestationMessage({
				escrowId: "escrow_alias_2",
				evaluator: aliasSigner.address,
				approved: true,
				notes: null,
			}),
		});
		const result = await gw.verifySignature(
			{
				escrow_id: "escrow_alias_2",
				evaluator: aliasSigner.address,
				approved: true,
				signature: sig,
			},
			{},
		);
		expect(result).toBe(false);
		delete process.env.ERC8183_EVALUATOR_ADDRESS;
		delete process.env.ERC8183_EVALUATOR_PUBLIC_KEY;
		resetConfigCache();
	});
});

describe(".env.example completeness", () => {
	test("every key consumed by env.ts is documented in .env.example", async () => {
		const { readFileSync } = await import("node:fs");
		const { join, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
		const envTs = readFileSync(join(root, "src", "config", "env.ts"), "utf8");
		const example = readFileSync(join(root, ".env.example"), "utf8");
		const consumed = new Set<string>();
		for (const m of envTs.matchAll(/(?:required|optional|bool)\("([A-Z_]+)"/g)) {
			consumed.add(m[1]);
		}
		expect(consumed.size).toBeGreaterThan(30);
		const exampleKeys = new Set<string>();
		for (const m of example.matchAll(/^([A-Z_]+)=/gm)) {
			exampleKeys.add(m[1]);
		}
		const missing = [...consumed].filter((k) => !exampleKeys.has(k));
		expect(missing).toEqual([]);
	});
});
