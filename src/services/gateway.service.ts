/**
 * Gateway service — registry lookup, health status, and methods listing.
 */

import { getConfig, getGatewayConfig } from "../config/env";
import {
	PARKED_GATEWAYS,
	getGateway,
	getGatewayNames,
	isGatewayParked,
} from "../gateways";
import type { PaymentGateway, PaymentMethod } from "../gateways/base";

export { getGateway, getGatewayNames };

export interface GatewayStatus {
	name: string;
	configured: boolean;
}

export interface GatewayInfo {
	gateway: string;
	enabled: boolean;
	currencies: string[];
	methods: PaymentMethod[];
}

export function getGatewayHealth(): Record<string, GatewayStatus> {
	const names = getGatewayNames();
	const result: Record<string, GatewayStatus> = {};

	for (const name of names) {
		try {
			const config = getGatewayConfig(name);
			// A parked gateway keeps its credentials but cannot transact, so
			// reporting it configured would overstate readiness (health is the
			// public readiness signal).
			result[name] = {
				name,
				configured: !isGatewayParked(name) && isConfigured(name, config),
			};
		} catch {
			result[name] = { name, configured: false };
		}
	}

	return result;
}

// A gateway counts as configured only when the credentials it actually needs
// are set. Aggregators (mutasiku/moota) additionally need their webhook
// secret: an API key alone cannot verify a callback, so reporting them
// configured would advertise a gateway whose webhooks all fail closed.
function isConfigured(name: string, config: unknown): boolean {
	const cfg = config as Record<string, unknown>;
	switch (name) {
		case "lynk":
			return Boolean(cfg.merchantKey);
		case "scalev":
			return Boolean(cfg.storefrontApiKey && cfg.storeId);
		case "telegram_stars":
		case "telegram_payments":
			return Boolean(cfg.botToken && cfg.webhookSecret);
		case "paypal":
			return Boolean(cfg.clientId && cfg.clientSecret && cfg.webhookId);
		case "mutasiku":
		case "moota":
			return Boolean(cfg.apiKey && cfg.webhookSecret);
		case "x402":
			return Boolean(cfg.walletAddress && cfg.usdcAddress);
		case "erc8183":
			return Boolean(cfg.walletAddress && cfg.tokenAddress);
		case "saweria":
			return Boolean(cfg.username && cfg.userId);
		default:
			return Boolean(cfg.apiKey);
	}
}

export function getAvailableGateways(): GatewayInfo[] {
	const names = getGatewayNames();
	const health = getGatewayHealth();

	return names.map((name) => {
		const gateway = getGateway(name);
		const methods = gateway?.getPaymentMethods() ?? [];

		// Collect unique currencies from all methods
		const currencies = [...new Set(methods.flatMap((m) => m.currencies))];

		return {
			gateway: name,
			enabled: health[name]?.configured ?? false,
			currencies,
			methods,
		};
	});
}

/**
 * Gateways a merchant may actually select.
 *
 * PARKED_GATEWAY_MODE decides how parked gateways appear:
 * - "hidden" (default): omitted entirely.
 * - "listed": included but forced to enabled:false, so the gateway is
 *   discoverable while making clear it cannot be used.
 * Creation is refused either way (GATEWAY_UNAVAILABLE).
 */
export function getSelectableGateways(): GatewayInfo[] {
	const mode = getConfig().PARKED_GATEWAY_MODE;
	if (mode === "listed") {
		return getAvailableGateways().map((g) =>
			isGatewayParked(g.gateway) ? { ...g, enabled: false } : g,
		);
	}
	return getAvailableGateways().filter((g) => !isGatewayParked(g.gateway));
}

export function getGatewayMethods(name: string): GatewayInfo | undefined {
	const gateway = getGateway(name);
	if (!gateway) return undefined;

	const health = getGatewayHealth();
	const methods = gateway.getPaymentMethods();
	const currencies = [...new Set(methods.flatMap((m) => m.currencies))];

	return {
		gateway: name,
		enabled: !isGatewayParked(name) && (health[name]?.configured ?? false),
		currencies,
		methods,
	};
}

export { PARKED_GATEWAYS };
export { getGatewayConfigForMerchant } from "../config/env";
