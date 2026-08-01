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
import { MidtransGateway } from "./midtrans";
import { NowPaymentsGateway } from "./nowpayments";
import { PayPalGateway } from "./paypal";
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
};

// Snapshot of production gateways so tests can register fakes and restore.
const defaultRegistry: Record<string, PaymentGateway> = { ...registry };

export function getGateway(name: string): PaymentGateway | undefined {
	return registry[name];
}

export function getGatewayNames(): string[] {
	return Object.keys(registry);
}

export function isGatewayConfigured(name: string): boolean {
	return name in registry;
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
