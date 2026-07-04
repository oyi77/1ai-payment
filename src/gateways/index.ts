/**
 * Gateway registry — maps gateway names to implementations.
 *
 * Adding a new gateway:
 * 1. Implement PaymentGateway interface
 * 2. Add to registry below
 * 3. Add webhook route in routes/webhook.ts
 */

import type { PaymentGateway } from './base';
import { MidtransGateway } from './midtrans';
import { TripayGateway } from './tripay';
import { DuitkuGateway } from './duitku';
import { NowPaymentsGateway } from './nowpayments';
import { IPaymuGateway } from './ipaymu';
import { ScalevGateway } from './scalev';
import { XenditGateway } from './xendit';

export type { PaymentGateway, NormalizedPaymentEvent, PaymentStatus, CreatePaymentParams, CreatePaymentResult, PaymentMethod } from './base';

const registry: Record<string, PaymentGateway> = {
  midtrans: new MidtransGateway(),
  tripay: new TripayGateway(),
  duitku: new DuitkuGateway(),
  nowpayments: new NowPaymentsGateway(),
  ipaymu: new IPaymuGateway(),
  scalev: new ScalevGateway(),
  xendit: new XenditGateway(),
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