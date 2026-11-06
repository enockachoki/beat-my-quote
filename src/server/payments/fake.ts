import "server-only";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { normaliseStripeEvent } from "./stripe";
import type { CheckoutRequest, CheckoutStatus, NormalisedEvent, PaymentProvider } from "./types";

interface FakeSession { id: string; req: CheckoutRequest; status: CheckoutStatus["status"]; paid: boolean; intentId: string }

const g = globalThis as unknown as { __fakeSessions?: Map<string, FakeSession> };
const sessions = (g.__fakeSessions ??= new Map());

/**
 * DEVELOPMENT/TEST ONLY payment provider. It mimics Stripe Checkout and signs
 * its webhooks in Stripe's exact format, so the real webhook verification and
 * ledger code paths are exercised. It can never move money.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake" as const;
  private readonly verifier = new Stripe("sk_test_fake_not_used", { telemetry: false });
  constructor(private readonly webhookSecret: string, private readonly origin: string) {}

  async createCheckout(req: CheckoutRequest) {
    const id = `cs_fake_${createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 24)}`;
    if (!sessions.has(id)) sessions.set(id, { id, req, status: "open", paid: false, intentId: `pi_fake_${id.slice(8)}` });
    return { sessionId: id, url: `${this.origin}/dev/fake-checkout/${id}` };
  }

  async retrieveCheckout(sessionId: string): Promise<CheckoutStatus> {
    const s = sessions.get(sessionId);
    if (!s) throw Object.assign(new Error("No such checkout session"), { code: "resource_missing" });
    return { sessionId, status: s.status, paymentStatus: s.paid ? "paid" : "unpaid", paymentIntentId: s.paid ? s.intentId : null, amountTotal: s.req.amountPence };
  }

  async refund(paymentIntentId: string) {
    return { refundId: `re_fake_${paymentIntentId.slice(8)}`, status: "succeeded" };
  }

  /** Marks the session paid and returns a Stripe-signed webhook payload to deliver. */
  completeSession(sessionId: string): { body: string; signature: string; successUrl: string } | null {
    const s = sessions.get(sessionId);
    if (!s || s.status !== "open") return null;
    s.status = "complete";
    s.paid = true;
    const body = JSON.stringify({
      id: `evt_fake_${sessionId.slice(8)}`,
      object: "event",
      type: "checkout.session.completed",
      api_version: "2025-01-01",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: s.id, object: "checkout.session", payment_status: "paid", status: "complete", amount_total: s.req.amountPence, payment_intent: s.intentId, metadata: { payment_id: s.req.paymentId, job_id: s.req.jobId } } },
    });
    const signature = this.verifier.webhooks.generateTestHeaderString({ payload: body, secret: this.webhookSecret });
    return { body, signature, successUrl: `${s.req.successUrl}?session_id=${s.id}` };
  }

  verifyWebhook(rawBody: string, signature: string | null): NormalisedEvent {
    if (!signature) throw new Error("missing signature");
    return normaliseStripeEvent(this.verifier.webhooks.constructEvent(rawBody, signature, this.webhookSecret, 300));
  }
}
