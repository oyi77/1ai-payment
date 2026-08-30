import { getDb } from "../config/database.js";
import { getGateway } from "../gateways/index.js";
import { GatewayError } from "../utils/errors";
import { getOrderById } from "./order.service.js";

export interface Refund {
	id: string;
	order_id: string;
	merchant_id: string;
	amount: number;
	gateway: string;
	status: "pending" | "completed" | "failed";
	reason: string | null;
	gateway_refund_id: string | null;
	idempotency_key: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateRefundParams {
	order_id: string;
	merchant_id: string;
	amount?: number;
	reason?: string;
	idempotency_key?: string;
}

export async function getRefundById(id: string): Promise<Refund | null> {
	const db = getDb();
	const result = await db.execute({
		sql: "SELECT * FROM refunds WHERE id = ?",
		args: [id],
	});
	return result.rows.length > 0
		? mapRefundRow(result.rows[0] as Record<string, unknown>)
		: null;
}

export async function getRefundsByOrder(
	orderId: string,
	merchantId: string,
): Promise<Refund[]> {
	const db = getDb();
	const result = await db.execute({
		sql: "SELECT * FROM refunds WHERE order_id = ? AND merchant_id = ?",
		args: [orderId, merchantId],
	});
	return result.rows.map((row) => mapRefundRow(row as Record<string, unknown>));
}

export async function listRefunds(
	merchantId: string,
	limit = 50,
	offset = 0,
): Promise<{ refunds: Refund[]; total: number }> {
	const db = getDb();
	const countResult = await db.execute({
		sql: "SELECT COUNT(*) AS total FROM refunds WHERE merchant_id = ?",
		args: [merchantId],
	});
	const total = Number(
		(countResult.rows[0] as Record<string, unknown>).total ?? 0,
	);
	const result = await db.execute({
		sql: "SELECT * FROM refunds WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
		args: [merchantId, limit, offset],
	});
	return {
		refunds: result.rows.map((row) =>
			mapRefundRow(row as Record<string, unknown>),
		),
		total,
	};
}

export async function createRefund(
	params: CreateRefundParams,
): Promise<Refund> {
	const db = getDb();
	// Fetch the order to validate ownership and status
	const order = await getOrderById(params.order_id);
	if (!order) {
		throw new GatewayError("", `Order not found: ${params.order_id}`);
	}

	// Verify merchant owns the order
	if (
		order.merchant_id !== params.merchant_id &&
		order.project_id !== params.merchant_id
	) {
		throw new GatewayError(
			"",
			`Order ${params.order_id} does not belong to merchant ${params.merchant_id}`,
		);
	}

	// Verify order is in a refundable state
	if (order.status !== "success") {
		throw new GatewayError(
			"",
			`Cannot refund order with status: ${order.status}`,
		);
	}

	// Idempotency: a retry carrying the same key returns the existing refund
	// instead of inserting a duplicate pending row (and avoids the cumulative
	// refund guard throwing "exceeds order amount" on in-flight retries).
	if (params.idempotency_key) {
		const existing = await getRefundByIdempotencyKey(
			params.idempotency_key,
			params.merchant_id,
		);
		if (existing) {
			return existing;
		}
	}

	// Calculate refund amount (default to full order amount)
	const refundAmount = params.amount ?? order.amount;
	if (refundAmount > order.amount) {
		throw new GatewayError(
			"",
			`Refund amount ${refundAmount} exceeds order amount ${order.amount}`,
		);
	}

	// Cumulative refund guard: prevent refunding more than the order total
	const existingRefunds = await getRefundsByOrder(
		params.order_id,
		params.merchant_id,
	);
	const existingTotal = existingRefunds
		.filter((r) => r.status !== "failed")
		.reduce((sum, r) => sum + r.amount, 0);
	if (existingTotal + refundAmount > order.amount) {
		throw new GatewayError(
			"",
			`Total refunds ${existingTotal + refundAmount} would exceed order amount ${order.amount}`,
		);
	}

	const id = `rf_${crypto.randomUUID()}`;
	await db.execute({
		sql: `INSERT INTO refunds (id, order_id, merchant_id, amount, gateway, status, reason, idempotency_key)
		      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
		args: [
			id,
			params.order_id,
			params.merchant_id,
			refundAmount,
			order.gateway,
			params.reason ?? null,
			params.idempotency_key ?? null,
		],
	});

	// Attempt gateway-level refund if the gateway supports it
	const gateway = getGateway(order.gateway);
	let gatewayRefundId: string | null = null;
	let gatewayErr: unknown = null;
	if (gateway?.refundPayment && order.gateway_reference) {
		try {
			const gatewayRef = await gateway.refundPayment(
				order.gateway_reference,
				refundAmount,
			);
			gatewayRefundId = gatewayRef.gatewayRefundId;
		} catch (err) {
			gatewayErr = err;
		}
	}

	let refundStatus: "pending" | "success" | "failed" = "pending";
	if (gatewayRefundId !== null) {
		// Gateway confirmed the refund.
		refundStatus = "success";
	} else if (gatewayErr) {
		// REFUND_NOT_SUPPORTED means the gateway will refund out-of-band:
		// leave the refund pending so a later webhook/retry can complete it.
		if (
			gatewayErr instanceof GatewayError &&
			gatewayErr.details === "REFUND_NOT_SUPPORTED"
		) {
			refundStatus = "pending";
		} else {
			refundStatus = "failed";
		}
	}

	await db.execute({
		sql: "UPDATE refunds SET status = ?, gateway_refund_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		args: [refundStatus, gatewayRefundId, id],
	});

	// Flip the order to refunded only when the full amount has been refunded.
	if (refundStatus === "success" && refundAmount >= order.amount) {
		await db.execute({
			sql: "UPDATE orders SET status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			args: [params.order_id],
		});
	}

	return getRefundById(id) as Promise<Refund>;
}

export async function getRefundByIdempotencyKey(
	key: string,
	merchantId?: string,
): Promise<Refund | null> {
	const db = getDb();
	let sql = "SELECT * FROM refunds WHERE idempotency_key = ?";
	const args: Array<string | null> = [key];
	if (merchantId) {
		sql += " AND merchant_id = ?";
		args.push(merchantId);
	}
	const result = await db.execute({ sql, args });
	return result.rows.length > 0
		? mapRefundRow(result.rows[0] as Record<string, unknown>)
		: null;
}

function mapRefundRow(row: Record<string, unknown>): Refund {
	return {
		id: row.id as string,
		order_id: row.order_id as string,
		merchant_id: row.merchant_id as string,
		amount: Number(row.amount),
		gateway: row.gateway as string,
		status: row.status as "pending" | "completed" | "failed",
		reason: (row.reason as string | null) ?? null,
		gateway_refund_id: (row.gateway_refund_id as string | null) ?? null,
		idempotency_key: (row.idempotency_key as string | null) ?? null,
		created_at: row.created_at as string,
		updated_at: row.updated_at as string,
	};
}
