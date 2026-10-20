/**
 * Gateway service — registry lookup, health status, and methods listing.
 */

import { getGatewayConfig } from "../config/env";
import { getGateway, getGatewayNames } from "../gateways";
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
			result[name] = {
				name,
				configured: isConfigured(name, config),
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

export function getGatewayMethods(name: string): GatewayInfo | undefined {
	const gateway = getGateway(name);
	if (!gateway) return undefined;

	const health = getGatewayHealth();
	const methods = gateway.getPaymentMethods();
	const currencies = [...new Set(methods.flatMap((m) => m.currencies))];

	return {
		gateway: name,
		enabled: health[name]?.configured ?? false,
		currencies,
		methods,
	};
}

export { getGatewayConfigForMerchant } from "../config/env";
