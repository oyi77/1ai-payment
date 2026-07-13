/**
 * Unit tests for the Duitku gateway implementation.
 *
 * Covers status mapping, event normalization, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import crypto from 'crypto';
import { DuitkuGateway } from '../../src/gateways/duitku';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.DUITKU_API_KEY = 'test_duitku_key';
  process.env.DUITKU_MERCHANT_CODE = 'test_merchant';
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    merchantCode: 'test_merchant',
    amount: '100000',
    merchantOrderId: 'pay_abc123',
    resultCode: '00',
    reference: 'DUITKU-REF-001',
    signature: '',
    ...overrides,
  };
}

const gateway = new DuitkuGateway();

describe('DuitkuGateway.normalizeEvent', () => {

  test('resultCode 00 maps to success', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '00' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('duitku');
  });

  test('resultCode 01 maps to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '01' }));
    expect(event.status).toBe('pending');
  });

  test('resultCode 02 maps to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '02' }));
    expect(event.status).toBe('failed');
  });

  test('resultCode 03 maps to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '03' }));
    expect(event.status).toBe('failed');
  });

  test('resultCode 04 maps to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '04' }));
    expect(event.status).toBe('failed');
  });

  test('resultCode 05 maps to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '05' }));
    expect(event.status).toBe('failed');
  });

  test('resultCode 99 maps to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '99' }));
    expect(event.status).toBe('failed');
  });

  test('unknown resultCode maps to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: 'unknown' }));
    expect(event.status).toBe('failed');
  });

  test('extracts order_id from merchantOrderId', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.order_id).toBe('pay_abc123');
  });

  test('extracts gateway_reference from reference', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.gateway_reference).toBe('DUITKU-REF-001');
  });

  test('extracts amount from parseInt', () => {
    const event = gateway.normalizeEvent(makePayload({ amount: '50000' }));
    expect(event.amount).toBe(50000);
  });

  test('currency is IDR', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.currency).toBe('IDR');
  });

  test('preserves metadata', () => {
    const meta = { project: 'test' };
    const event = gateway.normalizeEvent(makePayload(), meta);
    expect(event.metadata).toEqual(meta);
  });

  test('sets paid_at on success', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '00' }));
    expect(event.paid_at).toBeTruthy();
    expect(typeof event.paid_at).toBe('string');
  });

  test('sets paid_at to null on non-success', () => {
    const event = gateway.normalizeEvent(makePayload({ resultCode: '01' }));
    expect(event.paid_at).toBeNull();
  });

});

describe('DuitkuGateway.verifySignature', () => {

  test('valid signature returns true', () => {
    const merchantCode = 'test_merchant';
    const amount = '100000';
    const merchantOrderId = 'pay_abc123';
    const apiKey = 'test_duitku_key';
    const sig = crypto.createHash('md5').update(`${merchantCode}${amount}${merchantOrderId}${apiKey}`).digest('hex');
    const payload = makePayload({ signature: sig });
    expect(gateway.verifySignature(payload, {})).toBe(true);
  });

  test('invalid signature returns false', () => {
    const payload = makePayload({ signature: 'bad_signature_hex' });
    expect(gateway.verifySignature(payload, {})).toBe(false);
  });

  test('malformed payload returns false', () => {
    expect(gateway.verifySignature({}, {})).toBe(false);
  });

  test('empty DUITKU_API_KEY returns false', () => {
    const prev = process.env.DUITKU_API_KEY;
    process.env.DUITKU_API_KEY = '';
    try {
      expect(gateway.verifySignature(makePayload(), {})).toBe(false);
    } finally {
      process.env.DUITKU_API_KEY = prev;
    }
  });

});
