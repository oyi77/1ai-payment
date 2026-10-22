/**
 * Gateway registry — maps gateway names to implementations.
 *
 * Adding a new gateway:
 * 1. Create directory src/gateways/<name>/
 * 2. Implement payment.ts, webhook.ts, index.ts
 * 3. Register in registry below
 * 4. Add webhook route in routes/webhook.ts
 */

import type { PaymentGateway } from "./base";
import { DuitkuGateway } from "./duitku";
import { ERC8183Gateway } from "./erc8183";
import { IPaymuGateway } from "./ipaymu";
import { LynkGateway } from "./lynk";
import { MidtransGateway } from "./midtrans";
import { MootaGateway } from "./moota";
import { MutasikuGateway } from "./mutasiku";
import { NowPaymentsGateway } from "./nowpayments";
import { PayPalGateway } from "./paypal";
import { SaweriaGateway } from "./saweria";
import { ScalevGateway } from "./scalev";
import { TelegramPaymentsGateway } from "./telegram-payments";
import { TelegramStarsGateway } from "./telegram-stars";
import { TripayGateway } from "./tripay";
import { X402Gateway } from "./x402";
import { XenditGateway } from "./xendit";

export type {
	PaymentGateway,
	NormalizedPaymentEvent,
	PaymentStatus,
	CreatePaymentParams,
	CreatePaymentResult,
	PaymentMethod,
} from "./base";

/**
 * Gateways that are registered but must NOT be advertised to merchants.
 *
 * "Registered" and "usable" are different states: a gateway can stay wired
 * (webhook + fulfillment + stored credentials keep resolving) while it cannot
 * take new payments. Scalev is parked because its business plan lapsed — every
 * storefront route returns 404 "Store not found" until the owner reactivates
 * it, even though the store, key, and variant all still exist.
 *
 * Parking a gateway here is the ONLY thing needed to hide it from
 * /api/gateways, /api/gateways/:name/methods, and the /health configured
 * count, and to make POST /api/payments return GATEWAY_UNAVAILABLE instead of
 * a misleading retryable error. Inbound webhooks keep working.
 */
export const PARKED_GATEWAYS: Record<string, string> = {
	scalev:
		"Scalev is temporarily unavailable: the storefront API requires an active business plan. Contact support to enable it.",
};

export function isGatewayParked(name: string): boolean {
	return Boolean(PARKED_GATEWAYS[name]);
}

const registry: Record<string, PaymentGateway> = {
	midtrans: new MidtransGateway(),
	tripay: new TripayGateway(),
	duitku: new DuitkuGateway(),
	nowpayments: new NowPaymentsGateway(),
	ipaymu: new IPaymuGateway(),
	scalev: new ScalevGateway(),
	xendit: new XenditGateway(),
	telegram_stars: new TelegramStarsGateway(),
	telegram_payments: new TelegramPaymentsGateway(),
	paypal: new PayPalGateway(),
	x402: new X402Gateway(),
	erc8183: new ERC8183Gateway(),
	saweria: new SaweriaGateway(),
	mutasiku: new MutasikuGateway(),
	moota: new MootaGateway(),
	lynk: new LynkGateway(),
};

// Snapshot of production gateways so tests can register fakes and restore.
const defaultRegistry: Record<string, PaymentGateway> = { ...registry };

export function getGateway(name: string): PaymentGateway | undefined {
	return registry[name];
}

export function getGatewayNames(): string[] {
	return Object.keys(registry);
}
/**
 * Register a gateway implementation at runtime. Primarily used by tests to
 * inject fake gateways (e.g. refund support) without network access.
 */

export function registerGateway(name: string, gateway: PaymentGateway): void {
	registry[name] = gateway;
}

/**
 * Restore the registry to its production snapshot. Call in test teardown so
 * fake gateways never leak across test files.
 */
export function resetGatewayRegistry(): void {
	for (const key of Object.keys(registry)) {
		delete registry[key];
	}
	Object.assign(registry, defaultRegistry);
}
