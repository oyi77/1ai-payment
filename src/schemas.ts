/**
 * Shared Zod schemas for OpenAPI spec generation.
 *
 * These schemas are the single source of truth for:
 * - Runtime request validation (Zod parsing)
 * - OpenAPI spec generation (@hono/zod-openapi)
 * - TypeScript types (z.infer)
 */

import { extendZodWithOpenApi } from "@hono/zod-openapi";
import { ZodError, z } from "zod";

extendZodWithOpenApi(z);

// ── Enums ──────────────────────────────────────────────────────

export const GATEWAY_NAMES = [
	"midtrans",
	"tripay",
	"duitku",
	"nowpayments",
	"ipaymu",
	"scalev",
	"xendit",
	"telegram_stars",
	"telegram_payments",
	"paypal",
	"x402",
	"erc8183",
] as const;

export const gatewayNameSchema = z.enum(GATEWAY_NAMES).openapi({
	description: "Payment gateway identifier",
	example: "midtrans",
});

export const paymentStatusSchema = z
	.enum(["pending", "success", "failed", "expired", "cancelled"])
	.openapi({
		description: "Lifecycle status of a payment order",
		example: "pending",
	});

// ── Schemas ────────────────────────────────────────────────────

export const customerSchema = z
	.object({
		name: z.string().optional().openapi({ example: "Budi Santoso" }),
		email: z
			.string()
			.email()
			.optional()
			.openapi({ example: "budi@example.com" }),
	})
	.optional()
	.openapi("Customer");

export const createPaymentBodySchema = z
	.object({
		gateway: gatewayNameSchema,
		amount: z.number().int().positive().openapi({
			description:
				"Payment amount in smallest currency unit (IDR = full Rupiah)",
			example: 100000,
		}),
		currency: z.string().default("IDR").openapi({ example: "IDR" }),
		payment_method: z.string().optional().openapi({
			description:
				"Gateway-specific payment method code (e.g. qris, bca_va, gopay)",
			example: "qris",
		}),
		callback_url: z.string().url().openapi({
			description:
				"URL to forward the normalized payment event to after gateway callback",
			example: "https://your-app.com/payment/callback",
		}),
		idempotency_key: z.string().optional().openapi({
			description: "Client-generated unique key to prevent duplicate orders",
			example: "order-usr123-1720180000",
		}),
		project_order_id: z.string().optional().openapi({
			description:
				"Your application's own order/invoice ID for cross-reference",
			example: "inv_789",
		}),
		customer: customerSchema,
		metadata: z
			.record(z.string(), z.unknown())
			.optional()
			.openapi({
				description:
					"Arbitrary metadata preserved through the full payment lifecycle",
				example: { user_id: "usr_789", plan: "pro" },
			}),
	})
	.openapi("CreatePaymentBody");

export const orderResponseSchema = z
	.object({
		id: z.string().openapi({ example: "pay_01j2k3l4m5n6" }),
		gateway: z.string().openapi({ example: "midtrans" }),
		gateway_reference: z.string().nullable().openapi({ example: "trx_abc123" }),
		status: z.string().openapi({ example: "pending" }),
		amount: z.number().openapi({ example: 100000 }),
		currency: z.string().openapi({ example: "IDR" }),
		payment_method: z.string().nullable().openapi({ example: "qris" }),
		payment_url: z
			.string()
			.nullable()
			.openapi({ example: "https://sandbox.midtrans.com/pay/abc123" }),
		metadata: z
			.record(z.string(), z.unknown())
			.nullable()
			.openapi({ example: { user_id: "usr_789" } }),
		created_at: z.string().openapi({ example: "2026-07-05T10:00:00.000Z" }),
		updated_at: z.string().openapi({ example: "2026-07-05T10:01:00.000Z" }),
	})
	.openapi("Order");

export const paymentMethodSchema = z
	.object({
		code: z.string().openapi({ example: "qris" }),
		name: z.string().openapi({ example: "QRIS" }),
		currencies: z.array(z.string()).openapi({ example: ["IDR"] }),
	})
	.openapi("PaymentMethod");

export const gatewayInfoSchema = z
	.object({
		gateway: z.string().openapi({ example: "midtrans" }),
		enabled: z.boolean().openapi({ example: true }),
		currencies: z.array(z.string()).openapi({ example: ["IDR"] }),
		methods: z.array(paymentMethodSchema),
	})
	.openapi("GatewayInfo");

export const errorSchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: z.string().openapi({ example: "INVALID_BODY" }),
			message: z.string().openapi({ example: "gateway is required" }),
		}),
	})
	.openapi("Error");

export const webhookErrorSchema = z
	.object({
		error: z.string().openapi({ example: "Invalid signature" }),
	})
	.openapi("WebhookError");

export const healthResponseSchema = z
	.object({
		status: z.enum(["ok", "degraded"]).openapi({ example: "ok" }),
		version: z.string().openapi({ example: "0.1.0" }),
		uptime: z
			.number()
			.openapi({ description: "Process uptime in seconds", example: 3600.42 }),
		database: z.enum(["ok", "error"]).openapi({ example: "ok" }),
		gateways: z
			.record(z.string(), z.enum(["configured", "missing_key"]))
			.openapi({
				example: { midtrans: "configured", tripay: "missing_key" },
			}),
	})
	.openapi("HealthResponse");

export const webhookAckSchema = z
	.object({
		ok: z.literal(true),
	})
	.openapi("WebhookAck");

// ── Merchant schemas ───────────────────────────────────────────

export const createMerchantBodySchema = z
	.object({
		name: z.string().min(1).max(100).openapi({ example: "My Store" }),
		default_callback_url: z
			.string()
			.url()
			.optional()
			.openapi({ example: "https://my-store.com/callback" }),
		plan: z
			.enum(["free", "pro", "enterprise"])
			.default("free")
			.openapi({ example: "free" }),
	})
	.openapi("CreateMerchantBody");

export const updateMerchantBodySchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(100)
			.optional()
			.openapi({ example: "My Store" }),
		default_callback_url: z
			.string()
			.url()
			.optional()
			.openapi({ example: "https://my-store.com/callback" }),
		active: z.boolean().optional().openapi({ example: true }),
		plan: z
			.enum(["free", "pro", "enterprise"])
			.optional()
			.openapi({ example: "pro" }),
	})
	.openapi("UpdateMerchantBody");

export const merchantResponseSchema = z
	.object({
		id: z.string().openapi({ example: "merch_abc123" }),
		name: z.string().openapi({ example: "My Store" }),
		default_callback_url: z
			.string()
			.nullable()
			.openapi({ example: "https://my-store.com/callback" }),
		active: z.boolean().openapi({ example: true }),
		plan: z.string().openapi({ example: "free" }),
		created_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
		updated_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
	})
	.openapi("Merchant");

export const createMerchantResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			merchant: merchantResponseSchema,
			api_key: z.string().openapi({
				description: "API key — shown ONCE, store it securely",
				example: "1pay_abc123...",
			}),
		}),
	})
	.openapi("CreateMerchantResponse");

export const rotateKeyResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			merchant_id: z.string().openapi({ example: "merch_abc123" }),
			api_key: z.string().openapi({
				description: "New API key — shown ONCE, store it securely",
				example: "1pay_xyz789...",
			}),
		}),
	})
	.openapi("RotateKeyResponse");

// ── Phase 2 schemas ────────────────────────────────────────────

export const createRefundBodySchema = z
	.object({
		order_id: z.string().min(1).openapi({ example: "pay_abc123" }),
		amount: z.number().int().positive().optional().openapi({
			description: "Refund amount. Omit for full refund.",
			example: 50000,
		}),
		reason: z
			.string()
			.max(500)
			.optional()
			.openapi({ example: "Customer request" }),
	})
	.openapi("CreateRefundBody");

export const refundResponseSchema = z
	.object({
		id: z.string().openapi({ example: "ref_abc123" }),
		order_id: z.string().openapi({ example: "pay_abc123" }),
		merchant_id: z.string().openapi({ example: "merch_abc123" }),
		amount: z.number().openapi({ example: 50000 }),
		gateway: z.string().openapi({ example: "midtrans" }),
		gateway_refund_id: z.string().nullable().openapi({ example: "refund_xyz" }),
		status: z.string().openapi({ example: "success" }),
		reason: z.string().nullable().openapi({ example: "Customer request" }),
		created_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
		updated_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
	})
	.openapi("Refund");

export const transactionResponseSchema = z
	.object({
		id: z.string().openapi({ example: "pay_abc123" }),
		gateway: z.string().openapi({ example: "midtrans" }),
		gateway_reference: z.string().nullable().openapi({ example: "trx_abc123" }),
		status: z.string().openapi({ example: "success" }),
		amount: z.number().openapi({ example: 100000 }),
		currency: z.string().openapi({ example: "IDR" }),
		payment_method: z.string().nullable().openapi({ example: "qris" }),
		fee: z.number().openapi({ example: 2500 }),
		net: z.number().openapi({ example: 97500 }),
		created_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
	})
	.openapi("Transaction");

export const webhookDeliverySchema = z
	.object({
		id: z.string().openapi({ example: "evt_abc123" }),
		gateway: z.string().openapi({ example: "midtrans" }),
		order_id: z.string().nullable().openapi({ example: "pay_abc123" }),
		status: z.string().nullable().openapi({ example: "success" }),
		signature_valid: z.number().openapi({ example: 1 }),
		created_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
	})
	.openapi("WebhookDelivery");

// ── Phase 3 schemas ────────────────────────────────────────────

export const setGatewayCredentialsBodySchema = z
	.object({
		credentials: z.record(z.string(), z.string()).openapi({
			description:
				"Gateway credentials as key-value pairs (e.g. apiKey, privateKey, merchantCode)",
			example: { apiKey: "your-key", privateKey: "your-secret" },
		}),
		environment: z
			.enum(["sandbox", "production"])
			.default("sandbox")
			.openapi({ example: "sandbox" }),
	})
	.openapi("SetGatewayCredentials");

export const merchantGatewayResponseSchema = z
	.object({
		id: z.string().openapi({ example: "mgw_abc123" }),
		merchant_id: z.string().openapi({ example: "merch_abc123" }),
		gateway: z.string().openapi({ example: "midtrans" }),
		environment: z.string().openapi({ example: "sandbox" }),
		enabled: z.boolean().openapi({ example: true }),
		created_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
		updated_at: z.string().openapi({ example: "2026-07-06T10:00:00.000Z" }),
	})
	.openapi("MerchantGateway");

export const toggleGatewayBodySchema = z
	.object({
		enabled: z.boolean().openapi({ example: false }),
	})
	.openapi("ToggleGateway");

// ── Helpers ────────────────────────────────────────────────────

export function orderToResponse(order: {
	id: string;
	gateway: string;
	gateway_reference: string | null;
	status: string;
	amount: number;
	currency: string;
	payment_method: string | null;
	payment_url: string | null;
	metadata: Record<string, unknown> | null;
	created_at: string;
	updated_at: string;
}) {
	return {
		id: order.id,
		gateway: order.gateway,
		gateway_reference: order.gateway_reference,
		status: order.status,
		amount: order.amount,
		currency: order.currency,
		payment_method: order.payment_method,
		payment_url: order.payment_url,
		metadata: order.metadata,
		created_at: order.created_at,
		updated_at: order.updated_at,
	};
}

// ── Shared validation hook ──────────────────────────────────────

export const defaultHook = (
	result: { success: boolean; error?: unknown; data?: unknown },
	c: { json: (data: unknown, status?: number) => Response },
) => {
	if (!result.success && result.error instanceof ZodError) {
		const first = result.error.issues[0];
		const path = first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
		return c.json(
			{
				success: false as const,
				error: { code: "INVALID_BODY", message: `${first.message}${path}` },
			},
			400,
		);
	}
};
