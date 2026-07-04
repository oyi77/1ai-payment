/**
 * Duitku payment gateway implementation.
 *
 * Payment creation: POST /webapi/api/merchant/v2/inquiry
 * Signature (create): MD5(merchantCode + merchantOrderId + paymentAmount + apiKey)
 * Signature (callback): MD5(merchantCode + amount + merchantOrderId + apiKey)
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

interface DuitkuCallbackPayload {
  merchantCode: string;
  amount: string;
  merchantOrderId: string;
  resultCode: string;
  reference: string;
  signature: string;
}

interface DuitkuInquiryResponse {
  merchantCode: string;
  reference: string;
  paymentUrl: string;
  vaNumber?: string;
  amount: string;
  statusCode: string;
  statusMessage: string;
}

const SANDBOX_URL = 'https://sandbox.duitku.com';
const PRODUCTION_URL = 'https://passport.duitku.com';

export class DuitkuGateway implements PaymentGateway {
  readonly name = 'duitku';

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    const config = getConfig();
    if (!config.DUITKU_API_KEY || !config.DUITKU_MERCHANT_CODE) {
      throw new GatewayError('duitku', 'DUITKU_API_KEY or DUITKU_MERCHANT_CODE not configured');
    }

    const baseUrl = config.DUITKU_ENVIRONMENT === 'production' ? PRODUCTION_URL : SANDBOX_URL;

    const signature = crypto
      .createHash('md5')
      .update(`${config.DUITKU_MERCHANT_CODE}${params.orderId}${params.amount}${config.DUITKU_API_KEY}`)
      .digest('hex');

    const body = {
      merchantCode: config.DUITKU_MERCHANT_CODE,
      paymentAmount: params.amount,
      paymentMethod: params.paymentMethod || 'VC',
      merchantOrderId: params.orderId,
      productDetails: 'Payment',
      customerVaName: params.customerName || 'Customer',
      email: params.customerEmail || '',
      callbackUrl: 'https://pay.1ai.dev/webhook/duitku',
      returnUrl: 'https://example.com/payment/finish',
      signature,
      expiryPeriod: 60,
    };

    const response = await fetch(`${baseUrl}/webapi/api/merchant/v2/inquiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new GatewayError('duitku', `Inquiry failed: ${response.status} ${error}`);
    }

    const result = (await response.json()) as DuitkuInquiryResponse;

    if (result.statusCode !== '00') {
      throw new GatewayError('duitku', result.statusMessage || 'Payment creation failed');
    }

    return {
      gatewayReference: result.reference,
      paymentUrl: result.paymentUrl,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };
  }

  getPaymentMethods(): PaymentMethod[] {
    return [
      { code: 'VC', name: 'Virtual Account (All Banks)', currencies: ['IDR'] },
      { code: 'BC', name: 'BCA Virtual Account', currencies: ['IDR'] },
      { code: 'M2', name: 'Mandiri Virtual Account', currencies: ['IDR'] },
      { code: 'I1', name: 'BNI Virtual Account', currencies: ['IDR'] },
      { code: 'B1', name: 'BRI Virtual Account', currencies: ['IDR'] },
      { code: 'BT', name: 'Permata Virtual Account', currencies: ['IDR'] },
      { code: 'QR', name: 'QRIS', currencies: ['IDR'] },
      { code: 'OV', name: 'OVO', currencies: ['IDR'] },
      { code: 'DA', name: 'DANA', currencies: ['IDR'] },
      { code: 'SP', name: 'ShopeePay', currencies: ['IDR'] },
      { code: 'GQ', name: 'GoPay', currencies: ['IDR'] },
    ];
  }

  verifySignature(body: unknown, _headers: Record<string, string>): boolean {
    const payload = body as DuitkuCallbackPayload;
    const config = getConfig();

    if (!config.DUITKU_API_KEY) {
      logger.error('DUITKU_API_KEY not configured');
      return false;
    }

    const expected = crypto
      .createHash('md5')
      .update(`${payload.merchantCode}${payload.amount}${payload.merchantOrderId}${config.DUITKU_API_KEY}`)
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
    const payload = body as DuitkuCallbackPayload;
    const status = this.extractStatus(payload);

    return {
      gateway: this.name,
      order_id: payload.merchantOrderId,
      gateway_reference: payload.reference,
      status,
      amount: parseInt(payload.amount, 10),
      currency: 'IDR',
      payment_method: 'bank_transfer',
      paid_at: status === 'success' ? new Date().toISOString() : null,
      metadata: metadata ?? null,
    };
  }

  private extractStatus(payload: DuitkuCallbackPayload): PaymentStatus {
    const code = payload.resultCode;
    if (code === '00') return 'success';
    if (code === '01') return 'pending';
    return 'failed';
  }
}
