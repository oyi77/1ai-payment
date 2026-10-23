/**
 * Contract tests for the served OpenAPI document at /doc.
 *
 * Code generators (SDKs, Postman, MCP tooling) key off operationId, tag and
 * server metadata. Hono emits none of those beyond what route files declare,
 * so the document is decorated in src/services/openapi-document.ts. These
 * tests pin the guarantees that decoration makes — they assert behaviour a
 * consumer observes on the wire, not the decorator's internals.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-openapi-doc-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-openapi-doc";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-openapi-doc";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";

resetConfigCache();

type Operation = Record<string, unknown>;

let app: { request: (input: string) => Promise<Response> };
let doc: {
	openapi: string;
	info: Record<string, unknown>;
	paths: Record<string, Record<string, Operation>>;
	tags: Array<{ name: string; description: string }>;
	servers: Array<{ url: string; description: string }>;
	components: Record<string, unknown>;
};

function operations(): Array<{
	method: string;
	path: string;
	operation: Operation;
}> {
	const out: Array<{ method: string; path: string; operation: Operation }> = [];
	for (const [path, item] of Object.entries(doc.paths)) {
		for (const [method, operation] of Object.entries(item)) {
			if (typeof operation !== "object" || operation === null) continue;
			out.push({ method, path, operation });
		}
	}
	return out;
}

beforeAll(async () => {
	const mod = await import("../../src/app");
	app = mod.app;
	const res = await app.request("/doc");
	expect(res.status).toBe(200);
	doc = await res.json();
});

afterAll(() => {
	try {
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	} catch {
		/* best-effort cleanup */
	}
});

describe("GET /doc contract", () => {
	test("serves an OpenAPI 3.1 document with routes and schemas", () => {
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.title).toBe("1ai-payment");
		expect(Object.keys(doc.paths).length).toBeGreaterThan(50);
		expect(operations().length).toBeGreaterThan(50);
		expect(Object.keys(doc.components)).toContain("schemas");
	});

	test("every operation carries a unique operationId", () => {
		const ops = operations();
		const ids = ops.map((entry) => entry.operation.operationId);
		expect(ids.filter((id) => typeof id !== "string" || id.length === 0)).toEqual(
			[],
		);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id as string).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
		}
	});

	test("operationIds are stable across repeated requests", async () => {
		const first = operations().map((e) => `${e.method} ${e.path} ${e.operation.operationId}`);
		const res = await app.request("/doc");
		const again = (await res.json()) as typeof doc;
		const second: string[] = [];
		for (const [path, item] of Object.entries(again.paths)) {
			for (const [method, operation] of Object.entries(item)) {
				if (typeof operation !== "object" || operation === null) continue;
				second.push(`${method} ${path} ${operation.operationId}`);
			}
		}
		expect(second.sort()).toEqual(first.sort());
	});

	test("canonical /webhook paths sort before the /webhooks alias", () => {
		const paths = Object.keys(doc.paths);
		const canonical = paths.filter((p) => /^\/webhook\/[a-z0-9_]+$/.test(p));
		const alias = paths.filter((p) => /^\/webhooks\/[a-z0-9_]+$/.test(p));
		expect(canonical.length).toBeGreaterThan(0);
		expect(alias.length).toBe(canonical.length);
		const lastCanonicalIndex = Math.max(
			...canonical.map((p) => paths.indexOf(p)),
		);
		const firstAliasIndex = Math.min(...alias.map((p) => paths.indexOf(p)));
		expect(lastCanonicalIndex).toBeLessThan(firstAliasIndex);
	});

	test("tags are ordered, documented and cover every operation", () => {
		expect(doc.tags.length).toBeGreaterThan(0);
		expect(doc.tags[0].name).toBe("Payments");
		for (const tag of doc.tags) {
			expect(tag.description.length).toBeGreaterThan(0);
		}
		const declared = new Set(doc.tags.map((t) => t.name));
		const used = new Set<string>();
		for (const { operation } of operations()) {
			const tags = operation.tags;
			if (!Array.isArray(tags)) continue;
			for (const tag of tags) used.add(tag as string);
		}
		expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
	});

	test("declares the public production server first", () => {
		expect(doc.servers.length).toBeGreaterThan(0);
		expect(doc.servers[0].url).toMatch(/^https:\/\//);
		expect(doc.servers[0].description.length).toBeGreaterThan(0);
	});
});
