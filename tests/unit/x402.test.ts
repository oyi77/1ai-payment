/**
 * Unit tests for the x402 gateway implementation.
 *
 * Covers payment requirement building, event normalization, and signature verification.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { X402Gateway } from '../../src/gateways/x402';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.X402_WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
  process.env.X402_RPC_URL = 'https://test.base.org';
});

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: 'https://pay.test/pay/test123' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '1000000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      maxTimeoutSeconds: 300,
    }],
    ...overrides,
  };
}

const gateway = new X402Gateway();

describe('X402Gateway.createPayment', () => {
  test('returns payment requirement with USDC details', async () => {
    const result = await gateway.createPayment({
      amount: 1,
      currency: 'USD',
      orderId: 'order_123',
    });

    expect(result.gatewayReference).toBe('order_123');
    expect(result.paymentUrl).toBeTruthy();

    const parsed = JSON.parse(result.paymentUrl);
    expect(parsed.x402Version).toBe(2);
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0].scheme).toBe('exact');
    expect(parsed.accepts[0].network).toBe('eip155:8453');
    expect(parsed.accepts[0].amount).toBe('1000000');
    expect(parsed.accepts[0].payTo).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(result.expiresAt).toBeTruthy();
  });

  test('converts amount correctly: 1.50 USD -> 1500000 smallest unit', async () => {
    const result = await gateway.createPayment({
      amount: 1.5,
      currency: 'USD',
      orderId: 'order_150',
    });

    const parsed = JSON.parse(result.paymentUrl);
    expect(parsed.accepts[0].amount).toBe('1500000');
  });

  test('throws if X402_WALLET_ADDRESS is missing', async () => {
    const prev = process.env.X402_WALLET_ADDRESS;
    delete process.env.X402_WALLET_ADDRESS;

    await expect(
      gateway.createPayment({ amount: 1, currency: 'USD', orderId: 'no_wallet' }),
    ).rejects.toThrow('X402_WALLET_ADDRESS');

    process.env.X402_WALLET_ADDRESS = prev;
  });
});

describe('X402Gateway.verifySignature', () => {
  test('accepts valid signature payload', () => {
    const result = gateway.verifySignature({
      tx_hash: '0xabc123def456',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000000',
      payer: '0xabcdef1234567890abcdef1234567890abcdef12',
    }, {});

    expect(result).toBe(true);
  });

  test('rejects missing tx_hash', () => {
    const result = gateway.verifySignature({
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    }, {});

    expect(result).toBe(false);
  });

  test('rejects missing asset', () => {
    const result = gateway.verifySignature({
      tx_hash: '0xabc',
      network: 'eip155:8453',
    }, {});

    expect(result).toBe(false);
  });

  test('rejects non-evm network', () => {
    const result = gateway.verifySignature({
      tx_hash: '0xabc',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000',
    }, {});

    expect(result).toBe(false);
  });
});

describe('X402Gateway.normalizeEvent', () => {
  test('maps verified to success', () => {
    const event = gateway.normalizeEvent({
      order_id: 'ord_001',
      tx_hash: '0xabc',
      verified: true,
      amount: '1000000',
      network: 'eip155:8453',
    });

    expect(event.gateway).toBe('x402');
    expect(event.order_id).toBe('ord_001');
    expect(event.status).toBe('success');
    expect(event.amount).toBe(1);
    expect(event.currency).toBe('USD');
  });

  test('maps unverified to pending', () => {
    const event = gateway.normalizeEvent({
      order_id: 'ord_002',
      tx_hash: '0xdef',
      verified: false,
    });

    expect(event.status).toBe('pending');
  });

  test('extracts gateway_reference from tx_hash', () => {
    const event = gateway.normalizeEvent({
      order_id: 'ord_003',
      tx_hash: '0xdeadbeef',
      verified: true,
    });

    expect(event.gateway_reference).toBe('0xdeadbeef');
  });

  test('payment_method is network string', () => {
    const event = gateway.normalizeEvent({
      order_id: 'ord_004',
      network: 'eip155:8453',
      verified: true,
    });

    expect(event.payment_method).toBe('eip155:8453');
  });
});

describe('X402Gateway.paymentMethods', () => {
  test('returns USDC methods', () => {
    const methods = gateway.getPaymentMethods();
    expect(methods.length).toBeGreaterThanOrEqual(1);
    expect(methods.some(m => m.code.includes('usdc'))).toBe(true);
  });
});
