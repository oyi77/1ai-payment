/**
 * OpenAPI /doc contract: every `security` ref must resolve to a defined
 * securityScheme (Sweep68 found 21 refs to a never-defined ApiKeyAuth),
 * and admin routes must declare AdminKeyAuth (X-Admin-Key), not ApiKeyAuth.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { resetConfigCache } from "../../src/config/env";

const TEST_DB = join(tmpdir(), `1pay-docsec-${Date.now()}.db`);

process.env.API_KEY = "test-api-key-docsec";
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = "test-admin-key-docsec";
process.env.ENCRYPTION_KEY =
	"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
resetConfigCache();

import { initDatabase } from "../../src/config/database";
import type { app as AppType } from "../../src/app";

let app: typeof AppType;

interface DocShape {
	paths: Record<
		string,
		Record<string, { security?: Array<Record<string, string[]>> }>
	>;
	components: {
		securitySchemes?: Record<string, { type: string; in: string; name: string }>;
	};
}

async function getDoc(): Promise<DocShape> {
	const res = await app.request("/doc");
	expect(res.status).toBe(200);
	return (await res.json()) as DocShape;
}

beforeAll(async () => {
	await initDatabase();
	({ app } = await import("../../src/app"));
});

afterAll(() => {
	try {
		rmSync(TEST_DB);
	} catch {}
});

describe("GET /doc security schemes", () => {
	test("defines ApiKeyAuth and AdminKeyAuth header schemes", async () => {
		const doc = await getDoc();
		const schemes = doc.components.securitySchemes ?? {};
		expect(schemes.ApiKeyAuth).toMatchObject({
			type: "apiKey",
			in: "header",
			name: "X-API-Key",
		});
		expect(schemes.AdminKeyAuth).toMatchObject({
			type: "apiKey",
			in: "header",
			name: "X-Admin-Key",
		});
	});

	test("every security ref resolves to a defined scheme", async () => {
		const doc = await getDoc();
		const defined = new Set(Object.keys(doc.components.securitySchemes ?? {}));
		const dangling: string[] = [];
		for (const [path, ops] of Object.entries(doc.paths)) {
			for (const [method, op] of Object.entries(ops)) {
				for (const req of op.security ?? []) {
					for (const name of Object.keys(req)) {
						if (!defined.has(name))
							dangling.push(`${method.toUpperCase()} ${path} -> ${name}`);
					}
				}
			}
		}
		expect(dangling).toEqual([]);
	});

	test("admin paths declare AdminKeyAuth, never ApiKeyAuth", async () => {
		const doc = await getDoc();
		const adminPaths = Object.keys(doc.paths).filter((p) =>
			p.includes("/admin/"),
		);
		expect(adminPaths.length).toBe(3);
		for (const p of adminPaths) {
			for (const op of Object.values(doc.paths[p])) {
				const names = (op.security ?? []).flatMap((s) => Object.keys(s));
				expect(names).toContain("AdminKeyAuth");
				expect(names).not.toContain("ApiKeyAuth");
			}
		}
	});

	test("every authed /api/* path declares ApiKeyAuth (Sweep110)", async () => {
		const doc = await getDoc();
		const PUBLIC = new Set(["/api/register", "/health"]);
		const missing: string[] = [];
		for (const [path, ops] of Object.entries(doc.paths)) {
			if (!path.startsWith("/api/") || PUBLIC.has(path)) continue;
			if (path.includes("/admin/")) continue; // AdminKeyAuth, covered above
			for (const [method, op] of Object.entries(ops)) {
				const names = (op.security ?? []).flatMap((s) => Object.keys(s));
				if (!names.includes("ApiKeyAuth"))
					missing.push(`${method.toUpperCase()} ${path}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
