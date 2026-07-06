/**
 * @1ai/payment — TypeScript SDK for 1ai-payment gateway aggregator.
 *
 * Usage:
 *   import { OneAIPayment } from '@1ai/payment';
 *
 *   const payment = new OneAIPayment({ apiKey: '1pay_xxxxx' });
 *
 *   const order = await payment.create({
 *     gateway: 'midtrans',
 *     amount: 100000,
 *     callbackUrl: 'https://my-app.com/callback',
 *   });
 *   // Redirect user to order.paymentUrl
 */

export interface OneAIPaymentOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface CreatePaymentParams {
  gateway: string;
  amount: number;
  currency?: string;
  payment_method?: string;
  callback_url: string;
  idempotency_key?: string;
  project_order_id?: string;
  customer?: { name?: string; email?: string };
  metadata?: Record<string, unknown>;
}

export interface Order {
  id: string;
  gateway: string;
  gateway_reference: string | null;
  status: string;
  amount: number;
  currency: string;
  payment_method: string | null;
  payment_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Refund {
  id: string;
  order_id: string;
  amount: number;
  gateway: string;
  gateway_refund_id: string | null;
  status: string;
  reason: string | null;
  created_at: string;
}

export interface GatewayInfo {
  gateway: string;
  enabled: boolean;
  currencies: string[];
  methods: { code: string; name: string; currencies: string[] }[];
}

export class OneAIPayment {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OneAIPaymentOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3100').replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json() as { success: boolean; data?: T; error?: { code: string; message: string } };

    if (!data.success) {
      throw new Error(data.error?.message ?? `Request failed: ${res.status}`);
    }

    return data.data as T;
  }

  /** Create a payment and get a payment URL to redirect the user to. */
  async create(params: CreatePaymentParams): Promise<Order> {
    return this.request<Order>('POST', '/api/payments', params);
  }

  /** Get payment status by order ID. */
  async get(orderId: string): Promise<Order> {
    return this.request<Order>('GET', `/api/payments/${orderId}`);
  }

  /** List transactions with optional filters. */
  async listTransactions(params?: {
    status?: string;
    gateway?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ transactions: Order[]; total: number; limit: number; offset: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.gateway) query.set('gateway', params.gateway);
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return this.request('GET', `/api/transactions${qs ? `?${qs}` : ''}`);
  }

  /** Create a refund for an order. */
  async refund(orderId: string, amount?: number, reason?: string): Promise<Refund> {
    return this.request<Refund>('POST', '/api/refunds', { order_id: orderId, amount, reason });
  }

  /** List refunds. */
  async listRefunds(limit?: number, offset?: number): Promise<{ refunds: Refund[]; total: number }> {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (offset) query.set('offset', String(offset));
    const qs = query.toString();
    return this.request('GET', `/api/refunds${qs ? `?${qs}` : ''}`);
  }

  /** List available gateways. */
  async listGateways(): Promise<GatewayInfo[]> {
    return this.request<GatewayInfo[]>('GET', '/api/gateways');
  }
}
