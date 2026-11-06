import "server-only";
import Stripe from "stripe";
import type { CheckoutRequest, CheckoutStatus, NormalisedEvent, PaymentProvider } from "./types";

export function normaliseStripeEvent(event: Stripe.Event): NormalisedEvent {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const isSession = event.type.startsWith("checkout.session.");
  const metadata = (obj.metadata ?? {}) as Record<string, string>;
  const pi = obj.payment_intent;
  return {
    id: event.id,
    type: event.type,
    sessionId: isSession ? (obj.id as string) : null,
    paymentIntentId: isSession ? (typeof pi === "string" ? pi : ((pi as { id?: string } | null)?.id ?? null)) : event.type.startsWith("payment_intent.") ? (obj.id as string) : null,
    paymentId: metadata.payment_id ?? null,
    amountTotal: typeof obj.amount_total === "number" ? obj.amount_total : typeof obj.amount === "number" ? obj.amount : null,
    paymentStatus: (obj.payment_status as string | undefined) ?? (obj.status as string | undefined) ?? null,
  };
}

/**
 * Stripe (Connect platform account). Deposits are charged to the platform and
 * tagged with a transfer_group per job so they can later be transferred to the
 * builder's connected account in stages. Status: implemented, verified only
 * against Stripe's SDK signature functions locally; needs test-mode keys.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  private readonly stripe: Stripe;

  constructor(secretKey: string, private readonly webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { timeout: 10_000, maxNetworkRetries: 0, appInfo: { name: "beat-my-quote" } });
  }

  async createCheckout(req: CheckoutRequest) {
    // The idempotency key makes a repeat (after a timeout) return the SAME session, never a second one.
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        currency: "gbp",
        line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: req.amountPence, product_data: { name: req.description } } }],
        success_url: `${req.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: req.cancelUrl,
        metadata: { payment_id: req.paymentId, job_id: req.jobId },
        payment_intent_data: { transfer_group: `job_${req.jobId}`, metadata: { payment_id: req.paymentId, job_id: req.jobId } },
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      },
      { idempotencyKey: req.idempotencyKey },
    );
    if (!session.url) throw new Error("Stripe returned no checkout URL");
    return { sessionId: session.id, url: session.url };
  }

  async retrieveCheckout(sessionId: string): Promise<CheckoutStatus> {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      sessionId: s.id,
      status: (s.status ?? "open") as CheckoutStatus["status"],
      paymentStatus: s.payment_status as CheckoutStatus["paymentStatus"],
      paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null),
      amountTotal: s.amount_total,
    };
  }

  async refund(paymentIntentId: string, amountPence: number, idempotencyKey: string) {
    const r = await this.stripe.refunds.create({ payment_intent: paymentIntentId, amount: amountPence }, { idempotencyKey });
    return { refundId: r.id, status: r.status ?? "pending" };
  }

  verifyWebhook(rawBody: string, signature: string | null): NormalisedEvent {
    if (!signature) throw new Error("missing signature");
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret, 300);
    return normaliseStripeEvent(event);
  }
}
