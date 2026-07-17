/**
 * Refund service — CRUD for refunds.
 */

import { getDb } from "../config/database";
import { getGateway } from "../gateways";
import { generateOrderId } from "../utils/crypto";
import { GatewayError } from "../utils/errors";
import { logger } from "../utils/logger";
import { getOrderById } from "./order.service";

export interface Refund {
	id: string;
	order_id: string;
	merchant_id: string;
	amount: number;
	gateway: string;
	gateway_refund_id: string | null;
	status: string;
	reason: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateRefundParams {
	order_id: string;
	merchant_id: string;
	amount?: number;
	reason?: string;
}

export async function createRefund(
	params: CreateRefundParams,
): Promise<Refund> {
	const db = getDb();

	// Look up the order
	const order = await getOrderById(params.order_id);
	if (!order) {
		throw new GatewayError("", `Order not found: ${params.order_id}`);
	}

	// Verify merchant owns the order
	if (
		order.merchant_id !== params.merchant_id &&
		order.project_id !== params.merchant_id
	) {
		throw new GatewayError("", "Order does not belong to this merchant");
	}

	// Verify order is in a refundable state
	if (order.status !== "success") {
		throw new GatewayError(
			"",
			`Cannot refund order with status: ${order.status}`,
		);
	}

	// Calculate refund amount (default to full order amount)
	const refundAmount = params.amount ?? order.amount;
	if (refundAmount > order.amount) {
		throw new GatewayError(
			"",
			`Refund amount (${refundAmount}) exceeds order amount (${order.amount})`,
		);
	}

	const id = generateOrderId().replace("pay_", "ref_");
	const gateway = getGateway(order.gateway);

	let gatewayRefundId: string | null = null;
	let status = "pending";

	// Attempt gateway refund if supported
	if (gateway?.refundPayment && order.gateway_reference) {
		try {
			const result = await gateway.refundPayment(
				order.gateway_reference,
				refundAmount,
			);
			gatewayRefundId = result.gatewayRefundId;
			status = result.status;
		} catch (err: unknown) {
			if (
				err instanceof GatewayError &&
				err.message.includes("REFUND_NOT_SUPPORTED")
			) {
				status = "pending"; // Mark as pending for manual processing
			} else {
				throw err;
			}
		}
	} else {
		status = "pending"; // No gateway refund support — manual processing needed
	}

	// Insert refund record
	await db.execute({
		sql: `INSERT INTO refunds (id, order_id, merchant_id, amount, gateway, gateway_refund_id, status, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			id,
			params.order_id,
			params.merchant_id,
			refundAmount,
			order.gateway,
			gatewayRefundId,
			status,
			params.reason ?? null,
		],
	});

	// Update order status to refunded if full refund
	if (refundAmount >= order.amount) {
		await db.execute({
			sql: "UPDATE orders SET status = 'refunded', updated_at = datetime('now') WHERE id = ?",
			args: [params.order_id],
		});
	}

	logger.info("Refund created", {
		id,
		order_id: params.order_id,
		amount: refundAmount,
		status,
	});

	const result = await db.execute({
		sql: "SELECT * FROM refunds WHERE id = ?",
		args: [id],
	});

	return mapRefundRow(result.rows[0] as Record<string, unknown>);
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

export async function listRefunds(
	merchantId: string,
	limit = 20,
	offset = 0,
): Promise<{ refunds: Refund[]; total: number }> {
	const db = getDb();

	const countResult = await db.execute({
		sql: "SELECT COUNT(*) as count FROM refunds WHERE merchant_id = ?",
		args: [merchantId],
	});
	const total = Number((countResult.rows[0] as Record<string, unknown>).count);

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

function mapRefundRow(row: Record<string, unknown>): Refund {
	return {
		id: row.id as string,
		order_id: row.order_id as string,
		merchant_id: row.merchant_id as string,
		amount: Number(row.amount),
		gateway: row.gateway as string,
		gateway_refund_id: row.gateway_refund_id as string | null,
		status: row.status as string,
		reason: row.reason as string | null,
		created_at: row.created_at as string,
		updated_at: row.updated_at as string,
	};
}
