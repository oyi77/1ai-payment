/**
 * Unit tests for the PayPal gateway implementation.
 *
 * Covers event normalization, status mapping, and gateway-level verifySignature.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { PayPalGateway } from '../../src/gateways/paypal';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.PAYPAL_CLIENT_ID = 'test_client_id';
  process.env.PAYPAL_CLIENT_SECRET = 'test_client_secret';
  process.env.PAYPAL_WEBHOOK_ID = 'wh_id';
  process.env.PAYPAL_WEBHOOK_SECRET = 'wh_secret';
});

function makeWebhookEvent(eventType: string, resourceStatus: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'PAYPAL-EVT-001',
    event_type: eventType,
    resource_type: 'checkout-order',
    resource: {
      id: 'ORDER-123',
      status: resourceStatus,
      amount: { currency_code: 'USD', value: '100.00' },
      custom_id: overrides.custom_id || 'pay_abc123',
      invoice_id: overrides.invoice_id || undefined,
      create_time: '2026-07-12T10:00:00Z',
      update_time: '2026-07-12T10:01:00Z',
    },
    create_time: '2026-07-12T10:01:00Z',
    ...overrides,
  };
}

const gateway = new PayPalGateway();

describe('PayPalGateway.normalizeEvent', () => {

  test('maps CHECKOUT.ORDER.APPROVED with COMPLETED to success', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'COMPLETED')
    );
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('paypal');
  });

  test('maps CHECKOUT.ORDER.APPROVED with APPROVED to pending', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'APPROVED')
    );
    expect(event.status).toBe('pending');
  });

  test('maps PAYMENT.CAPTURE.COMPLETED to success', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('PAYMENT.CAPTURE.COMPLETED', 'COMPLETED')
    );
    expect(event.status).toBe('success');
  });

  test('maps PAYMENT.CAPTURE.DENIED to failed', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('PAYMENT.CAPTURE.DENIED', 'DENIED')
    );
    expect(event.status).toBe('failed');
  });

  test('maps PAYMENT.CAPTURE.REFUNDED to refunded', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('PAYMENT.CAPTURE.REFUNDED', 'COMPLETED'),
      undefined,
    );
    expect(event.status).toBe('refunded');
  });

  test('maps CHECKOUT.ORDER.CANCELLED to cancelled', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.CANCELLED', 'CANCELLED')
    );
    expect(event.status).toBe('cancelled');
  });

  test('unknown event_type defaults to pending', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('UNKNOWN.EVENT', 'COMPLETED')
    );
    expect(event.status).toBe('pending');
  });

  test('extracts order_id from custom_id', () => {
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'COMPLETED', { custom_id: 'order_42' })
    );
    expect(event.order_id).toBe('order_42');
  });

  test('extracts gateway_reference from resource.id', () => {
    const resource = { id: 'ORDER-789', amount: { currency_code: 'USD', value: '100.00' } };
    const custom = { resource };
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'COMPLETED', custom)
    );
    expect(event.gateway_reference).toBe('ORDER-789');
  });

  test('extracts amount from resource.amount.value in cents', () => {
    const resource = { amount: { currency_code: 'USD', value: '25.50' } };
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'COMPLETED', { resource })
    );
    // USD amounts are converted to cents: 25.50 * 100 = 2550
    expect(event.amount).toBe(2550);
  });

  test('extracts currency', () => {
    const resource = { amount: { currency_code: 'EUR', value: '50.00' } };
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'COMPLETED', { resource })
    );
    expect(event.currency).toBe('EUR');
  });

  test('preserves metadata', () => {
    const meta = { project: 'test' };
    const event = gateway.normalizeEvent(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'COMPLETED'),
      meta,
    );
    expect(event.metadata).toEqual(meta);
  });
});

describe('PayPalGateway.verifySignature', () => {
  // Previously returned true always (sync stub). Now actually calls PayPal's API
  // via the async verifySignature function from webhook.ts.
  // Without configured PayPal env vars, it returns false.

  test('returns false without configured PayPal credentials', async () => {
    const result = await gateway.verifySignature(
      makeWebhookEvent('CHECKOUT.ORDER.APPROVED', 'COMPLETED'),
      {},
    );
    expect(result).toBe(false);
  });
});
