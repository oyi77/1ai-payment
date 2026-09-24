/**
 * Rate limiter tests (Sweep78).
 *
 * The limiter is fully bypassed under NODE_ENV=test (shared-suite stability),
 * so these tests drive the factory directly with stub contexts and a
 * non-test NODE_ENV around factory creation only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetConfigCache } from "../../src/config/env";
import { rateLimitMiddleware } from "../../src/middleware/rate-limit";

const SAVED_ENV = { ...process.env };

// Per-test env isolation (cors.test.ts pattern): the Bun suite shares ONE
// process, so module-scope env mutation would leak NODE_ENV=development
// into co-running files (killing their limiter bypass + config re-read).
beforeEach(() => {
	for (const k of Object.keys(process.env)) delete process.env[k];
	process.env.API_KEY = "test-api-key-ratelimit";
	process.env.ADMIN_API_KEY = "test-admin-key-ratelimit";
	process.env.ENCRYPTION_KEY =
		"f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f";
	process.env.NODE_ENV = "development";
	resetConfigCache();
});

afterEach(() => {
	for (const k of Object.keys(process.env)) delete process.env[k];
	Object.assign(process.env, SAVED_ENV);
	resetConfigCache();
});

interface StubCtx {
	headers: Record<string, string>;
	store: Record<string, string>;
	env: unknown;
	resHeaders: Record<string, string>;
	jsonBody: unknown;
	jsonStatus: number | null;
	get(k: string): string | undefined;
	req: {
		header(n: string): string | undefined;
		raw: unknown;
	};
	header(k: string, v: string): void;
	json(o: unknown, s: number): { status: number; body: unknown };
}

function stubCtx(
	headers: Record<string, string> = {},
	store: Record<string, string> = {},
	env: unknown = undefined,
): StubCtx {
	const ctx: StubCtx = {
		headers,
		store,
		env,
		resHeaders: {},
		jsonBody: null,
		jsonStatus: null,
		get(k: string) {
			return ctx.store[k];
		},
		req: {
			header(n: string) {
				const low = n.toLowerCase();
				for (const [k, v] of Object.entries(ctx.headers)) {
					if (k.toLowerCase() === low) return v;
				}
				return undefined;
			},
			raw: {},
		},
		header(k: string, v: string) {
			ctx.resHeaders[k] = v;
		},
		json(o: unknown, s: number) {
			ctx.jsonBody = o;
			ctx.jsonStatus = s;
			return { status: s, body: o };
		},
	};
	return ctx;
}

async function run(
	handler: (c: never, n: () => Promise<void>) => Promise<unknown>,
	ctx: StubCtx,
): Promise<{ nexted: boolean }> {
	let nexted = false;
	await handler(ctx as never, async () => {
		nexted = true;
	});
	return { nexted };
}

describe("rateLimitMiddleware", () => {
	test("allows max requests then 429s with Retry-After and envelope", async () => {
		const handler = rateLimitMiddleware({ windowMs: 60_000, max: 2 });
		const mk = () => stubCtx({}, { merchantId: "merch_rl_a" });
		expect((await run(handler, mk())).nexted).toBe(true);
		expect((await run(handler, mk())).nexted).toBe(true);
		const third = mk();
		expect((await run(handler, third)).nexted).toBe(false);
		expect(third.jsonStatus).toBe(429);
		expect(third.resHeaders["Retry-After"]).toBeDefined();
		expect(third.jsonBody).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
	});

	test("plan tier overrides options.max (free=30 beats max=2)", async () => {
		const handler = rateLimitMiddleware({ windowMs: 60_000, max: 2 });
		const mk = () =>
			stubCtx({}, { merchantId: "merch_rl_plan", merchantPlan: "free" });
		for (let i = 0; i < 3; i++) {
			expect((await run(handler, mk())).nexted).toBe(true);
		}
	});

	test("unknown plan falls back to options.max", async () => {
		const handler = rateLimitMiddleware({ windowMs: 60_000, max: 2 });
		const mk = () =>
			stubCtx({}, { merchantId: "merch_rl_unknown", merchantPlan: "nope" });
		expect((await run(handler, mk())).nexted).toBe(true);
		expect((await run(handler, mk())).nexted).toBe(true);
		expect((await run(handler, mk())).nexted).toBe(false);
	});

	test("window expiry resets the bucket", async () => {
		// Deterministic clock: fake timers advance Date.now + the eviction
		// timer together, so no real 60ms wait and no wall-clock flake.
		const { vi } = await import("bun:test");
		vi.useFakeTimers();
		try {
			const handler = rateLimitMiddleware({ windowMs: 40, max: 1 });
			const mk = () => stubCtx({}, { merchantId: "merch_rl_win" });
			expect((await run(handler, mk())).nexted).toBe(true);
			expect((await run(handler, mk())).nexted).toBe(false);
			vi.advanceTimersByTime(60);
			expect((await run(handler, mk())).nexted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("IP fallback buckets per CF-Connecting-IP", async () => {
		const handler = rateLimitMiddleware({ windowMs: 60_000, max: 1 });
		const a = () => stubCtx({ "CF-Connecting-IP": "1.2.3.4" });
		const b = () => stubCtx({ "CF-Connecting-IP": "5.6.7.8" });
		expect((await run(handler, a())).nexted).toBe(true);
		expect((await run(handler, a())).nexted).toBe(false);
		expect((await run(handler, b())).nexted).toBe(true);
	});

	test("socket IP via c.env.server buckets per address (Sweep144)", async () => {
		// Contract with src/index.ts: Bun.serve passes { server } as app env,
		// so headerless direct requests key by true socket address instead
		// of sharing one "unknown" bucket. socketIp() closes over the
		// address the same way Bun's server.requestIP(req) does.
		const socketEnv = (address: string) => ({
			server: { requestIP: (_req: unknown) => ({ address }) },
		});
		const handler = rateLimitMiddleware({ windowMs: 60_000, max: 1 });
		const a = () => stubCtx({}, {}, socketEnv("9.9.9.9"));
		const b = () => stubCtx({}, {}, socketEnv("8.8.8.8"));
		expect((await run(handler, a())).nexted).toBe(true);
		expect((await run(handler, a())).nexted).toBe(false);
		expect((await run(handler, b())).nexted).toBe(true);
	});

	test("headerless requests without server env share the unknown bucket (Sweep144)", async () => {
		// Documents the fallback: no header + no server (e.g. app.fetch in
		// tests without env) can only key "unknown". Production always has
		// either CF-Connecting-IP (tunnel) or server.requestIP (index.ts).
		const handler = rateLimitMiddleware({ windowMs: 60_000, max: 1 });
		expect((await run(handler, stubCtx())).nexted).toBe(true);
		expect((await run(handler, stubCtx())).nexted).toBe(false);
	});

	test("TRUST_PROXY honors leftmost X-Forwarded-For hop", async () => {
		process.env.TRUST_PROXY = "true";
		resetConfigCache();
		try {
			const handler = rateLimitMiddleware({ windowMs: 60_000, max: 1 });
			const a = () => stubCtx({ "X-Forwarded-For": "9.9.9.9, 1.1.1.1" });
			const b = () => stubCtx({ "X-Forwarded-For": "8.8.8.8" });
			expect((await run(handler, a())).nexted).toBe(true);
			expect((await run(handler, a())).nexted).toBe(false);
			expect((await run(handler, b())).nexted).toBe(true);
		} finally {
			delete process.env.TRUST_PROXY;
			resetConfigCache();
		}
	});
});
