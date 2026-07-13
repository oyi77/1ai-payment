/**
 * Unit tests for the Xendit gateway implementation.
 *
 * Covers status mapping, event normalization, and callback token verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { XenditGateway } from '../../src/gateways/xendit';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.XENDIT_API_KEY = 'test_xendit_key';
  process.env.XENDIT_CALLBACK_TOKEN = 'test_callback_token';
});

function makeInvoicePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'XENDIT-INV-001',
    external_id: 'pay_abc123',
    status: 'PAID',
    amount: 100000,
    currency: 'IDR',
    payment_method: 'BANK_TRANSFER',
    paid_at: '2026-07-12T10:00:00Z',
    ...overrides,
  };
}

const gateway = new XenditGateway();

describe('XenditGateway.normalizeEvent', () => {

  test('maps PAID to success', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ status: 'PAID' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('xendit');
  });

  test('maps PENDING to pending', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ status: 'PENDING' }));
    expect(event.status).toBe('pending');
  });

  test('maps SETTLED to success', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ status: 'SETTLED' }));
    expect(event.status).toBe('success');
  });

  test('maps EXPIRED to expired', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ status: 'EXPIRED' }));
    expect(event.status).toBe('expired');
  });

  test('maps FAILED to failed', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ status: 'FAILED' }));
    expect(event.status).toBe('failed');
  });

  test('unknown status defaults to pending', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ status: 'UNKNOWN' }));
    expect(event.status).toBe('pending');
  });

  test('extracts order_id from external_id', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ external_id: 'order_42' }));
    expect(event.order_id).toBe('order_42');
  });

  test('extracts gateway_reference from id', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload());
    expect(event.gateway_reference).toBe('XENDIT-INV-001');
  });

  test('extracts amount', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ amount: 50000 }));
    expect(event.amount).toBe(50000);
  });

  test('extracts currency', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ currency: 'USD' }));
    expect(event.currency).toBe('USD');
  });

  test('extracts payment_method', () => {
    const event = gateway.normalizeEvent(makeInvoicePayload({ payment_method: 'CREDIT_CARD' }));
    expect(event.payment_method).toBe('CREDIT_CARD');
  });

  test('preserves metadata', () => {
    const meta = { source: 'api' };
    const event = gateway.normalizeEvent(makeInvoicePayload(), meta);
    expect(event.metadata).toEqual(meta);
  });
});

describe('XenditGateway.verifySignature', () => {

  test('valid X-Callback-Token passes', () => {
    expect(gateway.verifySignature(makeInvoicePayload(), {
      'x-callback-token': 'test_callback_token',
    })).toBe(true);
  });

  test('invalid token fails', () => {
    expect(gateway.verifySignature(makeInvoicePayload(), {
      'x-callback-token': 'wrong_token',
    })).toBe(false);
  });

  test('missing header returns false', () => {
    expect(gateway.verifySignature(makeInvoicePayload(), {})).toBe(false);
  });
});
