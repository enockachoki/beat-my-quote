export interface CheckoutRequest {
  paymentId: string;
  jobId: string;
  amountPence: number;
  description: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface CheckoutSession { sessionId: string; url: string }

export interface CheckoutStatus {
  sessionId: string;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  paymentIntentId: string | null;
  amountTotal: number | null;
}

export interface NormalisedEvent {
  id: string;
  type: string;
  sessionId: string | null;
  paymentIntentId: string | null;
  paymentId: string | null; // our ledger id, from metadata
  amountTotal: number | null;
  paymentStatus: string | null;
}

export interface PaymentProvider {
  readonly name: "stripe" | "fake";
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  retrieveCheckout(sessionId: string): Promise<CheckoutStatus>;
  refund(paymentIntentId: string, amountPence: number, idempotencyKey: string): Promise<{ refundId: string; status: string }>;
  /** Verifies the provider signature and returns a normalised event, or throws. */
  verifyWebhook(rawBody: string, signature: string | null): NormalisedEvent;
}
