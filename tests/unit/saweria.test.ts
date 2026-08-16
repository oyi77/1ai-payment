/**
 * Unit tests for the Saweria gateway implementation.
 *
 * Saweria does NOT sign webhooks. Verification is reconciliation-based
 * (the webhook must echo our order id in `message` and the Saweria
 * transaction uuid in `id`). Covers event normalization and the
 * no-signature verification contract.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { SaweriaGateway } from "../../src/gateways/saweria";

beforeAll(() => {
  process.env.API_KEY = "test_api_key";
  process.env.ENCRYPTION_KEY = "test_encryption_key";
  process.env.ADMIN_API_KEY = "test_admin_key";
  process.env.SAWERIA_USERNAME = "testuser";
  process.env.SAWERIA_USER_ID = "test-user-id";
  process.env.SAWERIA_ENVIRONMENT = "sandbox";
});

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0.0",
    created_at: "2026-08-16T12:00:00Z",
    id: "txn-uuid-123",
    type: "donation",
    amount_raw: 11000,
    cut: -1000,
    donator_name: "Budi",
    donator_email: "budi@example.com",
    donator_is_user: false,
    message: "order_abc",
    etc: {
      qr_string: "qr-data",
      amount_to_display: 10000,
      transaction_fee_policy: "TIPPER",
    },
    ...overrides,
  };
}

const gateway = new SaweriaGateway();

describe("SaweriaGateway.normalizeEvent", () => {
  test("maps donation webhook to success", () => {
    const ev = gateway.normalizeEvent(makeWebhook());
    expect(ev.status).toBe("success");
  });

  test("extracts order_id from message", () => {
    const ev = gateway.normalizeEvent(makeWebhook({ message: "order_xyz" }));
    expect(ev.order_id).toBe("order_xyz");
  });

  test("extracts gateway_reference from id", () => {
    const ev = gateway.normalizeEvent(makeWebhook({ id: "txn-9" }));
    expect(ev.gateway_reference).toBe("txn-9");
  });

  test("extracts amount as number (amount_raw)", () => {
    const ev = gateway.normalizeEvent(makeWebhook({ amount_raw: 25000 }));
    expect(ev.amount).toBe(25000);
  });

  test("currency is IDR", () => {
    const ev = gateway.normalizeEvent(makeWebhook());
    expect(ev.currency).toBe("IDR");
  });

  test("payment_method is qris when qr_string present", () => {
    const ev = gateway.normalizeEvent(makeWebhook({ etc: { qr_string: "qr" } }));
    expect(ev.payment_method).toBe("qris");
  });

  test("payment_method is unknown when qr_string absent", () => {
    const ev = gateway.normalizeEvent(
      makeWebhook({ etc: { amount_to_display: 1, transaction_fee_policy: "TIPPER" } })
    );
    expect(ev.payment_method).toBe("unknown");
  });

  test("paid_at is the webhook created_at", () => {
    const ev = gateway.normalizeEvent(makeWebhook({ created_at: "2026-01-01T00:00:00Z" }));
    expect(ev.paid_at).toBe("2026-01-01T00:00:00Z");
  });

  test("preserves donor metadata", () => {
    const ev = gateway.normalizeEvent(makeWebhook());
    expect(ev.metadata?.donator_name).toBe("Budi");
    expect(ev.metadata?.donator_email).toBe("budi@example.com");
    expect(ev.metadata?.donator_is_user).toBe(false);
    expect(ev.metadata?.cut).toBe(-1000);
    expect(ev.metadata?.transaction_fee_policy).toBe("TIPPER");
  });

  test("throws when id missing", () => {
    expect(() => gateway.normalizeEvent(makeWebhook({ id: undefined }))).toThrow();
  });

  test("throws when message missing", () => {
    expect(() => gateway.normalizeEvent(makeWebhook({ message: undefined }))).toThrow();
  });

  test("coerces missing amount_raw to 0", () => {
    const ev = gateway.normalizeEvent(makeWebhook({ amount_raw: undefined }));
    expect(ev.amount).toBe(0);
  });

  test("coerces missing created_at to null", () => {
    const ev = gateway.normalizeEvent(makeWebhook({ created_at: undefined }));
    expect(ev.paid_at).toBeNull();
  });
});

describe("SaweriaGateway.verifySignature (reconciliation)", () => {
  test("accepts a valid donation webhook", () => {
    expect(gateway.verifySignature(makeWebhook())).toBe(true);
  });

  test("rejects when id missing", () => {
    expect(gateway.verifySignature(makeWebhook({ id: undefined }))).toBe(false);
  });

  test("rejects when message missing", () => {
    expect(gateway.verifySignature(makeWebhook({ message: undefined }))).toBe(false);
  });

  test("rejects non-donation type", () => {
    expect(gateway.verifySignature(makeWebhook({ type: "refund" }))).toBe(false);
  });

  test("rejects non-object body", () => {
    expect(gateway.verifySignature(null)).toBe(false);
    expect(gateway.verifySignature("string")).toBe(false);
  });
});

describe("SaweriaGateway.createPayment guards", () => {
  test("rejects non-IDR currency before calling the API", () => {
    expect(() =>
      gateway.createPayment({
        orderId: "order_1",
        amount: 100,
        currency: "USD",
        paymentMethod: "qris",
        customerName: "Anon",
        customerEmail: "anonymous@1ai.dev",
        metadata: {},
      })
    ).toThrow();
  });
});

describe("SaweriaGateway.getPaymentMethods", () => {
  test("exposes qris/gopay/dana for IDR", () => {
    const methods = gateway.getPaymentMethods();
    expect(methods.map((m) => m.code).sort()).toEqual(["dana", "gopay", "qris"]);
    expect(methods.every((m) => m.currencies.includes("IDR"))).toBe(true);
  });

  test("refundPayment is unsupported", () => {
    expect(() => gateway.refundPayment("ref", 1)).toThrow();
  });
});
