/**
 * Unit tests for the iPaymu gateway implementation.
 *
 * Covers status mapping (Indonesian status names), event normalization,
 * and signature verification (HMAC-SHA256 over normalized+sorted JSON).
 *
 * Signature scheme verified against official iPaymu docs:
 * https://docs.ipaymu.com/en/docs/callback#signature-validation
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

/**
 * Realistic iPaymu callback payload (based on official docs example).
 * https://docs.ipaymu.com/en/docs/callback#complete-payload-examples
 */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    trx_id: '12345678',
    sid: 'SESSION789',
    reference_id: 'pay_abc123',
    status: 'berhasil',
    status_code: '1',
    amount: '100000',
    total: '100000',
    sub_total: '100000',
    fee: '1500',
    paid_off: '98500',
    via: 'va',
    channel: 'bca',
    merchant: 'test_va_key',
    buyer_email: 'customer@example.com',
    buyer_name: 'John Doe',
    buyer_phone: '081234567890',
    created_at: '2025-11-11 10:00:00',
    expired_at: '2025-11-11 11:00:00',
    paid_at: '2025-11-11 10:10:52',
    payment_no: '1234567890',
    url: 'https://pay.berkahkarya.org/webhook/ipaymu',
    additional_info: '[]',
    transaction_status_code: '1',
    settlement_status: 'unsettle',
    settlement_date: null,
    is_escrow: '0',
    is_refund: '0',
    is_sandbox: 'false',
    unique_code: '0',
    expired_time: '3600',
    expired_unix: '1762842000',
    merchant_name: 'Test Store',
    system_notes: 'Payment completed',
    product: 'Test Product',
    quantity: '1',
    trscode: 'TRX789012',
    status_desc: 'Success',
    referenceId: 'pay_abc123',
    ...overrides,
  };
}

/**
 * Official iPaymu signature computation (mirrors docs example code exactly).
 * Used to generate test signatures that the implementation must accept.
 */
function computeOfficialSignature(rawBody: Record<string, unknown>, vaKey: string): string {
  const intFields = ['trx_id', 'status_code', 'transaction_status_code', 'paid_off'];

  // Step 1-2: Normalize data types
  const normalized: Record<string, unknown> = {};
  for (const key in rawBody) {
    const val = rawBody[key];
    if (key === 'is_escrow') {
      normalized[key] = val === 'true' || val === '1' || val === 1;
    } else if (intFields.includes(key)) {
      normalized[key] = parseInt(String(val), 10);
    } else if (key === 'additional_info') {
      normalized[key] = val === '[]' ? [] : val;
    } else {
      normalized[key] = String(val);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'additional_info')) {
    normalized['additional_info'] = [];
  }

  // Step 3: Remove signature field if present
  if (normalized.signature) delete normalized.signature;

  // Step 4: Sort keys A-Z (PHP ksort)
  const sortedKeys = Object.keys(normalized).sort((a, b) => a.localeCompare(b));
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = normalized[key];
  }

  // Step 5-6: JSON.stringify + escape forward slashes
  let jsonBody = JSON.stringify(sorted);
  jsonBody = jsonBody.replace(/\//g, '\\/');

  // Step 7: HMAC-SHA256 with VA as key
  return crypto.createHmac('sha256', vaKey).update(jsonBody).digest('hex');
}

const gateway = new IPaymuGateway();
const VA_KEY = 'test_va_key';

describe('IPaymuGateway.normalizeEvent', () => {

  test('maps berhasil to success', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'berhasil' }));
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('ipaymu');
  });

  test('maps pending to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'pending' }));
    expect(event.status).toBe('pending');
  });

  test('maps gagal to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'gagal' }));
    expect(event.status).toBe('failed');
  });

  test('maps expired to expired', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'expired' }));
    expect(event.status).toBe('expired');
  });

  test('maps dibatalkan to cancelled', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'dibatalkan' }));
    expect(event.status).toBe('cancelled');
  });

  test('unknown status defaults to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'unknown_status' }));
    expect(event.status).toBe('pending');
  });

  test('extracts order_id from reference_id', () => {
    const event = gateway.normalizeEvent(makePayload({ reference_id: 'order_42' }));
    expect(event.order_id).toBe('order_42');
  });

  test('extracts gateway_reference from trx_id', () => {
    const event = gateway.normalizeEvent(makePayload({ trx_id: '99999' }));
    expect(event.gateway_reference).toBe('99999');
  });

  test('extracts amount via parseInt', () => {
    const event = gateway.normalizeEvent(makePayload({ amount: '50000' }));
    expect(event.amount).toBe(50000);
  });

  test('extracts payment_method from via', () => {
    const event = gateway.normalizeEvent(makePayload({ via: 'qris', channel: 'gopay' }));
    expect(event.payment_method).toBe('qris');
  });

  test('falls back to channel when via is absent', () => {
    const event = gateway.normalizeEvent(makePayload({ via: '', channel: 'gopay' }));
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

  test('valid HMAC-SHA256 signature in X-Signature header passes', async () => {
    const body = makePayload();
    const sig = computeOfficialSignature(body, VA_KEY);
    expect(
      await gateway.verifySignature(body, { 'x-signature': sig }),
    ).toBe(true);
  });

  test('valid signature in X-Signature header (capital case) passes', async () => {
    const body = makePayload();
    const sig = computeOfficialSignature(body, VA_KEY);
    expect(
      await gateway.verifySignature(body, { 'X-Signature': sig }),
    ).toBe(true);
  });

  test('invalid signature fails', async () => {
    const body = makePayload();
    expect(
      await gateway.verifySignature(body, { 'x-signature': 'deadbeef' }),
    ).toBe(false);
  });

  test('missing X-Signature header returns false', async () => {
    const body = makePayload();
    expect(await gateway.verifySignature(body, {})).toBe(false);
  });

  test('signature with body containing signature field still works (field is stripped)', async () => {
    const body = makePayload({ signature: 'should_be_ignored' });
    const sig = computeOfficialSignature(body, VA_KEY);
    expect(
      await gateway.verifySignature(body, { 'x-signature': sig }),
    ).toBe(true);
  });

  test('tampered amount fails signature', async () => {
    const body = makePayload();
    const sig = computeOfficialSignature(body, VA_KEY);
    // Tamper with amount after computing signature
    const tampered = { ...body, amount: '999999' };
    expect(
      await gateway.verifySignature(tampered, { 'x-signature': sig }),
    ).toBe(false);
  });

  test('missing VA key returns false', async () => {
    const originalVa = process.env.IPAYMU_VA_KEY;
    delete process.env.IPAYMU_VA_KEY;
    const body = makePayload();
    const sig = computeOfficialSignature(body, VA_KEY);
    expect(
      await gateway.verifySignature(body, { 'x-signature': sig }),
    ).toBe(false);
    process.env.IPAYMU_VA_KEY = originalVa;
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
    try {
      await gw.createPayment({ amount: 10000, currency: 'IDR', orderId: 'ord_fx', paymentMethod: 'bca' });
    } catch (e: unknown) {
      expect(e).not.toBeInstanceOf(ValidationError);
    }
  });
});
