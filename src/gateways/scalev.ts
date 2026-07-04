/**
 * Scalev payment gateway implementation.
 *
 * Payment creation: POST /api/v1/transaction
 * Signature: HMAC-SHA256(payload, apiKey)
 * Callback payload: see docs/03-gateway-specs.md
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

interface ScalevCallbackPayload {
  transaction_id: string;
  merchant_id: string;
  order_id: string;
  amount: string;
  status: string;
  payment_method: string;
  paid_at: string;
  signature: string;
}

interface ScalevCreateResponse {
  success: boolean;
  data?: {
    transaction_id: string;
    order_id: string;
    payment_url: string;
    amount: string;
    status: string;
    expired_at: string;
  };
  message?: string;
}

const SANDBOX_URL = 'https://sandbox.scalev.com';
const PRODUCTION_URL = 'https://api.scalev.com';

export class ScalevGateway implements PaymentGateway {
  readonly name = 'scalev';

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    const config = getConfig();
    if (!config.SCALEV_API_KEY || !config.SCALEV_MERCHANT_ID) {
      throw new GatewayError('scalev', 'SCALEV_API_KEY or SCALEV_MERCHANT_ID not configured');
    }

    const baseUrl = config.SCALEV_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;

    const body = {
      merchant_id: config.SCALEV_MERCHANT_ID,
      order_id: params.orderId,
      amount: params.amount,
      payment_method: params.paymentMethod || 'qris',
      customer_name: params.customerName || 'Customer',
      customer_email: params.customerEmail || '',
      callback_url: 'https://pay.1ai.dev/webhook/scalev',
      return_url: 'https://example.com/payment/finish',
      expired_time: Math.floor(Date.now() / 1000) + 86400, // 24 hours
    };

    const response = await fetch(`${baseUrl}/api/v1/transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.SCALEV_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new GatewayError('scalev', `Create failed: ${response.status} ${error}`);
    }

    const result = (await response.json()) as ScalevCreateResponse;

    if (!result.success || !result.data) {
      throw new GatewayError('scalev', result.message || 'Payment creation failed');
    }

    return {
      gatewayReference: result.data.transaction_id,
      paymentUrl: result.data.payment_url,
      expiresAt: result.data.expired_at ? new Date(Number(result.data.expired_at) * 1000).toISOString() : undefined,
    };
  }

  getPaymentMethods(): PaymentMethod[] {
    return [
      { code: 'qris', name: 'QRIS', currencies: ['IDR'] },
      { code: 'bank_transfer', name: 'Bank Transfer (All Banks)', currencies: ['IDR'] },
      { code: 'bca', name: 'BCA Virtual Account', currencies: ['IDR'] },
      { code: 'mandiri', name: 'Mandiri Virtual Account', currencies: ['IDR'] },
      { code: 'bni', name: 'BNI Virtual Account', currencies: ['IDR'] },
      { code: 'bri', name: 'BRI Virtual Account', currencies: ['IDR'] },
      { code: 'permata', name: 'Permata Virtual Account', currencies: ['IDR'] },
      { code: 'cimb', name: 'CIMB Virtual Account', currencies: ['IDR'] },
      { code: 'gopay', name: 'GoPay', currencies: ['IDR'] },
      { code: 'shopeepay', name: 'ShopeePay', currencies: ['IDR'] },
      { code: 'ovo', name: 'OVO', currencies: ['IDR'] },
      { code: 'dana', name: 'DANA', currencies: ['IDR'] },
      { code: 'linkaja', name: 'LinkAja', currencies: ['IDR'] },
      { code: 'kredivo', name: 'Kredivo', currencies: ['IDR'] },
      { code: 'akulaku', name: 'Akulaku', currencies: ['IDR'] },
      { code: 'atome', name: 'Atome', currencies: ['IDR'] },
      { code: 'indomaret', name: 'Indomaret', currencies: ['IDR'] },
      { code: 'alfamart', name: 'Alfamart', currencies: ['IDR'] },
    ];
  }

  verifySignature(body: unknown, _headers: Record<string, string>): boolean {
    const payload = body as ScalevCallbackPayload;
    const config = getConfig();

    if (!config.SCALEV_API_KEY) {
      logger.error('SCALEV_API_KEY not configured');
      return false;
    }

    // Scalev signature: HMAC-SHA256 of the raw body
    const expected = crypto
      .createHmac('sha256', config.SCALEV_API_KEY)
      .update(JSON.stringify(payload))
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(payload.signature, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch {
      return false;
    }
  }

  normalizeEvent(body: unknown, metadata?: Record<string, unknown> | null): NormalizedPaymentEvent {
    const payload = body as ScalevCallbackPayload;
    const status = this.extractStatus(payload);

    return {
      gateway: this.name,
      order_id: payload.order_id,
      gateway_reference: payload.transaction_id,
      status,
      amount: parseInt(payload.amount, 10),
      currency: 'IDR',
      payment_method: payload.payment_method,
      paid_at: status === 'success' ? payload.paid_at : null,
      metadata: metadata ?? null,
    };
  }

  private extractStatus(payload: ScalevCallbackPayload): PaymentStatus {
    const map: Record<string, PaymentStatus> = {
      paid: 'success',
      success: 'success',
      pending: 'pending',
      failed: 'failed',
      expired: 'expired',
      cancelled: 'cancelled',
      refunded: 'failed',
    };
    return map[payload.status?.toLowerCase()] || 'pending';
  }
}