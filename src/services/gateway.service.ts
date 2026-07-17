/**
 * Gateway service — registry lookup, health status, and methods listing.
 */

import { getGatewayConfig } from "../config/env";
import { getGateway, getGatewayNames, isGatewayConfigured } from "../gateways";
import type { PaymentGateway, PaymentMethod } from "../gateways/base";

export { getGateway, getGatewayNames, isGatewayConfigured };

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
				configured: Boolean(config.apiKey),
			};
		} catch {
			result[name] = { name, configured: false };
		}
	}

	return result;
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
