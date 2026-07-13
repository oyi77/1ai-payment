/**
 * Unit tests for the Tripay gateway implementation.
 *
 * Covers status mapping, event normalization, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import crypto from 'crypto';
import { TripayGateway } from '../../src/gateways/tripay';

// Set required env vars before any gateway method calls getConfig()
beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.TRIPAY_API_KEY = 'test_tripay_key';
  process.env.TRIPAY_PRIVATE_KEY = 'test_private_key';
  process.env.TRIPAY_MERCHANT_CODE = 'test_merchant';
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    merchant_ref: 'pay_abc123',
    reference: 'TRIPAY-REF-001',
    status: 'PAID',
    amount: 100000,
    payment_method: 'BCA',
    ...overrides,
  };
}

function makeHeaders(sig?: string): Record<string, string> {
  return sig ? { 'x-signature': sig } : {};
}

const gateway = new TripayGateway();

describe('TripayGateway.normalizeEvent', () => {

  test('maps PAID to success', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'PAID' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('tripay');
  });

  test('maps EXPIRED to expired', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'EXPIRED' }));
    expect(event.status).toBe('expired');
  });

  test('maps FAILED to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'FAILED' }));
    expect(event.status).toBe('failed');
  });

  test('maps CANCELLED to cancelled', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'CANCELLED' }));
    expect(event.status).toBe('cancelled');
  });

  test('maps UNPAID to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'UNPAID' }));
    expect(event.status).toBe('pending');
  });

  test('unknown status defaults to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'UNKNOWN' }));
    expect(event.status).toBe('pending');
  });

  test('extracts order_id from merchant_ref', () => {
    const event = gateway.normalizeEvent(makePayload({ merchant_ref: 'order_42' }));
    expect(event.order_id).toBe('order_42');
  });

  test('extracts gateway_reference from reference', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.gateway_reference).toBe('TRIPAY-REF-001');
  });

  test('extracts amount as number', () => {
    const event = gateway.normalizeEvent(makePayload({ amount: 50000 }));
    expect(event.amount).toBe(50000);
  });

  test('extracts payment_method', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_method: 'GOPAY' }));
    expect(event.payment_method).toBe('GOPAY');
  });

  test('currency is IDR', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.currency).toBe('IDR');
  });

  test('preserves metadata', () => {
    const meta = { project: 'test', user_id: '42' };
    const event = gateway.normalizeEvent(makePayload(), meta);
    expect(event.metadata).toEqual(meta);
  });

  test('paid_at is string for success status', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'PAID' }));
    expect(typeof event.paid_at).toBe('string');
  });
});

describe('TripayGateway.verifySignature', () => {

  test('valid HMAC-SHA256 signature passes', () => {
    const payload = makePayload();
    const bodyStr = JSON.stringify(payload);
    const sig = crypto
      .createHmac('sha256', 'test_private_key')
      .update(bodyStr)
      .digest('hex');
    expect(gateway.verifySignature(payload, makeHeaders(sig))).toBe(true);
  });

  test('invalid signature fails', () => {
    const payload = makePayload();
    expect(gateway.verifySignature(payload, makeHeaders('bad_sig'))).toBe(false);
  });

  test('missing header returns false', () => {
    const payload = makePayload();
    expect(gateway.verifySignature(payload, {})).toBe(false);
  });
});
