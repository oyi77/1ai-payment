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
  merchant_id: string;
  amount: number;
  gateway: string;
  gateway_refund_id: string | null;
  status: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayInfo {
  gateway: string;
  enabled: boolean;
  currencies: string[];
  methods: { code: string; name: string; currencies: string[] }[];
}

export interface Merchant {
  id: string;
  name: string;
  default_callback_url: string | null;
  active: boolean;
  plan: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  gateway: string;
  order_id: string | null;
  status: string | null;
  signature_valid: number;
  created_at: string;
}

/** Error returned by the 1ai-payment API, carrying the error code and HTTP status. */
export class APIError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'APIError';
    this.code = code;
    this.status = status;
  }
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
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

    // Gateway proxies may return non-JSON error bodies (e.g. HTML from a load
    // balancer); don't let res.json() throw a SyntaxError in that case.
    const data = await res.json().catch(() => null) as Envelope<T> | null;

    if (!data || !data.success) {
      throw new APIError(
        data?.error?.code ?? 'HTTP_ERROR',
        data?.error?.message ?? `Request failed with status ${res.status}`,
        res.status,
      );
    }

    return data.data as T;
  }

  /** Register a new merchant. Public endpoint — no API key required. */
  async register(params: {
    name: string;
    default_callback_url?: string;
    plan?: string;
  }): Promise<{ merchant: Merchant; api_key: string }> {
    return this.request('POST', '/api/register', params);
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

  /** List webhook deliveries for an order, with pagination. */
  async listWebhookDeliveries(params?: {
    order_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ deliveries: WebhookDelivery[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.order_id) query.set('order_id', params.order_id);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return this.request('GET', `/api/webhook-deliveries${qs ? `?${qs}` : ''}`);
  }

  /** Get payment methods available for a gateway. */
  async getGatewayMethods(gateway: string): Promise<GatewayInfo> {
    return this.request<GatewayInfo>('GET', `/api/gateways/${gateway}/methods`);
  }
}
