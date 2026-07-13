/**
 * Integration tests for the full payment flow.
 *
 * Covers:
 * - POST /api/payments — creating a payment with a gateway
 * - POST /webhook/:gateway — receiving a gateway callback
 *
 * Uses a fresh temp SQLite database per run.
 */
import { beforeAll, afterAll, afterEach, describe, expect, test } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), `1pay-flow-test-${Date.now()}.db`);

// Set env BEFORE any dynamic import
process.env.API_KEY = 'test-api-key-flow';
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.ENCRYPTION_KEY = 'f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f';
process.env.MIDTRANS_SERVER_KEY = 'midtrans_test_key';
process.env.MIDTRANS_CLIENT_KEY = 'midtrans_client_key';
process.env.TRIPAY_PRIVATE_KEY = 'tripay_test_private_key';
process.env.TRIPAY_API_KEY = 'tripay_test_api_key';
process.env.TRIPAY_MERCHANT_CODE = 'tripay_test_merchant';
process.env.DUITKU_API_KEY = 'duitku_test_key';
process.env.DUITKU_MERCHANT_CODE = 'duitku_test_merchant';
process.env.XENDIT_API_KEY = 'xendit_test_key';
process.env.XENDIT_CALLBACK_TOKEN = 'xendit_test_token';

let app: import('hono').Hono;

beforeAll(async () => {
  const { initDatabase } = await import('../../src/config/database');
  const { paymentRoutes } = await import('../../src/routes/payment');
  const { webhookRoutes } = await import('../../src/routes/webhook');
  const { Hono } = await import('hono');

  await initDatabase();

  app = new Hono();

  // Mock midtrans gateway to avoid hitting real API
  const { getGateway: originalGetGateway } = await import('../../src/gateways');
  const midtransGw = originalGetGateway('midtrans');
  if (midtransGw) {
    const origCreatePayment = midtransGw.createPayment.bind(midtransGw);
    midtransGw.createPayment = async (params) => {
      return {
        gatewayReference: 'trx_mock_' + Date.now(),
        paymentUrl: 'https://app.sandbox.midtrans.com/snap/v2/vtweb/mock-redirect',
        expiresAt: undefined,
      };
    };
  }

  app.route('/api', paymentRoutes);
  app.route('/webhook', webhookRoutes);
});

afterEach(() => {
  // Reset the cached config so next test can re-init with potentially different env
  delete process.env['TRIPAY_PRIVATE_KEY'];
  process.env.TRIPAY_PRIVATE_KEY = 'tripay_test_private_key';
});

afterAll(() => {
  try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); } catch {}
});

describe('POST /api/payments', () => {

  test('creates a midtrans payment', async () => {
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-flow' },
      body: JSON.stringify({
        gateway: 'midtrans',
        amount: 10000,
        currency: 'IDR',
        customer: { name: 'Test', email: 'test@example.com' },
        callback_url: 'https://example.com/callback',
        metadata: { project: 'flowtest' },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.payment_url).toBeDefined();
    expect(body.data.id).toBeDefined();
  });

  test('rejects unknown gateway', async () => {
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-flow' },
      body: JSON.stringify({
        gateway: 'nonexistent',
        amount: 10000,
        currency: 'IDR',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects missing amount', async () => {
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-flow' },
      body: JSON.stringify({
        gateway: 'midtrans',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects invalid amount (zero)', async () => {
    const res = await app.request('/api/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-flow' },
      body: JSON.stringify({
        gateway: 'midtrans',
        amount: 0,
        currency: 'IDR',
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /webhook/:gateway', () => {
  test('midtrans webhook — valid signature updates order', async () => {
    const createRes = await app.request('/api/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-flow' },
      body: JSON.stringify({
        gateway: 'midtrans',
        amount: 20000,
        customer: { name: 'Hook Test', email: 'hook@test.com' },
        callback_url: 'https://example.com/callback',
        metadata: { project: 'flowtest' },
      }),
    });
    const createBody = await createRes.json() as { data: { id: string } };
    const orderId = createBody.data.id;

    // Compute Midtrans signature: SHA-512(order_id + status_code + gross_amount + server_key)
    const serverKey = 'midtrans_test_key';
    const statusCode = '200'; // success
    const grossAmount = '20000.00';
    const sigInput = `${orderId}${statusCode}${grossAmount}${serverKey}`;
    const crypto = await import('crypto');

    // Send webhook callback — signature_key MUST be in the body, not header
    const payload: Record<string, string> = {
      transaction_status: 'settlement',
      order_id: orderId,
      status_code: statusCode,
      gross_amount: grossAmount,
      payment_type: 'bank_transfer',
      currency: 'IDR',
      transaction_time: new Date().toISOString(),
    };
    const signature = crypto.createHash('sha512').update(sigInput).digest('hex');
    payload.signature_key = signature;

    const webhookRes = await app.request('/webhook/midtrans', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(webhookRes.status).toBe(200);
    const ack = await webhookRes.json();
    expect(ack.ok).toBe(true);
  });


  test('tripay webhook — invalid signature returns 401', async () => {
    const webhookRes = await app.request('/webhook/tripay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_ref: 'order_nonexistent',
        reference: 'REF-001',
        status: 'PAID',
        amount: 50000,
      }),
    });
    expect(webhookRes.status).toBe(401);
  });

  test('midtrans webhook — invalid signature returns 401', async () => {
    const webhookRes = await app.request('/webhook/midtrans', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': 'invalid_sig',
      },
      body: JSON.stringify({ transaction_status: 'settlement', order_id: 'nonexistent' }),
    });
    expect(webhookRes.status).toBe(401);
  });

  test('unknown gateway returns 501', async () => {
    const webhookRes = await app.request('/webhook/unknown_gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(webhookRes.status).toBe(501);
  });

  test('invalid JSON returns 400', async () => {
    const webhookRes = await app.request('/webhook/midtrans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(webhookRes.status).toBe(400);
  });
});
