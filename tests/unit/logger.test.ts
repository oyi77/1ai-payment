/**
 * Unit tests for upstreamPreview (Sweep148).
 *
 * Upstream 4xx/5xx bodies are echoed for debuggability, but a full dump
 * can carry echoed request material. Preview caps at 200 chars.
 */
import { describe, expect, test } from "bun:test";
import { UPSTREAM_ERROR_PREVIEW, upstreamPreview } from "../../src/utils/logger";

describe("upstreamPreview", () => {
	test("short bodies pass through unchanged", () => {
		expect(upstreamPreview("Bad request")).toBe("Bad request");
	});

	test("long bodies truncate at the preview limit", () => {
		const body = "x".repeat(UPSTREAM_ERROR_PREVIEW + 50);
		const out = upstreamPreview(body);
		expect(out.length).toBeLessThan(body.length);
		expect(out).toContain("[truncated]");
		expect(out.startsWith("x".repeat(UPSTREAM_ERROR_PREVIEW))).toBe(true);
	});

	test("exact-limit body is unchanged (no marker)", () => {
		const body = "y".repeat(UPSTREAM_ERROR_PREVIEW);
		expect(upstreamPreview(body)).toBe(body);
	});
});
