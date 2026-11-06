import "server-only";
import { config } from "../config";
import { withServiceTx, type Tx } from "../db/client";
import * as jobsRepo from "../db/repositories/jobs";
import * as offersRepo from "../db/repositories/offers";
import * as paymentsRepo from "../db/repositories/payments";
import { AppError } from "../errors";
import { assertOwnsJob, requireRole, type SessionUser } from "../authz/policies";
import { payments } from "../payments";
import type { CheckoutStatus, NormalisedEvent } from "../payments/types";
import type { PaymentRow } from "../db/types";
import { withTimeout } from "../domain/resilience";
import { log } from "../observability/logger";
import { reportError } from "../observability/errorReporter";
import { audit, SYSTEM_ACTOR } from "./audit";
import { enqueue } from "./notificationService";

/**
 * Deposits are server-controlled end to end:
 * 1. A ledger row is written BEFORE calling the provider, with a stable
 *    idempotency key.
 * 2. The provider call uses that same key, so a timeout followed by a retry
 *    returns the same checkout session and can never create a second charge.
 * 3. A job is marked paid ONLY by a signature-verified webhook or by us asking
 *    the provider directly. The browser's redirect is never trusted.
 */
export async function startDeposit(user: SessionUser, jobId: string): Promise<{ url: string; paymentId: string }> {
  requireRole(user, "homeowner");
  const cfg = config();
  const prepared = await withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    if (job.status !== "awaiting_deposit") throw new AppError("INVALID_TRANSITION");
    const contract = await offersRepo.contractForJob(tx, jobId, { forUpdate: true });
    if (!contract || contract.status !== "active") throw new AppError("INVALID_TRANSITION");
    let payment = await paymentsRepo.liveDeposit(tx, contract.id, { forUpdate: true });
    if (payment?.status === "succeeded") throw new AppError("INVALID_TRANSITION", { internal: "already paid" });
    if (!payment) {
      const attempt = await tx<{ n: number }[]>`select count(*)::int as n from public.payments where contract_id = ${contract.id} and kind = 'deposit'`;
      const key = `deposit_${contract.id}_${attempt[0]!.n + 1}`;
      payment = (await paymentsRepo.insertPayment(tx, { jobId, contractId: contract.id, kind: "deposit", amountPence: contract.depositPence, idempotencyKey: key })).row;
      await audit(tx, user, "payment.created", "payment", payment.id, { kind: "deposit", amountPence: payment.amountPence });
    }
    return { job, payment };
  });

  const { job, payment } = prepared;
  // If a session already exists, check its real state before doing anything else.
  if (payment.providerSessionId) {
    const status = await verifySession(payment.providerSessionId);
    if (status) {
      const applied = await applyCheckoutStatus(payment.id, status);
      if (applied === "succeeded") throw new AppError("INVALID_TRANSITION", { internal: "already paid" });
      if (status.status === "open") {
        const again = await payments().createCheckout(checkoutRequest(payment, job.id, job.title, cfg.APP_ORIGIN));
        return { url: again.url, paymentId: payment.id };
      }
      // expired/cancelled: a fresh ledger row (and key) is needed
      return startDeposit(user, jobId);
    }
  }
  try {
    const session = await withTimeout("payments.createCheckout", 12_000, () => payments().createCheckout(checkoutRequest(payment, job.id, job.title, cfg.APP_ORIGIN)));
    await withServiceTx((tx) => paymentsRepo.update(tx, payment.id, { status: "pending", provider_session_id: session.sessionId }));
    log.info("payment.checkout_created", { paymentId: payment.id });
    return { url: session.url, paymentId: payment.id };
  } catch (err) {
    // Ambiguous: the provider may or may not have created a session. Record
    // "unknown"; the next attempt re-uses the SAME idempotency key, which is safe.
    await withServiceTx((tx) => paymentsRepo.update(tx, payment.id, { status: "unknown", failure_code: "checkout_create_ambiguous" })).catch(() => {});
    log.error("payment.checkout_failed", { paymentId: payment.id, err });
    reportError(err, { paymentId: payment.id });
    throw new AppError("PAYMENT_UNAVAILABLE", { cause: err });
  }
}

function checkoutRequest(payment: PaymentRow, jobId: string, title: string, origin: string) {
  return {
    paymentId: payment.id, jobId, amountPence: payment.amountPence,
    description: `Deposit: ${title}`.slice(0, 120),
    successUrl: `${origin}/homeowner/jobs/${jobId}/payment/${payment.id}`,
    cancelUrl: `${origin}/homeowner/jobs/${jobId}`,
    idempotencyKey: payment.idempotencyKey,
  };
}

async function verifySession(sessionId: string): Promise<CheckoutStatus | null> {
  try {
    return await withTimeout("payments.retrieve", 10_000, () => payments().retrieveCheckout(sessionId));
  } catch (err) {
    log.warn("payment.verify_failed", { err });
    return null;
  }
}

/** Applies a provider-confirmed status to the ledger and job. Idempotent. */
export async function applyCheckoutStatus(paymentId: string, s: CheckoutStatus | { status: "complete"; paymentStatus: "paid"; paymentIntentId: string | null; amountTotal: number | null; sessionId: string }): Promise<"succeeded" | "pending" | "cancelled" | "mismatch" | "noop"> {
  return withServiceTx(async (tx) => {
    const p0 = await paymentsRepo.getById(tx, paymentId);
    if (!p0) return "noop";
    const job = await jobsRepo.getJob(tx, p0.jobId, { forUpdate: true });
    const p = await paymentsRepo.getById(tx, paymentId, { forUpdate: true });
    if (!p || !job) return "noop";
    if (p.status === "succeeded" || p.status === "refunded") return "noop";
    if (s.status === "complete" && s.paymentStatus === "paid") {
      if (s.amountTotal !== null && s.amountTotal !== p.amountPence) {
        log.error("payment.amount_mismatch", { paymentId, expected: p.amountPence, got: s.amountTotal });
        await paymentsRepo.update(tx, p.id, { status: "unknown", failure_code: "amount_mismatch" });
        return "mismatch";
      }
      await paymentsRepo.update(tx, p.id, { status: "succeeded", provider_payment_intent_id: s.paymentIntentId, provider_session_id: s.sessionId, failure_code: null });
      await audit(tx, SYSTEM_ACTOR, "payment.succeeded", "payment", p.id, { amountPence: p.amountPence, kind: p.kind });
      if (p.kind === "deposit" && job.status === "awaiting_deposit") {
        await jobsRepo.transition(tx, job.id, "awaiting_deposit", "deposit_paid");
        const contract = await offersRepo.contractForJob(tx, job.id);
        await enqueue(tx, job.homeownerId, "deposit_paid", { title: job.title, path: `/homeowner/jobs/${job.id}` }, `deposit_paid:${p.id}:h`);
        if (contract) await enqueue(tx, contract.builderId, "deposit_paid", { title: job.title, path: `/builder/jobs/${job.id}` }, `deposit_paid:${p.id}:b`);
      } else if (p.kind === "deposit" && job.status !== "deposit_paid") {
        // Paid after the job was cancelled: refund automatically.
        log.warn("payment.paid_after_cancel", { paymentId: p.id, jobStatus: job.status });
        await queueRefund(tx, p);
      }
      return "succeeded";
    }
    if (s.status === "expired") {
      await paymentsRepo.update(tx, p.id, { status: "cancelled", failure_code: "session_expired" });
      return "cancelled";
    }
    return "pending";
  });
}

export async function handleWebhook(rawBody: string, signature: string | null): Promise<"processed" | "duplicate" | "ignored"> {
  let event: NormalisedEvent;
  try {
    event = payments().verifyWebhook(rawBody, signature);
  } catch (err) {
    log.warn("payment.webhook_bad_signature", { err: (err as Error).message });
    throw new AppError("FORBIDDEN", { internal: "webhook signature" });
  }
  const first = await withServiceTx((tx) => paymentsRepo.recordEvent(tx, event.id, event.type));
  if (!first) {
    log.info("payment.webhook_duplicate", { eventId: event.id, type: event.type });
    return "duplicate";
  }
  log.info("payment.webhook", { eventId: event.id, type: event.type });
  let outcome = "ignored";
  try {
    if ((event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") && event.sessionId) {
      const paymentId = event.paymentId ?? (await withServiceTx((tx) => paymentsRepo.getByProviderSession(tx, event.sessionId!)))?.id;
      if (paymentId && event.paymentStatus === "paid") {
        outcome = await applyCheckoutStatus(paymentId, { status: "complete", paymentStatus: "paid", paymentIntentId: event.paymentIntentId, amountTotal: event.amountTotal, sessionId: event.sessionId });
      } else outcome = "awaiting_async_payment";
    } else if (event.type === "checkout.session.expired" && event.paymentId && event.sessionId) {
      outcome = await applyCheckoutStatus(event.paymentId, { sessionId: event.sessionId, status: "expired", paymentStatus: "unpaid", paymentIntentId: null, amountTotal: null });
    } else if (event.type === "checkout.session.async_payment_failed" && event.paymentId) {
      await withServiceTx((tx) => paymentsRepo.update(tx, event.paymentId!, { status: "failed", failure_code: "async_payment_failed" }));
      outcome = "failed";
    }
    await withServiceTx((tx) => paymentsRepo.markEventProcessed(tx, event.id, outcome));
    return outcome === "ignored" ? "ignored" : "processed";
  } catch (err) {
    // Release the event so the provider's retry is processed again.
    await withServiceTx((tx) => tx`delete from public.payment_events where provider_event_id = ${event.id} and processed_at is null`).catch(() => {});
    throw err;
  }
}

/** The browser asks after redirect; we answer from the ledger, verifying with the provider if still pending. */
export async function getPaymentStatus(user: SessionUser, paymentId: string) {
  requireRole(user, "homeowner");
  const p = await withServiceTx(async (tx) => {
    const p = await paymentsRepo.getById(tx, paymentId);
    if (!p) throw new AppError("NOT_FOUND");
    const job = await jobsRepo.getJob(tx, p.jobId);
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    return p;
  });
  if ((p.status === "pending" || p.status === "unknown") && p.providerSessionId) {
    const s = await verifySession(p.providerSessionId);
    if (s) await applyCheckoutStatus(p.id, s);
  }
  const fresh = await withServiceTx((tx) => paymentsRepo.getById(tx, paymentId));
  return { id: fresh!.id, status: fresh!.status, amountPence: fresh!.amountPence, jobId: fresh!.jobId };
}

/** Records a refund in the ledger; the provider call happens later in reconcilePayments (outside the transaction). */
export async function queueRefund(tx: Tx, original: PaymentRow): Promise<void> {
  const { created, row } = await paymentsRepo.insertPayment(tx, {
    jobId: original.jobId, contractId: original.contractId, kind: "refund", amountPence: original.amountPence, idempotencyKey: `refund_${original.id}`,
  });
  if (created) {
    await audit(tx, SYSTEM_ACTOR, "payment.refund_requested", "payment", row.id, { originalPaymentId: original.id, amountPence: original.amountPence });
  }
}

/** Background: send queued refunds and reconcile anything unsettled with the provider. */
export async function reconcilePayments(): Promise<{ refunds: number; reconciled: number }> {
  let refunds = 0;
  let reconciled = 0;
  const due = await withServiceTx((tx) => paymentsRepo.unsettled(tx, 0, 50));
  for (const p of due) {
    try {
      if (p.kind === "refund") {
        const origId = p.idempotencyKey.replace(/^refund_/, "");
        const orig = await withServiceTx((tx) => paymentsRepo.getById(tx, origId));
        if (!orig?.providerPaymentIntentId) continue;
        // Idempotency key = refund ledger key: repeating this call can never double-refund.
        await withTimeout("payments.refund", 12_000, () => payments().refund(orig.providerPaymentIntentId!, p.amountPence, p.idempotencyKey));
        await withServiceTx(async (tx) => {
          await paymentsRepo.update(tx, p.id, { status: "succeeded" });
          await paymentsRepo.update(tx, orig.id, { status: "refunded" });
        });
        refunds++;
      } else if (p.providerSessionId && Date.now() - new Date(p.updatedAt).getTime() > 10 * 60_000) {
        const s = await verifySession(p.providerSessionId);
        if (s) {
          await applyCheckoutStatus(p.id, s);
          reconciled++;
        }
      }
    } catch (err) {
      log.warn("payment.reconcile_failed", { paymentId: p.id, err });
      await withServiceTx((tx) => paymentsRepo.update(tx, p.id, { status: "unknown" })).catch(() => {});
    }
  }
  return { refunds, reconciled };
}
