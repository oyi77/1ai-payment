import { describe, expect, test, afterEach } from 'bun:test';
import { OneAIPayment, APIError } from '../src/index';
import type { Order, GatewayInfo, Merchant, WebhookDelivery } from '../src/index';

let calls: { url: string; init?: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(response: unknown, status = 200) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function mockFetchRaw(body: string, status: number) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status });
  }) as typeof fetch;
}

function client(overrides?: Partial<{ apiKey: string; baseUrl: string }>) {
  return new OneAIPayment({ apiKey: '1pay_test', ...overrides });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
});

describe('URL construction', () => {
  test('default baseUrl is http://localhost:3100', async () => {
    mockFetch({ success: true, data: [] });
    const c = new OneAIPayment({ apiKey: '1pay_test' });
    await c.listGateways();
    expect(calls[0].url).toBe('http://localhost:3100/api/gateways');
  });

  test('trailing slash on baseUrl is stripped', async () => {
    mockFetch({ success: true, data: [] });
    const c = client({ baseUrl: 'http://example.com/' });
    await c.listGateways();
    expect(calls[0].url).toBe('http://example.com/api/gateways');
  });

  test('methods hit the expected paths', async () => {
    mockFetch({ success: true, data: {} });
    const c = client();

    await c.register({ name: 'Store' });
    expect(calls[0].url).toBe('http://localhost:3100/api/register');

    await c.create({
      gateway: 'midtrans',
      amount: 100000,
      callback_url: 'https://my-app.com/callback',
    });
    expect(calls[1].url).toBe('http://localhost:3100/api/payments');

    await c.get('pay_1');
    expect(calls[2].url).toBe('http://localhost:3100/api/payments/pay_1');

    await c.listTransactions({ status: 'paid', limit: 5, offset: 10 });
    expect(calls[3].url).toBe('http://localhost:3100/api/transactions?status=paid&limit=5&offset=10');

    await c.refund('pay_1', 1000, 'test');
    expect(calls[4].url).toBe('http://localhost:3100/api/refunds');

    await c.listRefunds(5, 10);
    expect(calls[5].url).toBe('http://localhost:3100/api/refunds?limit=5&offset=10');

    await c.listWebhookDeliveries({ order_id: 'pay_1', limit: 5, offset: 10 });
    expect(calls[6].url).toBe('http://localhost:3100/api/webhook-deliveries?order_id=pay_1&limit=5&offset=10');

    await c.getGatewayMethods('midtrans');
    expect(calls[7].url).toBe('http://localhost:3100/api/gateways/midtrans/methods');

    await c.listGateways();
    expect(calls[8].url).toBe('http://localhost:3100/api/gateways');
  });
});

describe('request serialization', () => {
  test('sends X-API-Key header and JSON body on POST', async () => {
    mockFetch({ success: true, data: {} });
    const c = client();
    await c.create({
      gateway: 'midtrans',
      amount: 100000,
      callback_url: 'https://my-app.com/callback',
    });
    const init = calls[0].init!;
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('1pay_test');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      gateway: 'midtrans',
      amount: 100000,
      callback_url: 'https://my-app.com/callback',
    });
  });

  test('register is a POST without X-API-Key requirement being enforced client-side', async () => {
    mockFetch({ success: true, data: { merchant: {}, api_key: '1pay_merchant' } });
    const c = client();
    await c.register({ name: 'Store', plan: 'pro' });
    const init = calls[0].init!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Store', plan: 'pro' });
  });
});

describe('error handling', () => {
  test('error envelope rejects with APIError carrying code, message and status', async () => {
    mockFetch(
      { success: false, error: { code: 'INVALID_BODY', message: 'Invalid request body' } },
      400,
    );
    const c = client();
    await expect(c.create({
      gateway: 'midtrans',
      amount: 100000,
      callback_url: 'https://my-app.com/callback',
    })).rejects.toThrow(APIError);

    try {
      await c.create({
        gateway: 'midtrans',
        amount: 100000,
        callback_url: 'https://my-app.com/callback',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(APIError);
      const apiError = err as APIError;
      expect(apiError.code).toBe('INVALID_BODY');
      expect(apiError.message).toBe('Invalid request body');
      expect(apiError.status).toBe(400);
      expect(apiError.name).toBe('APIError');
    }
  });

  test('non-JSON error body rejects with APIError HTTP_ERROR instead of SyntaxError', async () => {
    mockFetchRaw('<html>Bad Gateway</html>', 502);
    const c = client();
    try {
      await c.listGateways();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(APIError);
      const apiError = err as APIError;
      expect(apiError.code).toBe('HTTP_ERROR');
      expect(apiError.status).toBe(502);
      expect(apiError.message).toBe('Request failed with status 502');
    }
  });

  test('success envelope resolves the data payload', async () => {
    const order = { id: 'pay_1', gateway: 'midtrans', status: 'pending' };
    mockFetch({ success: true, data: order });
    const c = client();
    await expect(c.get('pay_1')).resolves.toEqual(order);
  });
});

describe('typed usage', () => {
  test('methods resolve to the documented shapes', async () => {
    mockFetch({ success: true, data: { gateway: 'midtrans', enabled: true, currencies: ['IDR'], methods: [] } });
    const c = client();
    const gw: GatewayInfo = await c.getGatewayMethods('midtrans');
    expect(gw.gateway).toBe('midtrans');

    mockFetch({
      success: true,
      data: {
        merchant: {
          id: 'm_1',
          name: 'Store',
          default_callback_url: null,
          active: true,
          plan: 'free',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        api_key: '1pay_merchant',
      },
    });
    const reg: { merchant: Merchant; api_key: string } = await c.register({ name: 'Store' });
    expect(reg.merchant.name).toBe('Store');
    expect(reg.merchant.plan).toBe('free');
    expect(reg.api_key).toBe('1pay_merchant');

    mockFetch({
      success: true,
      data: {
        deliveries: [
          {
            id: 'wh_1',
            gateway: 'midtrans',
            order_id: 'pay_1',
            status: 'forwarded',
            signature_valid: 1,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      },
    });
    const deliveries: { deliveries: WebhookDelivery[]; total: number } = await c.listWebhookDeliveries({ order_id: 'pay_1' });
    expect(deliveries.total).toBe(1);
    expect(deliveries.deliveries[0].signature_valid).toBe(1);

    mockFetch({
      success: true,
      data: {
        id: 'pay_1',
        gateway: 'midtrans',
        gateway_reference: 'ref_1',
        status: 'paid',
        amount: 100000,
        currency: 'IDR',
        payment_method: 'gopay',
        payment_url: 'https://checkout.midtrans.com/abc',
        metadata: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    });
    const order: Order = await c.get('pay_1');
    expect(order.status).toBe('paid');
  });
});
