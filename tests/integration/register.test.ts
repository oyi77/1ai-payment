/**
 * Integration tests for POST /api/register
 *
 * Uses a fresh temp SQLite database per run.
 * Env vars are set before any module-level code runs (imports are evaluated
 * lazily under Bun when inside a test file with top-level await).
 */

import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DB = join(tmpdir(), `1pay-test-${Date.now()}.db`);

// Set env before ANY dynamic import touches getConfig()
process.env.API_KEY = 'test-api-key-for-register';
process.env.DATABASE_PATH = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

let app: import('hono').Hono;

beforeAll(async () => {
  const { initDatabase } = await import('../../src/config/database');
  const { registerRoutes } = await import('../../src/routes/register');
  const { Hono } = await import('hono');

  await initDatabase();

  app = new Hono();
  app.route('/api', registerRoutes);
});

afterAll(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('POST /api/register', () => {
  test('creates merchant and returns api_key', async () => {
    const res = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Store', plan: 'free' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(body.data.merchant.id).toMatch(/^merch_/);
    expect(body.data.merchant.name).toBe('My Store');
    expect(body.data.merchant.plan).toBe('free');
    expect(body.data.merchant.active).toBe(true);
    expect(body.data.merchant.default_callback_url).toBeNull();

    expect(body.data.api_key).toMatch(/^1pay_/);
  });

  test('accepts default_callback_url', async () => {
    const res = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Callback Store',
        plan: 'pro',
        default_callback_url: 'https://mystore.com/payment-callback',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.merchant.name).toBe('Callback Store');
    expect(body.data.merchant.plan).toBe('pro');
    expect(body.data.merchant.default_callback_url).toBe(
      'https://mystore.com/payment-callback',
    );
  });

  test('rejects missing name', async () => {
    const res = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'free' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_BODY');
  });

  test('handles concurrent duplicate gracefully (no unique constraint on name)', async () => {
    // Name is not UNIQUE in the DB — duplicate names are allowed
    const res1 = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate Store' }),
    });
    expect(res1.status).toBe(201);

    const res2 = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate Store' }),
    });
    expect(res2.status).toBe(201);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.data.merchant.id).not.toBe(body2.data.merchant.id);
  });
});
