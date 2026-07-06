/**
 * Merchant routes — CRUD for merchant accounts.
 *
 * - POST   /api/merchants           — create merchant (returns API key once)
 * - GET    /api/merchants           — list all merchants
 * - GET    /api/merchants/:id       — get merchant details
 * - PATCH  /api/merchants/:id       — update merchant
 * - POST   /api/merchants/:id/api-key — rotate API key (returns new key once)
 *
 * All endpoints require API key authentication.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../config/database';
import { generateMerchantId, generateApiKey, generateWebhookSecret, sha256Hash, encrypt } from '../utils/crypto';
import { logger } from '../utils/logger';
import { GATEWAY_NAMES } from '../schemas';
import {
  createMerchantBodySchema,
  updateMerchantBodySchema,
  merchantResponseSchema,
  createMerchantResponseSchema,
  rotateKeyResponseSchema,
  errorSchema,
  defaultHook,
  setGatewayCredentialsBodySchema,
  merchantGatewayResponseSchema,
  toggleGatewayBodySchema,
} from '../schemas';

export const merchantRoutes = new OpenAPIHono({ defaultHook });

merchantRoutes.use('/*', authMiddleware);

// ── POST /api/merchants ─────────────────────────────────────────

const createMerchantRoute = createRoute({
  method: 'post',
  path: '/merchants',
  tags: ['Merchants'],
  summary: 'Create a merchant',
  description: 'Creates a new merchant account and returns the API key. The key is shown ONCE — store it securely.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: createMerchantBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Merchant created.',
      content: { 'application/json': { schema: createMerchantResponseSchema } },
    },
    400: { description: 'Invalid request.', content: { 'application/json': { schema: errorSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    409: { description: 'Duplicate merchant.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(createMerchantRoute, async (c) => {
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

    logger.info('Merchant created', { id, name: body.name, plan: body.plan });

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
      return c.json({
        success: false as const,
        error: { code: 'DUPLICATE', message: 'Merchant with this API key already exists' },
      }, 409);
    }
    throw err;
  }
});

// ── GET /api/merchants ──────────────────────────────────────────

const listMerchantsRoute = createRoute({
  method: 'get',
  path: '/merchants',
  tags: ['Merchants'],
  summary: 'List all merchants',
  description: 'Returns all merchant accounts (no API keys — hashes only).',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: 'Merchant list.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: z.array(merchantResponseSchema) }),
        },
      },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(listMerchantsRoute, async (c) => {
  const db = getDb();
  const result = await db.execute(
    'SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants ORDER BY created_at DESC'
  );

  return c.json({
    success: true as const,
    data: result.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      default_callback_url: row.default_callback_url as string | null,
      active: Boolean(row.active),
      plan: row.plan as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    })),
  }, 200);
});

// ── GET /api/merchants/:id ──────────────────────────────────────

const getMerchantRoute = createRoute({
  method: 'get',
  path: '/merchants/{id}',
  tags: ['Merchants'],
  summary: 'Get merchant details',
  description: 'Returns merchant account details by ID.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string().openapi({ example: 'merch_abc123' }) }),
  },
  responses: {
    200: {
      description: 'Merchant found.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: merchantResponseSchema }),
        },
      },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Merchant not found.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(getMerchantRoute, async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb();

  const result = await db.execute({
    sql: 'SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants WHERE id = ?',
    args: [id],
  });

  if (result.rows.length === 0) {
    return c.json({
      success: false as const,
      error: { code: 'NOT_FOUND', message: `Merchant not found: ${id}` },
    }, 404);
  }

  const row = result.rows[0];
  return c.json({
    success: true as const,
    data: {
      id: row.id as string,
      name: row.name as string,
      default_callback_url: row.default_callback_url as string | null,
      active: Boolean(row.active),
      plan: row.plan as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    },
  }, 200);
});

// ── PATCH /api/merchants/:id ────────────────────────────────────

const updateMerchantRoute = createRoute({
  method: 'patch',
  path: '/merchants/{id}',
  tags: ['Merchants'],
  summary: 'Update merchant',
  description: 'Updates merchant name, callback URL, active status, or plan.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string().openapi({ example: 'merch_abc123' }) }),
    body: {
      content: { 'application/json': { schema: updateMerchantBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Merchant updated.',
      content: {
        'application/json': {
          schema: z.object({ success: z.literal(true), data: merchantResponseSchema }),
        },
      },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Merchant not found.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(updateMerchantRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb();

  // Check exists
  const existing = await db.execute({
    sql: 'SELECT id FROM merchants WHERE id = ?',
    args: [id],
  });
  if (existing.rows.length === 0) {
    return c.json({
      success: false as const,
      error: { code: 'NOT_FOUND', message: `Merchant not found: ${id}` },
    }, 404);
  }

  const updates: string[] = ["updated_at = datetime('now')"];
  const args: Array<string | number | null> = [];

  if (body.name !== undefined) { updates.push('name = ?'); args.push(body.name); }
  if (body.default_callback_url !== undefined) { updates.push('default_callback_url = ?'); args.push(body.default_callback_url); }
  if (body.active !== undefined) { updates.push('active = ?'); args.push(body.active ? 1 : 0); }
  if (body.plan !== undefined) { updates.push('plan = ?'); args.push(body.plan); }

  args.push(id);
  await db.execute({
    sql: `UPDATE merchants SET ${updates.join(', ')} WHERE id = ?`,
    args,
  });

  logger.info('Merchant updated', { id });

  // Re-read
  const result = await db.execute({
    sql: 'SELECT id, name, default_callback_url, active, plan, created_at, updated_at FROM merchants WHERE id = ?',
    args: [id],
  });
  const row = result.rows[0];

  return c.json({
    success: true as const,
    data: {
      id: row.id as string,
      name: row.name as string,
      default_callback_url: row.default_callback_url as string | null,
      active: Boolean(row.active),
      plan: row.plan as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    },
  }, 200);
});

// ── POST /api/merchants/:id/api-key ─────────────────────────────

const rotateKeyRoute = createRoute({
  method: 'post',
  path: '/merchants/{id}/api-key',
  tags: ['Merchants'],
  summary: 'Rotate API key',
  description: 'Generates a new API key for the merchant. The old key is immediately invalidated. New key shown ONCE.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string().openapi({ example: 'merch_abc123' }) }),
  },
  responses: {
    200: {
      description: 'API key rotated.',
      content: { 'application/json': { schema: rotateKeyResponseSchema } },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Merchant not found.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(rotateKeyRoute, async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb();

  const existing = await db.execute({
    sql: 'SELECT id FROM merchants WHERE id = ?',
    args: [id],
  });
  if (existing.rows.length === 0) {
    return c.json({
      success: false as const,
      error: { code: 'NOT_FOUND', message: `Merchant not found: ${id}` },
    }, 404);
  }

  const newApiKey = generateApiKey();
  const newHash = sha256Hash(newApiKey);

  await db.execute({
    sql: "UPDATE merchants SET api_key_hash = ?, updated_at = datetime('now') WHERE id = ?",
    args: [newHash, id],
  });

  logger.info('Merchant API key rotated', { id });

  return c.json({
    success: true as const,
    data: {
      merchant_id: id,
      api_key: newApiKey,
    },
  }, 200);
});
// ── GET /api/merchants/:id/gateways ─────────────────────────────

const listGatewaysRoute = createRoute({
  method: 'get',
  path: '/merchants/{id}/gateways',
  tags: ['Merchants'],
  summary: 'List merchant gateway configs',
  description: 'Returns configured gateways for the merchant.',
  security: [{ ApiKeyAuth: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Gateway list.',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.array(merchantGatewayResponseSchema) }) } },
    },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Merchant not found.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(listGatewaysRoute, async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb();

  const merchant = await db.execute({ sql: 'SELECT id FROM merchants WHERE id = ?', args: [id] });
  if (merchant.rows.length === 0) {
    return c.json({ success: false as const, error: { code: 'NOT_FOUND', message: `Merchant not found: ${id}` } }, 404);
  }

  const result = await db.execute({
    sql: 'SELECT id, merchant_id, gateway, environment, enabled, created_at, updated_at FROM merchant_gateways WHERE merchant_id = ?',
    args: [id],
  });

  return c.json({
    success: true as const,
    data: result.rows.map((row) => ({
      id: row.id as string,
      merchant_id: row.merchant_id as string,
      gateway: row.gateway as string,
      environment: row.environment as string,
      enabled: Boolean(row.enabled),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    })),
  }, 200);
});

// ── PUT /api/merchants/:id/gateways/:gateway ────────────────────

const setGatewayRoute = createRoute({
  method: 'put',
  path: '/merchants/{id}/gateways/{gateway}',
  tags: ['Merchants'],
  summary: 'Set gateway credentials',
  description: 'Set or update gateway credentials for a merchant. Credentials are encrypted at rest.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string(), gateway: z.enum(GATEWAY_NAMES) }),
    body: { content: { 'application/json': { schema: setGatewayCredentialsBodySchema } } },
  },
  responses: {
    200: { description: 'Gateway config set.', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: merchantGatewayResponseSchema }) } } },
    400: { description: 'Invalid gateway.', content: { 'application/json': { schema: errorSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Merchant not found.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(setGatewayRoute, async (c) => {
  const { id, gateway } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb();

  const merchant = await db.execute({ sql: 'SELECT id FROM merchants WHERE id = ?', args: [id] });
  if (merchant.rows.length === 0) {
    return c.json({ success: false as const, error: { code: 'NOT_FOUND', message: `Merchant not found: ${id}` } }, 404);
  }

  const encrypted = encrypt(JSON.stringify(body.credentials));
  const gwId = 'mgw_' + id.replace('merch_', '') + '_' + gateway;

  await db.execute({
    sql: `INSERT INTO merchant_gateways (id, merchant_id, gateway, credentials, environment, enabled)
          VALUES (?, ?, ?, ?, ?, 1)
          ON CONFLICT(merchant_id, gateway) DO UPDATE SET credentials = ?, environment = ?, enabled = 1, updated_at = datetime('now')`,
    args: [gwId, id, gateway, encrypted, body.environment, encrypted, body.environment],
  });

  logger.info('Merchant gateway config set', { merchant_id: id, gateway, environment: body.environment });

  return c.json({
    success: true as const,
    data: {
      id: gwId,
      merchant_id: id,
      gateway,
      environment: body.environment,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }, 200);
});

// ── PATCH /api/merchants/:id/gateways/:gateway ──────────────────

const toggleGatewayRoute = createRoute({
  method: 'patch',
  path: '/merchants/{id}/gateways/{gateway}',
  tags: ['Merchants'],
  summary: 'Enable/disable gateway',
  description: 'Toggle a gateway on or off for a merchant.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string(), gateway: z.enum(GATEWAY_NAMES) }),
    body: { content: { 'application/json': { schema: toggleGatewayBodySchema } } },
  },
  responses: {
    200: { description: 'Gateway toggled.', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: merchantGatewayResponseSchema }) } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
    404: { description: 'Gateway config not found.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(toggleGatewayRoute, async (c) => {
  const { id, gateway } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb();

  await db.execute({
    sql: "UPDATE merchant_gateways SET enabled = ?, updated_at = datetime('now') WHERE merchant_id = ? AND gateway = ?",
    args: [body.enabled ? 1 : 0, id, gateway],
  });

  const result = await db.execute({
    sql: 'SELECT id, merchant_id, gateway, environment, enabled, created_at, updated_at FROM merchant_gateways WHERE merchant_id = ? AND gateway = ?',
    args: [id, gateway],
  });

  if (result.rows.length === 0) {
    return c.json({ success: false as const, error: { code: 'NOT_FOUND', message: `Gateway config not found: ${gateway}` } }, 404);
  }

  const row = result.rows[0];
  return c.json({
    success: true as const,
    data: {
      id: row.id as string,
      merchant_id: row.merchant_id as string,
      gateway: row.gateway as string,
      environment: row.environment as string,
      enabled: Boolean(row.enabled),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    },
  }, 200);
});

// ── DELETE /api/merchants/:id/gateways/:gateway ─────────────────

const deleteGatewayRoute = createRoute({
  method: 'delete',
  path: '/merchants/{id}/gateways/{gateway}',
  tags: ['Merchants'],
  summary: 'Remove gateway config',
  description: 'Remove gateway credentials for a merchant. Merchant will fall back to platform credentials.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({ id: z.string(), gateway: z.enum(GATEWAY_NAMES) }),
  },
  responses: {
    200: { description: 'Gateway config removed.', content: { 'application/json': { schema: z.object({ success: z.literal(true), data: z.object({ deleted: z.literal(true) }) }) } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: errorSchema } } },
  },
});

merchantRoutes.openapi(deleteGatewayRoute, async (c) => {
  const { id, gateway } = c.req.valid('param');
  const db = getDb();

  await db.execute({
    sql: 'DELETE FROM merchant_gateways WHERE merchant_id = ? AND gateway = ?',
    args: [id, gateway],
  });

  logger.info('Merchant gateway config removed', { merchant_id: id, gateway });

  return c.json({ success: true as const, data: { deleted: true as const } }, 200);
});
