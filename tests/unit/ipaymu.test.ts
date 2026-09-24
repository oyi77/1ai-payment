/**
 * Unit tests for the iPaymu gateway implementation.
 *
 * Covers status mapping, event normalization, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import crypto from 'crypto';
import { IPaymuGateway } from '../../src/gateways/ipaymu';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.IPAYMU_API_KEY = 'test_ipaymu_key';
  process.env.IPAYMU_VA_KEY = 'test_va_key';
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    order_id: 'pay_abc123',
    status: 'success',
    amount: '100000',
    payment_method: 'va',
    reference_id: 'IPAYMU-REF-001',
    signature: '',
    ...overrides,
  };
}

const gateway = new IPaymuGateway();

describe('IPaymuGateway.normalizeEvent', () => {

  test('maps success to success', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'success' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('ipaymu');
  });

  test('maps pending to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'pending' }));
    expect(event.status).toBe('pending');
  });

  test('maps failed to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'failed' }));
    expect(event.status).toBe('failed');
  });

  test('maps expired to expired', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'expired' }));
    expect(event.status).toBe('expired');
  });

  test('maps cancelled to cancelled', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'cancelled' }));
    expect(event.status).toBe('cancelled');
  });

  test('unknown status defaults to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'unknown_status' }));
    expect(event.status).toBe('pending');
  });

  test('extracts order_id', () => {
    const event = gateway.normalizeEvent(makePayload({ order_id: 'order_42' }));
    expect(event.order_id).toBe('order_42');
  });

  test('extracts gateway_reference from reference_id', () => {
    const event = gateway.normalizeEvent(makePayload());
    expect(event.gateway_reference).toBe('IPAYMU-REF-001');
  });

  test('extracts amount via parseInt', () => {
    const event = gateway.normalizeEvent(makePayload({ amount: '50000' }));
    expect(event.amount).toBe(50000);
  });

  test('extracts payment_method', () => {
    const event = gateway.normalizeEvent(makePayload({ payment_method: 'gopay' }));
    expect(event.payment_method).toBe('gopay');
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
});

describe('IPaymuGateway.verifySignature', () => {

  test('valid SHA-256 signature passes', async () => {
    const body = makePayload();
    // SHA256(va_key + order_id + status + amount + api_key)
    const expected = crypto
      .createHash('sha256')
      .update(`test_va_key${body.order_id}${body.status}${body.amount}test_ipaymu_key`)
      .digest('hex');
    expect(await gateway.verifySignature({ ...body, signature: expected }, {})).toBe(true);
  });

  test('invalid signature fails', async () => {
    const body = makePayload({ signature: 'bad_sig' });
    expect(await gateway.verifySignature(body, {})).toBe(false);
  });

  test('missing signature field returns false', async () => {
    expect(await gateway.verifySignature({ order_id: 'x', status: 'x', amount: 'x' }, {})).toBe(false);
  });
});
describe('IPaymuGateway.createPayment currency guard', () => {
  test('rejects non-IDR currency (no dollar-as-rupiah billing)', async () => {
    const { IPaymuGateway } = await import('../../src/gateways/ipaymu');
    const gw = new IPaymuGateway();
    await expect(
      gw.createPayment({ amount: 1000, currency: 'USD', orderId: 'ord_fx' }),
    ).rejects.toThrow(/IDR only/);
  });
});
describe('IPaymuGateway.createPayment method guard (Sweep127)', () => {
  test('rejects hostile payment_method shape (400-class)', async () => {
    const { IPaymuGateway } = await import('../../src/gateways/ipaymu');
    const { ValidationError } = await import('../../src/utils/errors');
    const gw = new IPaymuGateway();
    const err = await gw.createPayment({ amount: 10000, currency: 'IDR', orderId: 'ord_fx', paymentMethod: '<script>alert(1)</script>' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).statusCode).toBe(400);
  });
  test('natural codes pass the shape check (no code-list false-reject)', async () => {
    const { IPaymuGateway } = await import('../../src/gateways/ipaymu');
    const { ValidationError } = await import('../../src/utils/errors');
    const gw = new IPaymuGateway();
    // 'bca' is not in every gateway's list spelling, but must not 400 here
    // (it fails later on creds/network, never on validation).
    try {
      await gw.createPayment({ amount: 10000, currency: 'IDR', orderId: 'ord_fx', paymentMethod: 'bca' });
    } catch (e: unknown) {
      expect(e).not.toBeInstanceOf(ValidationError);
    }
  });
});
