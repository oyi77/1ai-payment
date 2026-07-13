/**
 * Unit tests for the Telegram Payments gateway implementation.
 *
 * Covers webhook verification, event normalization, and status mapping.
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { TelegramPaymentsGateway } from '../../src/gateways/telegram-payments';

beforeAll(() => {
  process.env.API_KEY = 'test_api_key';
  process.env.ENCRYPTION_KEY = 'test_encryption_key';
  process.env.ADMIN_API_KEY = 'test_admin_key';
  process.env.TELEGRAM_BOT_TOKEN = 'bot:test';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'whsec_test';
  process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN = 'prov_test';
});

function makeSuccessUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      from: { id: 12345, first_name: 'Test', username: 'testuser' },
      chat: { id: 12345 },
      successful_payment: {
        currency: 'USD',
        total_amount: 1000,
        invoice_payload: '{"order_id":"pay_abc123"}',
        telegram_payment_charge_id: 'TG-PAY-001',
        provider_payment_charge_id: 'prov_charge_1',
      },
    },
    ...overrides,
  };
}

const gateway = new TelegramPaymentsGateway();

describe('TelegramPaymentsGateway.normalizeEvent', () => {

  test('extracts payment from successful_payment', () => {
    const event = gateway.normalizeEvent(makeSuccessUpdate());
    expect(event.status).toBe('success');
    expect(event.gateway).toBe('telegram_payments');
  });

  test('extracts order_id from invoice_payload', () => {
    const event = gateway.normalizeEvent(makeSuccessUpdate());
    expect(event.order_id).toBe('pay_abc123');
  });

  test('extracts gateway_reference from telegram_payment_charge_id', () => {
    const event = gateway.normalizeEvent(makeSuccessUpdate());
    expect(event.gateway_reference).toBe('TG-PAY-001');
  });

  test('extracts amount', () => {
    const update = makeSuccessUpdate();
    update.message.successful_payment.total_amount = 500;
    const event = gateway.normalizeEvent(update);
    expect(event.amount).toBe(500);
  });

  test('extracts currency', () => {
    const event = gateway.normalizeEvent(makeSuccessUpdate());
    expect(event.currency).toBe('USD');
  });

  test('no recognized payment throws error', () => {
    expect(() => gateway.normalizeEvent({ update_id: 3 })).toThrow('Unknown Telegram payment update type');
  });

  test('preserves metadata', () => {
    const meta = { project: 'myapp' };
    const event = gateway.normalizeEvent(makeSuccessUpdate(), meta);
    expect(event.metadata).toEqual(meta);
  });
});

describe('TelegramPaymentsGateway.verifySignature', () => {

  test('valid x-telegram-bot-api-secret-token passes', () => {
    expect(gateway.verifySignature(makeSuccessUpdate(), {
      'x-telegram-bot-api-secret-token': 'whsec_test',
    })).toBe(true);
  });

  test('invalid token fails', () => {
    expect(gateway.verifySignature(makeSuccessUpdate(), {
      'x-telegram-bot-api-secret-token': 'wrong',
    })).toBe(false);
  });

  test('missing header returns false', () => {
    expect(gateway.verifySignature(makeSuccessUpdate(), {})).toBe(false);
  });
});
