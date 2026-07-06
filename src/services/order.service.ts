/**
 * Order service — CRUD operations for order registry.
 *
 * Orders are created via payment creation API and tracked through their lifecycle.
 * Projects can also register orders before creating payments (legacy support).
 */

import { getDb } from '../config/database';
import { generateOrderId } from '../utils/crypto';
import { DuplicateOrderError, OrderNotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface Order {
  id: string;
  project_id: string;
  merchant_id: string;
  project_order_id: string | null;
  callback_url: string;
  gateway: string;
  gateway_reference: string | null;
  amount: number;
  currency: string;
  payment_method: string | null;
  payment_url: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  idempotency_key: string | null;
  fee: number;
  net: number;
  created_at: string;
  updated_at: string;
  forwarded_at: string | null;
  forward_attempts: number;
}

export interface CreateOrderParams {
  project_id: string;
  merchant_id?: string;
  project_order_id?: string;
  callback_url: string;
  gateway: string;
  amount: number;
  currency?: string;
  payment_method?: string;
  payment_url?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}

export async function createOrder(params: CreateOrderParams): Promise<Order> {
  const db = getDb();
  const id = generateOrderId();

  try {
    await db.execute({
      sql: `INSERT INTO orders (id, project_id, merchant_id, project_order_id, callback_url, gateway, amount, currency, payment_method, payment_url, metadata, idempotency_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        params.project_id,
        params.merchant_id ?? params.project_id,
        params.project_order_id ?? null,
        params.callback_url,
        params.gateway,
        params.amount,
        params.currency ?? 'IDR',
        params.payment_method ?? null,
        params.payment_url ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.idempotency_key ?? null,
      ],
    });

    logger.info('Order created', { id, gateway: params.gateway, amount: params.amount });

    const row = await getOrderById(id);
    return row!;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      throw new DuplicateOrderError(params.idempotency_key || id);
    }
    throw err;
  }
}

export async function getOrderById(id: string): Promise<Order | null> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM orders WHERE id = ?',
    args: [id],
  });
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function getOrderByGatewayRef(gatewayReference: string): Promise<Order | null> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM orders WHERE gateway_reference = ?',
    args: [gatewayReference],
  });
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function getOrderByProjectOrder(projectId: string, projectOrderId: string): Promise<Order | null> {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM orders WHERE project_id = ? AND project_order_id = ?',
    args: [projectId, projectOrderId],
  });
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function getOrderByIdempotencyKey(key: string, merchantId?: string): Promise<Order | null> {
  const db = getDb();
  let sql = 'SELECT * FROM orders WHERE idempotency_key = ?';
  const args: Array<string | null> = [key];
  if (merchantId) {
    sql += ' AND merchant_id = ?';
    args.push(merchantId);
  }
  const result = await db.execute({ sql, args });
  return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function updateOrderStatus(
  id: string,
  status: string,
  gatewayReference?: string,
  paymentUrl?: string,
  paymentMethod?: string,
): Promise<void> {
  const db = getDb();
  const updates: string[] = ["status = ?", "updated_at = datetime('now')"];
  const args: Array<string | number | null> = [status];

  if (gatewayReference) {
    updates.push('gateway_reference = ?');
    args.push(gatewayReference);
  }
  if (paymentUrl) {
    updates.push('payment_url = ?');
    args.push(paymentUrl);
  }
  if (paymentMethod) {
    updates.push('payment_method = ?');
    args.push(paymentMethod);
  }

  args.push(id);
  await db.execute({
    sql: `UPDATE orders SET ${updates.join(', ')} WHERE id = ?`,
    args,
  });
}

export async function markForwarded(id: string, statusCode?: number, attempts?: number): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE orders SET forwarded_at = datetime('now'), forward_attempts = ?, status = 'forwarded' WHERE id = ?`,
    args: [attempts ?? 1, id],
  });
}

export async function listOrders(params: {
  project_id?: string;
  merchant_id?: string;
  gateway?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<{ orders: Order[]; total: number }> {
  const db = getDb();
  const conditions: string[] = [];
  const args: Array<string | number | null> = [];

  if (params.merchant_id) {
    conditions.push('merchant_id = ?');
    args.push(params.merchant_id);
  } else if (params.project_id) {
    conditions.push('project_id = ?');
    args.push(params.project_id);
  }
  if (params.gateway) {
    conditions.push('gateway = ?');
    args.push(params.gateway);
  }
  if (params.status) {
    conditions.push('status = ?');
    args.push(params.status);
  }
  if (params.from) {
    conditions.push('created_at >= ?');
    args.push(params.from);
  }
  if (params.to) {
    conditions.push('created_at <= ?');
    args.push(params.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(params.limit ?? 50, 100);
  const offset = params.offset ?? 0;

  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as count FROM orders ${where}`,
    args,
  });
  const total = Number((countResult.rows[0] as Record<string, unknown>).count);

  const result = await db.execute({
    sql: `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });

  return {
    orders: result.rows.map((row) => mapRow(row as Record<string, unknown>)),
    total,
  };
}

function mapRow(row: Record<string, unknown>): Order {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata && typeof row.metadata === 'string') {
    try {
      metadata = JSON.parse(row.metadata as string);
    } catch {
      metadata = { raw: row.metadata };
    }
  }

  return {
    id: row.id as string,
    project_id: row.project_id as string,
    merchant_id: (row.merchant_id as string) ?? row.project_id as string,
    project_order_id: (row.project_order_id as string) ?? null,
    callback_url: row.callback_url as string,
    gateway: row.gateway as string,
    gateway_reference: (row.gateway_reference as string) ?? null,
    amount: row.amount as number,
    currency: (row.currency as string) ?? 'IDR',
    payment_method: (row.payment_method as string) ?? null,
    payment_url: (row.payment_url as string) ?? null,
    status: (row.status as string) ?? 'pending',
    metadata,
    idempotency_key: (row.idempotency_key as string) ?? null,
    fee: Number(row.fee ?? 0),
    net: Number(row.net ?? 0),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    forwarded_at: (row.forwarded_at as string) ?? null,
    forward_attempts: (row.forward_attempts as number) ?? 0,
  };
}
