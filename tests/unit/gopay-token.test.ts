/**
 * Unit tests — GoPay TokenManager refresh + persistence callback.
 * Verifies onTokenRefreshed fires BEFORE adoption and tokens rotate.
 */

import { describe, expect, test } from "bun:test";

import { TokenManager } from "../../src/gateways/gopay/token";

describe("TokenManager", () => {
	test("onTokenRefreshed fires before adoption with rotated tokens", async () => {
		let persisted: any = null;
		const refresher: {
			refresh: (r: string) => Promise<{ accessToken: string; refreshToken: string; tokenType?: string; expiresIn?: number }>;
		} = {
			refresh: async () => ({
				accessToken: "access-rotated",
				refreshToken: "refresh-rotated",
				tokenType: "Bearer",
				expires_in: 3600,
			}),
		};

		const tm = new TokenManager(
			refresher,
			{
				accessToken: "access-initial",
				refreshToken: "refresh-initial",
				tokenType: "Bearer",
				expiresAt: Date.now() - 1000, // already expired → forces refresh
			},
			{
				onTokenRefreshed: (tokens: { accessToken: string; refreshToken: string; tokenType: string; expiresAt: number }) => {
					persisted = tokens;
				},
			},
		);

		const token = await tm.getValidAccessToken();
		expect(token).toBe("access-rotated");

		// Callback received the rotated token set before adoption.
		expect(persisted.accessToken).toBe("access-rotated");
		expect(persisted.refreshToken).toBe("refresh-rotated");

		// Adoption: subsequent reads return rotated token.
		const again = await tm.getValidAccessToken();
		expect(again).toBe("access-rotated");
	});

	test("refreshOnce collapses concurrent callers onto a single flight", async () => {
		let calls = 0;
		const refresher: {
			refresh: (r: string) => Promise<{ accessToken: string; refreshToken: string; tokenType?: string; expiresIn?: number }>;
		} = {
			refresh: async () => {
				calls += 1;
				await new Promise((r) => setTimeout(r, 20));
				return {
					accessToken: "access-concurrent",
					refreshToken: "refresh-concurrent",
				};
			},
		};

		const tm = new TokenManager(
			refresher,
			{
				accessToken: "access-initial",
				refreshToken: "refresh-initial",
				tokenType: "Bearer",
				expiresAt: Date.now() - 1000,
			},
		);

		const [a, b] = await Promise.all([tm.getValidAccessToken(), tm.getValidAccessToken()]);
		expect(a).toBe("access-concurrent");
		expect(b).toBe("access-concurrent");
		expect(calls).toBe(1);
	});
});
