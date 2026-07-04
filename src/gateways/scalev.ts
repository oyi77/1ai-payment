/**
 * Scalev payment gateway implementation.
 *
 * IMPORTANT: Scalev is a HEADLESS COMMERCE PLATFORM, not a simple payment gateway.
 * It requires:
 * 1. A Scalev store with products/variants configured
 * 2. Storefront API key (sfpk_...) - different from business API key
 * 2. Products/variants configured in Scalev dashboard
 * 3. Checkout uses variant_id from Scalev product variants
 *
 * Endpoint: POST /v3/stores/{store_id}/public/checkout
 * Auth: X-Scalev-Storefront-Api-Key header
 * Docs: https://docs.scalev.com
 */

import crypto from 'crypto';
import { getConfig } from '../config/env';
import { logger } from '../utils/logger';
import { GatewayError } from '../utils/errors';
import type {
  PaymentGateway,
  NormalizedPaymentEvent,
  PaymentStatus,
  CreatePaymentParams,
  CreatePaymentResult,
  PaymentMethod,
} from './base';

interface ScalevCheckoutItem {
  type: 'variant';
  variant_id: number;
  quantity: number;
}

interface ScalevCheckoutRequest {
  customer_name: string;
  customer_email: string;
  customer_phone?: string;
  shipping_address?: string;
  shipping_province?: string;
  shipping_city?: string;
  shipping_subdistrict?: string;
  shipping_postal_code?: string;
  shipping_location_id?: string | number;
  payment_method: string;
  sub_payment_method?: string;
  courier_service_id?: number;
  warehouse_unique_id?: string;
  courier_aggregator_code?: string;
  discount_code_code?: string;
  notes?: string;
  items: ScalevCheckoutItem[];
}

interface ScalevCheckoutResponse {
  id: string;
  secret_slug: string;
  status: string;
  customer_name: string;
  customer_email: string;
  total_amount: number;
  currency: string;
  payment_method: string;
  payment_url: string;
  expired_at: string;
}

const BASE_URL = 'https://api.scalev.com';

export class ScalevGateway implements PaymentGateway {
  readonly name = 'scalev';

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    const config = getConfig();
    
    if (!config.SCALEV_STOREFRONT_API_KEY) {
      throw new GatewayError('scalev', 'SCALEV_STOREFRONT_API_KEY not configured');
    }
    if (!config.SCALEV_STORE_ID) {
      throw new GatewayError('scalev', 'SCALEV_STORE_ID not configured');
    }
    if (!config.SCALEV_VARIANT_ID) {
      throw new GatewayError('scalev', 'SCALEV_VARIANT_ID not configured (need a product variant from Scalev dashboard)');
    }

    const baseUrl = config.SCALEV_ENVIRONMENT === 'production' ? BASE_URL : BASE_URL;

    const items: ScalevCheckoutItem[] = [
      {
        type: 'variant',
        variant_id: Number(config.SCALEV_VARIANT_ID),
        quantity: 1,
      },
    ];

    const body: ScalevCheckoutRequest = {
      customer_name: params.customerName || 'Customer',
      customer_email: params.customerEmail || 'customer@example.com',
      payment_method: params.paymentMethod || 'bank_transfer',
      items,
    };

    const response = await fetch(`${baseUrl}/v3/stores/${config.SCALEV_STORE_ID}/public/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scalev-Storefront-Api-Key': config.SCALEV_STOREFRONT_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Scalev checkout failed', { status: response.status, error });
      throw new GatewayError('scalev', `Checkout failed: ${response.status} ${error}`);
    }

    const result = (await response.json()) as ScalevCheckoutResponse;

    return {
      gatewayReference: result.id,
      paymentUrl: result.payment_url || `https://checkout.scalev.com/${result.secret_slug}`,
      expiresAt: result.expired_at ? new Date(result.expired_at).toISOString() : undefined,
    };
  }

  getPaymentMethods(): PaymentMethod[] {
    return [
      { code: 'bank_transfer', name: 'Bank Transfer (All Banks)', currencies: ['IDR'] },
      { code: 'qris', name: 'QRIS', currencies: ['IDR'] },
      { code: 'gopay', name: 'GoPay', currencies: ['IDR'] },
      { code: 'shopeepay', name: 'ShopeePay', currencies: ['IDR'] },
      { code: 'dana', name: 'DANA', currencies: ['IDR'] },
      { code: 'ovo', name: 'OVO', currencies: ['IDR'] },
      { code: 'linkaja', name: 'LinkAja', currencies: ['IDR'] },
      { code: 'kredivo', name: 'Kredivo', currencies: ['IDR'] },
      { code: 'akulaku', name: 'Akulaku', currencies: ['IDR'] },
      { code: 'atome', name: 'Atome', currencies: ['IDR'] },
    ];
  }

  verifySignature(body: unknown, _headers: Record<string, string>): boolean {
    const config = getConfig();
    if (!config.SCALEV_WEBHOOK_SECRET) {
      logger.error('SCALEV_WEBHOOK_SECRET not configured');
      return false;
    }

    // Scalev webhook uses HMAC-SHA256 with webhook secret
    const payload = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', config.SCALEV_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    // Check x-scalev-signature header
    return true; // TODO: implement proper verification
  }

  normalizeEvent(body: unknown, metadata?: Record<string, unknown> | null): NormalizedPaymentEvent {
    const payload = body as Record<string, unknown>;
    const status = this.extractStatus(payload);

    return {
      gateway: this.name,
      order_id: String(payload.secret_slug || payload.id || ''),
      gateway_reference: String(payload.id || ''),
      status,
      amount: Number(payload.total_amount || 0),
      currency: String(payload.currency || 'IDR'),
      payment_method: String(payload.payment_method || ''),
      paid_at: status === 'success' ? String(payload.paid_at || new Date().toISOString()) : null,
      metadata: metadata ?? null,
    };
  }

  private extractStatus(payload: Record<string, unknown>): PaymentStatus {
    const status = String(payload.status || '').toLowerCase();
    if (status === 'paid' || status === 'completed') return 'success';
    if (status === 'pending' || status === 'processing') return 'pending';
    if (status === 'failed' || status === 'cancelled') return 'failed';
    if (status === 'expired') return 'expired';
    return 'pending';
  }
}