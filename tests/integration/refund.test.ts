/**
 * Integration tests for refund endpoints.
 *
 * Creates a temp SQLite DB, seeds a merchant + order, and tests
 * POST /api/refunds and GET /api/refunds with real app routing.
 */
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), `1pay-refund-test-${Date.now()}.db`);

process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.ENCRYPTION_KEY = 'f0bbe8000253a9997331287d3ebdadd3854720a049233b18a37dd401b61b4c6f';

const TEST_API_KEY = '1pay_test_refund_api_key_1234567890abcdef';

let app: import('hono').Hono;
let seededMerchantId: string;
let refundableOrderId: string;
let pendingOrderId: string;

function authHeaders(): Record<string, string> {
  return { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' };
}

beforeAll(async () => {
  const { initDatabase, getDb } = await import('../../src/config/database');
  const { Hono } = await import('hono');
  const { sha256Hash, generateMerchantId, generateWebhookSecret, generateOrderId } = await import('../../src/utils/crypto');
  const { refundRoutes } = await import('../../src/routes/refund');

  await initDatabase();
  const db = getDb();

  // Seed a merchant
  const apiKeyHash = sha256Hash(TEST_API_KEY);
  const webhookSecret = generateWebhookSecret();
  seededMerchantId = generateMerchantId();

  await db.execute({
    sql: `INSERT INTO merchants (id, name, api_key_hash, webhook_secret, active, plan, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, 'pro', datetime('now'), datetime('now'))`,
    args: [seededMerchantId, 'Refund Test Merchant', apiKeyHash, webhookSecret],
  });

  // Seed a refundable order (status = success)
  refundableOrderId = generateOrderId();
  await db.execute({
    sql: `INSERT INTO orders (id, project_id, gateway, amount, status, callback_url, created_at, updated_at)
          VALUES (?, ?, 'midtrans', 50000, 'success', 'https://example.com/callback', datetime('now'), datetime('now'))`,
    args: [refundableOrderId, seededMerchantId],
  });

  // Seed a non-refundable order (status = pending)
  pendingOrderId = generateOrderId();
  await db.execute({
    sql: `INSERT INTO orders (id, project_id, gateway, amount, status, callback_url, created_at, updated_at)
          VALUES (?, ?, 'midtrans', 25000, 'pending', 'https://example.com/callback', datetime('now'), datetime('now'))`,
    args: [pendingOrderId, seededMerchantId],
  });

  // Build test app
  app = new Hono();
  app.route('/api', refundRoutes);
});

afterAll(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('POST /api/refunds', () => {

  test('creates a refund for a successful order', async () => {
    const res = await app.request('/api/refunds', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ order_id: refundableOrderId }),
    });
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(typeof data.id).toBe('string');
    expect(data.status).toBe('pending');
    expect(data.amount).toBe(50000);
    expect(data.order_id).toBe(refundableOrderId);
  });

  test('returns 400 for missing order_id', async () => {
    const res = await app.request('/api/refunds', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('returns 404 for non-existent order', async () => {
    const res = await app.request('/api/refunds', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ order_id: 'nonexistent' }),
    });
    expect(res.status).toBe(404);
  });

  test('returns 400 for non-refundable (pending) order', async () => {
    const res = await app.request('/api/refunds', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ order_id: pendingOrderId }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 401 without API key', async () => {
    const res = await app.request('/api/refunds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: refundableOrderId }),
    });
    expect(res.status).toBe(401);
  });

});

describe('GET /api/refunds', () => {

  test('lists refunds for authenticated merchant', async () => {
    const res = await app.request('/api/refunds', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(Array.isArray(data.refunds)).toBe(true);
    expect(typeof data.total).toBe('number');
  });

  test('returns 401 without API key', async () => {
    const res = await app.request('/api/refunds', { method: 'GET' });
    expect(res.status).toBe(401);
  });

});
