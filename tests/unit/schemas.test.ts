/**
 * Unit tests for merchant Zod schemas.
 */
import { describe, expect, test } from 'bun:test';
import {
  amountSchema,
  createMerchantBodySchema,
  createMerchantResponseSchema,
  createPaymentBodySchema,
  createRefundBodySchema,
  merchantResponseSchema,
  errorSchema,
} from '../../src/schemas';

describe('createMerchantBodySchema', () => {
  test('accepts name without plan', () => {
    const result = createMerchantBodySchema.parse({ name: 'My Store' });
    expect(result.name).toBe('My Store');
    expect(result.plan).toBeUndefined(); // plan is admin-managed, not self-assignable
    expect(result.default_callback_url).toBeUndefined();
  });

  test('rejects explicit plan (strict body, admin-only)', () => {
    const result = createMerchantBodySchema.safeParse({ name: 'Pro Store', plan: 'pro' });
    expect(result.success).toBe(false);
  });

  test('rejects enterprise plan (strict body, admin-only)', () => {
    const result = createMerchantBodySchema.safeParse({ name: 'Enterprise Store', plan: 'enterprise' });
    expect(result.success).toBe(false);
  });

  test('accepts default_callback_url', () => {
    const result = createMerchantBodySchema.parse({
      name: 'Callback Store',
      default_callback_url: 'https://example.com/callback',
    });
    expect(result.default_callback_url).toBe('https://example.com/callback');
  });

  test('rejects empty name', () => {
    const result = createMerchantBodySchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  test('rejects name over 100 chars', () => {
    const result = createMerchantBodySchema.safeParse({ name: 'a'.repeat(101) });
    expect(result.success).toBe(false);
  });

  test('rejects invalid plan value (strict body)', () => {
    const result = createMerchantBodySchema.safeParse({ name: 'Store', plan: 'gold' });
    expect(result.success).toBe(false);
  });
  test('rejects invalid url', () => {
    const result = createMerchantBodySchema.safeParse({
      name: 'Store',
      default_callback_url: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing name', () => {
    const result = createMerchantBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('createMerchantResponseSchema', () => {
  test('accepts valid success response', () => {
    const payload = {
      success: true as const,
      data: {
        merchant: {
          id: 'merch_abc123',
          name: 'My Store',
          default_callback_url: null,
          active: true,
          plan: 'free',
          created_at: '2026-07-12T00:00:00.000Z',
          updated_at: '2026-07-12T00:00:00.000Z',
        },
        api_key: '1pay_abc123def456',
        webhook_secret: 'whsec_abc123def456',
      },
    };
    const result = createMerchantResponseSchema.parse(payload);
    expect(result.data.merchant.id).toBe('merch_abc123');
    expect(result.data.api_key).toBe('1pay_abc123def456');
    expect(result.data.webhook_secret).toBe('whsec_abc123def456');
  });

  test('rejects missing api_key', async () => {
    const payload = {
      success: true as const,
      data: {
        merchant: {
          id: 'merch_abc123',
          name: 'Store',
          default_callback_url: null,
          active: true,
          plan: 'free',
          created_at: '2026-07-12T00:00:00.000Z',
          updated_at: '2026-07-12T00:00:00.000Z',
        },
      },
    };
    const result = createMerchantResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test('rejects success: false', () => {
    const result = createMerchantResponseSchema.safeParse({
      success: false,
      data: { merchant: null as unknown as typeof merchantResponseSchema.type, api_key: null },
    });
    expect(result.success).toBe(false);
  });
});

describe('errorSchema', () => {
  test('accepts valid error payload', () => {
    const result = errorSchema.parse({
      success: false,
      error: { code: 'INVALID_BODY', message: 'gateway is required' },
    });
    expect(result.error.code).toBe('INVALID_BODY');
    expect(result.error.message).toBe('gateway is required');
  });

  test('rejects missing error field', () => {
    const result = errorSchema.safeParse({ success: false });
    expect(result.success).toBe(false);
  });

  test('rejects success: true', () => {
    const result = errorSchema.safeParse({
      success: true,
      error: { code: 'INVALID', message: 'test' },
    });
    expect(result.success).toBe(false);
  });
});

describe('amountSchema (Sweep171 minor-units ceiling)', () => {
	test('accepts normal minor-unit amounts', () => {
		expect(amountSchema.safeParse(100000).success).toBe(true);
		expect(amountSchema.safeParse(1).success).toBe(true);
	});

	test('rejects zero, negative, and fractional amounts', () => {
		expect(amountSchema.safeParse(0).success).toBe(false);
		expect(amountSchema.safeParse(-500).success).toBe(false);
		expect(amountSchema.safeParse(10.5).success).toBe(false);
	});

	test('rejects magnitudes past MAX_SAFE_INTEGER', () => {
		expect(amountSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
		expect(amountSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
		expect(amountSchema.safeParse(1e30).success).toBe(false);
	});

	test('create+refund bodies inherit the ceiling', () => {
		const base = {
			gateway: 'midtrans',
			callback_url: 'https://example.com/callback',
		};
		expect(
			createPaymentBodySchema.safeParse({ ...base, amount: 1e30 }).success,
		).toBe(false);
		expect(
			createPaymentBodySchema.safeParse({ ...base, amount: 10.5 }).success,
		).toBe(false);
		expect(
			createRefundBodySchema.safeParse({ order_id: 'pay_x', amount: 1e30 }).success,
		).toBe(false);
	});
});
