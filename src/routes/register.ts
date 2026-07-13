/**
 * Registration routes — API endpoint for merchant self-registration.
 *
 * - POST /api/register — register a new merchant (returns merchant + api_key)
 *
 * No API key required (public endpoint).
 * OpenAPI spec from Zod schemas.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { getDb } from '../config/database';
import {
  generateMerchantId,
  generateApiKey,
  generateWebhookSecret,
  sha256Hash,
} from '../utils/crypto';
import { logger } from '../utils/logger';
import {
  createMerchantBodySchema,
  createMerchantResponseSchema,
  errorSchema,
  defaultHook,
} from '../schemas';

export const registerRoutes = new OpenAPIHono({ defaultHook });

const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  tags: ['Registration'],
  summary: 'Register a new merchant',
  description:
    'Creates a merchant account and returns the merchant details plus a freshly generated API key. ' +
    'The API key is shown ONCE and cannot be retrieved later.',
  request: {
    body: {
      content: { 'application/json': { schema: createMerchantBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Merchant registered successfully',
      content: { 'application/json': { schema: createMerchantResponseSchema } },
    },
    400: {
      description: 'Invalid input',
      content: { 'application/json': { schema: errorSchema } },
    },
    409: {
      description: 'Merchant already exists',
      content: { 'application/json': { schema: errorSchema } },
    },
  },
});

registerRoutes.openapi(registerRoute, async (c) => {
  const body = c.req.valid('json');

  const db = getDb();

  const id = generateMerchantId();
  const apiKey = generateApiKey();
  const apiKeyHash = sha256Hash(apiKey);
  const webhookSecret = generateWebhookSecret();

  try {
    await db.execute({
      sql: `INSERT INTO merchants (id, name, api_key_hash, webhook_secret, default_callback_url, active, plan)
            VALUES (?, ?, ?, ?, ?, 1, ?)`,
      args: [id, body.name, apiKeyHash, webhookSecret, body.default_callback_url ?? null, body.plan],
    });

    logger.info('Merchant registered', { id, name: body.name, plan: body.plan });

    return c.json({
      success: true as const,
      data: {
        merchant: {
          id,
          name: body.name,
          default_callback_url: body.default_callback_url ?? null,
          active: true,
          plan: body.plan,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        api_key: apiKey,
      },
    }, 201);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      return c.json({ success: false as const, error: { code: 'DUPLICATE', message: 'Merchant already exists' } }, 409);
    }
    throw err;
  }
});
