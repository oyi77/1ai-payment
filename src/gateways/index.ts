/**
 * Gateway registry — maps gateway names to implementations.
 *
 * Adding a new gateway:
 * 1. Create directory src/gateways/<name>/
 * 2. Implement payment.ts, webhook.ts, index.ts
 * 3. Register in registry below
 * 4. Add webhook route in routes/webhook.ts
 */

import type { PaymentGateway } from './base';
import { MidtransGateway } from './midtrans';
import { TripayGateway } from './tripay';
import { DuitkuGateway } from './duitku';
import { NowPaymentsGateway } from './nowpayments';
import { IPaymuGateway } from './ipaymu';
import { ScalevGateway } from './scalev';
import { XenditGateway } from './xendit';
import { TelegramStarsGateway } from './telegram-stars';
import { TelegramPaymentsGateway } from './telegram-payments';
import { PayPalGateway } from './paypal';

export type { PaymentGateway, NormalizedPaymentEvent, PaymentStatus, CreatePaymentParams, CreatePaymentResult, PaymentMethod } from './base';

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
};

export function getGateway(name: string): PaymentGateway | undefined {
  return registry[name];
}

export function getGatewayNames(): string[] {
  return Object.keys(registry);
}

export function isGatewayConfigured(name: string): boolean {
  return name in registry;
}