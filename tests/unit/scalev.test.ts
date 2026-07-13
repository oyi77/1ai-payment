/**
 * Unit tests for the Scalev gateway implementation.
 *
 * Covers status mapping, event normalization, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import crypto from 'crypto';
import { ScalevGateway } from '../../src/gateways/scalev';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.SCALEV_STOREFRONT_API_KEY = 'sfpk_test';
  process.env.SCALEV_STORE_ID = 'store_1';
  process.env.SCALEV_VARIANT_ID = '1';
  process.env.SCALEV_WEBHOOK_SECRET = 'whsec_test';
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'SCALEV-ORD-001',
    secret_slug: 'abc123',
    status: 'paid',
    total_amount: 100000,
    currency: 'IDR',
    payment_method: 'bank_transfer',
    customer_name: 'Test User',
    customer_email: 'test@example.com',
    created_at: '2026-07-12T10:00:00Z',
    ...overrides,
  };
}

const gateway = new ScalevGateway();

describe('ScalevGateway.normalizeEvent', () => {

  test('maps paid to success', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'paid' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('scalev');
  });

  test('maps pending to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'pending' }));
    expect(event.status).toBe('pending');
  });

  test('maps cancelled to cancelled', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'cancelled' }));
    expect(event.status).toBe('cancelled');
  });

  test('maps expired to expired', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'expired' }));
    expect(event.status).toBe('expired');
  });

  test('unknown status defaults to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'unknown' }));
    expect(event.status).toBe('pending');
  });

  test('extracts order_id from id', () => {
    const event = gateway.normalizeEvent(makePayload({ id: 'order_42', secret_slug: '' }));
    expect(event.order_id).toBe('order_42');
  });

  test('extracts gateway_reference from secret_slug?id', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.gateway_reference).toBe('SCALEV-ORD-001');
  });

  test('extracts amount from total_amount', () => {
    const event = gateway.normalizeEvent(makePayload({ total_amount: 50000 }));
    expect(event.amount).toBe(50000);
  });

  test('extracts currency', () => {
    const event = gateway.normalizeEvent(makePayload({ currency: 'USD' }));
    expect(event.currency).toBe('USD');
  });

  test('extracts payment_method', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_method: 'gopay' }));
    expect(event.payment_method).toBe('gopay');
  });

  test('preserves metadata', () => {
    const meta = { source: 'web' };
    const event = gateway.normalizeEvent(makePayload(), meta);
    expect(event.metadata).toEqual(meta);
  });
});

describe('ScalevGateway.verifySignature', () => {

  test('valid HMAC-SHA256 signature passes', () => {
    const body = makePayload();
    const bodyStr = JSON.stringify(body);
    const expected = crypto
      .createHmac('sha256', 'whsec_test')
      .update(bodyStr)
      .digest('hex');
    expect(gateway.verifySignature(body, { 'x-scalev-signature': expected })).toBe(true);
  });

  test('invalid signature fails', () => {
    expect(gateway.verifySignature(makePayload(), { 'x-scalev-signature': 'bad' })).toBe(false);
  });

  test('missing header returns false', () => {
    expect(gateway.verifySignature(makePayload(), {})).toBe(false);
  });
});
