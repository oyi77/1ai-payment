/**
 * Unit tests for the ERC-8183 gateway implementation.
 *
 * Covers escrow creation, event normalization, attestation parsing, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { ERC8183Gateway } from '../../src/gateways/erc8183';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.ERC8183_TOKEN_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  process.env.ERC8183_NETWORK = 'eip155:8453';
  process.env.ERC8183_WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    escrow_id: 'escrow_test_001',
    evaluator: '0xevaluator1234567890abcdef1234567890abcdef',
    status: 'released',
    amount: 50,
    ...overrides,
  };
}

const gateway = new ERC8183Gateway();

describe('ERC8183Gateway.createPayment', () => {
  test('creates escrow with metadata', async () => {
    const result = await gateway.createPayment({
      amount: 50,
      currency: 'USD',
      orderId: 'escrow_001',
      metadata: {
        employer: '0xemployer1234567890abcdef1234567890abcdef',
        provider: '0xprovider1234567890abcdef1234567890abcdef',
        evaluator: '0xevaluator1234567890abcdef1234567890abcdef',
        job_title: 'Generate 10 product images',
        deliverables: '10 high-quality product images for affiliate marketing',
      },
    });

    expect(result.gatewayReference).toBe('escrow_001');
    expect(result.paymentUrl).toBeTruthy();

    const parsed = JSON.parse(result.paymentUrl);
    expect(parsed.status).toBe('pending');
    expect(parsed.job.title).toBe('Generate 10 product images');
    expect(parsed.job.budget).toBe('50');
    expect(parsed.employer).toBe('0xemployer1234567890abcdef1234567890abcdef');
    expect(parsed.provider).toBe('0xprovider1234567890abcdef1234567890abcdef');
    expect(parsed.evaluator).toBe('0xevaluator1234567890abcdef1234567890abcdef');
    expect(parsed.tokenAmount).toBe('50');
    expect(parsed.createdAt).toBeTruthy();
    expect(parsed.timeoutAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('generates escrow ID from orderId', async () => {
    const result = await gateway.createPayment({
      amount: 100,
      currency: 'USD',
      orderId: 'custom_escrow_id',
      metadata: {
        employer: '0xemp',
        provider: '0xprov',
        evaluator: '0xeval',
      },
    });

    expect(result.gatewayReference).toBe('custom_escrow_id');
  });

  test('uses defaults for missing metadata fields', async () => {
    const result = await gateway.createPayment({
      amount: 25,
      currency: 'USD',
      orderId: 'minimal_escrow',
      metadata: {
        employer: '0xemp',
        provider: '0xprov',
        evaluator: '0xeval',
      },
    });

    const parsed = JSON.parse(result.paymentUrl);
    expect(parsed.job.title).toBe('ERC-8183 Escrow');
    expect(parsed.job.description).toBe('');
  });
});

describe('ERC8183Gateway.verifySignature', () => {
  test('accepts valid attestation', () => {
    const result = gateway.verifySignature({
      escrow_id: 'escrow_001',
      evaluator: '0xevaluator1234567890abcdef1234567890abcdef',
      approved: true,
    }, {});

    expect(result).toBe(true);
  });

  test('rejects missing escrow_id', () => {
    const result = gateway.verifySignature({
      evaluator: '0xevaluator',
      approved: true,
    }, {});

    expect(result).toBe(false);
  });

  test('rejects missing evaluator', () => {
    const result = gateway.verifySignature({
      escrow_id: 'escrow_001',
      approved: true,
    }, {});

    expect(result).toBe(false);
  });

  test('accepts status-based attestation format', () => {
    const result = gateway.verifySignature({
      escrow_id: 'escrow_001',
      evaluator: '0xeval',
      status: 'completed',
    }, {});

    expect(result).toBe(true);
  });
});

describe('ERC8183Gateway.normalizeEvent', () => {
  test('maps released to success', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'released' }));

    expect(event.gateway).toBe('erc8183');
    expect(event.order_id).toBe('escrow_test_001');
    expect(event.status).toBe('success');
    expect(event.amount).toBe(50);
    expect(event.currency).toBe('USD');
  });

  test('maps pending to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'pending' }));

    expect(event.status).toBe('pending');
  });

  test('maps cancelled to cancelled', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'cancelled' }));

    expect(event.status).toBe('cancelled');
  });

  test('maps disputed to failed', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'disputed' }));

    expect(event.status).toBe('failed');
  });

  test('maps funded to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'funded' }));

    expect(event.status).toBe('pending');
  });

  test('maps in_progress to pending', () => {
    const event = gateway.normalizeEvent(makePayload({ status: 'in_progress' }));

    expect(event.status).toBe('pending');
  });

  test('extracts order_id from escrow_id', () => {
    const event = gateway.normalizeEvent(makePayload({ escrow_id: 'escrow_custom' }));

    expect(event.order_id).toBe('escrow_custom');
  });

  test('payment_method is erc8183_escrow', () => {
    const event = gateway.normalizeEvent(makePayload());

    expect(event.payment_method).toBe('erc8183_escrow');
  });
});

describe('ERC8183Gateway.paymentMethods', () => {
  test('returns escrow method', () => {
    const methods = gateway.getPaymentMethods();
    expect(methods).toHaveLength(1);
    expect(methods[0].code).toBe('erc8183_escrow');
  });
});
