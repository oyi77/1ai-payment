/**
 * Unit tests for the Midtrans gateway implementation.
 *
 * Covers status mapping, event normalization, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import crypto from 'crypto';
import { MidtransGateway } from '../../src/gateways/midtrans';

beforeAll(() => {
  process.env.MIDTRANS_SERVER_KEY = 'test_server_key';
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    order_id: 'pay_abc123',
    status_code: '200',
    gross_amount: '100000',
    signature_key: 'abc123signature',
    transaction_status: 'capture',
    payment_type: 'gopay',
    transaction_time: '2026-07-12T10:00:00Z',
    fraud_status: 'accept',
    ...overrides,
  };
}

const gateway = new MidtransGateway();

describe('MidtransGateway.normalizeEvent', () => {

  test('maps capture+accept to success', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'capture', fraud_status: 'accept' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('midtrans');
  });

  test('maps settlement to success', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'settlement' }));
    expect(event.status).toBe('success');
  });

  test('maps pending to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'pending' }));
    expect(event.status).toBe('pending');
  });

  test('maps deny to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'deny' }));
    expect(event.status).toBe('failed');
  });

  test('maps cancel to cancelled', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'cancel' }));
    expect(event.status).toBe('cancelled');
  });

  test('maps expire to expired', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'expire' }));
    expect(event.status).toBe('expired');
  });

  test('maps refund to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'refund' }));
    expect(event.status).toBe('failed');
  });

  test('extracts gateway_reference from order_id', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.gateway_reference).toBe('pay_abc123');
  });

  test('extracts amount from gross_amount', () => {
    const event = gateway.normalizeEvent(makePayload({ gross_amount: '50000' }));
    expect(event.amount).toBe(50000);
  });

  test('extracts payment_method from payment_type', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_type: 'bank_transfer' }));
    expect(event.payment_method).toBe('bank_transfer');
  });

  test('extracts currency', () => {
    const event = gateway.normalizeEvent(makePayload({ currency: 'IDR' }));
    expect(event.currency).toBe('IDR');
  });

  test('preserves metadata', () => {
    const meta = { project: 'test' };
    const event = gateway.normalizeEvent(makePayload(), meta);
    expect(event.metadata).toEqual(meta);
  });

  test('falls back to IDR when currency missing', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.currency).toBe('IDR');
  });

  test('unknown transaction_status defaults to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ transaction_status: 'unknown_status' }));
    expect(event.status).toBe('pending');
  });

});

describe('MidtransGateway.verifySignature', () => {
  test('valid SHA-512 signature_key passes', () => {
    const body = makePayload();
    const expected = crypto
      .createHash('sha512')
      .update(`${body.order_id}${body.status_code}${body.gross_amount}test_server_key`)
      .digest('hex');
    expect(gateway.verifySignature({ ...body, signature_key: expected }, {})).toBe(true);
  });

  test('tampered gross_amount fails', () => {
    const body = makePayload();
    const expected = crypto
      .createHash('sha512')
      .update(`${body.order_id}${body.status_code}${body.gross_amount}test_server_key`)
      .digest('hex');
    expect(
      gateway.verifySignature({ ...body, signature_key: expected, gross_amount: '999999' }, {}),
    ).toBe(false);
  });

  test('invalid signature_key fails', () => {
    expect(gateway.verifySignature(makePayload({ signature_key: 'deadbeef' }), {})).toBe(false);
  });

  test('missing signature_key returns false', () => {
    const { signature_key, ...rest } = makePayload();
    expect(gateway.verifySignature(rest, {})).toBe(false);
  });
});
