/**
 * Unit tests for the NOWPayments gateway implementation.
 *
 * Covers status mapping, event normalization, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { NowPaymentsGateway } from '../../src/gateways/nowpayments';

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: 'np_98765',
    order_id: 'pay_abc123',
    order_description: 'Payment',
    price_amount: 100.5,
    price_currency: 'usd',
    pay_amount: 100.5,
    pay_currency: 'btc',
    payment_status: 'finished',
    created_at: '2026-07-12T10:00:00Z',
    ...overrides,
  };
}

const gateway = new NowPaymentsGateway();

describe('NowPaymentsGateway.normalizeEvent', () => {
  beforeAll(() => {
    process.env.API_KEY = 'test-api-key';
    process.env.ENCRYPTION_KEY = 'test-encryption-key';
    process.env.ADMIN_API_KEY = 'test-admin-api-key';
    process.env.NOWPAYMENTS_API_KEY = 'test-np-api-key';
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret';
  });

  test('maps finished to success', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'finished' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('nowpayments');
  });

  test('maps confirmed to success', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'confirmed' }));
    expect(event.status).toBe('success');
  });

  test('maps confirming to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'confirming' }));
    expect(event.status).toBe('pending');
  });

  test('maps sending to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'sending' }));
    expect(event.status).toBe('pending');
  });

  test('maps partially_paid to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'partially_paid' }));
    expect(event.status).toBe('pending');
  });

  test('maps refunded to refunded', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'refunded' }));
    expect(event.status).toBe('refunded');
  });

  test('maps failed to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'failed' }));
    expect(event.status).toBe('failed');
  });

  test('maps expired to expired', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'expired' }));
    expect(event.status).toBe('expired');
  });

  test('unknown payment_status defaults to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'unknown_status' }));
    expect(event.status).toBe('pending');
  });

  test('extracts order_id', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.order_id).toBe('pay_abc123');
  });

  test('extracts gateway_reference from payment_id', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.gateway_reference).toBe('np_98765');
  });

  test('extracts amount from price_amount', () => {
    const event = gateway.normalizeEvent(makePayload({ price_amount: 250.75 }));
    expect(event.amount).toBe(250.75);
  });

  test('extracts currency from price_currency', () => {
    const event = gateway.normalizeEvent(makePayload({ price_currency: 'eur' }));
    expect(event.currency).toBe('EUR');
  });

  test('defaults currency to USD when price_currency missing', () => {
    const event = gateway.normalizeEvent(makePayload({ price_currency: undefined }));
    expect(event.currency).toBe('USD');
  });

  test('sets payment_method as crypto_{pay_currency}', () => {
    const event = gateway.normalizeEvent(makePayload({ pay_currency: 'eth' }));
    expect(event.payment_method).toBe('crypto_eth');
  });

  test('sets paid_at on success status', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'finished', created_at: '2026-07-12T10:00:00Z' }));
    expect(event.paid_at).toBe('2026-07-12T10:00:00Z');
  });

  test('sets paid_at to null on non-success status', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_status: 'failed' }));
    expect(event.paid_at).toBeNull();
  });

  test('preserves metadata', () => {
    const meta = { project: 'test', ref: 'tx_1' };
    const event = gateway.normalizeEvent(makePayload(), meta);
    expect(event.metadata).toEqual(meta);
  });

  test('metadata defaults to null when not provided', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.metadata).toBeNull();
  });
});

describe('NowPaymentsGateway.verifySignature', () => {
  beforeAll(() => {
    process.env.API_KEY = 'test-api-key';
    process.env.ENCRYPTION_KEY = 'test-encryption-key';
    process.env.ADMIN_API_KEY = 'test-admin-api-key';
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret';
  });

  test('valid signature returns true', () => {
    const payload = { payment_id: 'np_1', payment_status: 'finished' };
    const expectedSig = require('crypto')
      .createHmac('sha512', 'test-ipn-secret')
      .update(JSON.stringify(payload))
      .digest('hex');
    const headers = { 'x-now-sig': expectedSig };
    expect(gateway.verifySignature(payload, headers)).toBe(true);
  });

  test('invalid signature returns false', () => {
    const payload = { payment_id: 'np_1', payment_status: 'finished' };
    const headers = { 'x-now-sig': 'deadbeef' };
    expect(gateway.verifySignature(payload, headers)).toBe(false);
  });

  test('missing x-now-sig header returns false', () => {
    const payload = { payment_id: 'np_1', payment_status: 'finished' };
    const headers: Record<string, string> = {};
    expect(gateway.verifySignature(payload, headers)).toBe(false);
  });
});
