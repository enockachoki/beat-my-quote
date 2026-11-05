import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as offerService from "@/server/services/offerService";
import * as paymentService from "@/server/services/paymentService";
import { payments, setPaymentsForTests } from "@/server/payments";
import { FakePaymentProvider } from "@/server/payments/fake";
import type { PaymentProvider } from "@/server/payments/types";
import { closeDb } from "@/server/db/client";
import { approvedJob, codeOf, makeUser, sql } from "./helpers";

afterAll(async () => {
  await closeDb();
});
afterEach(() => setPaymentsForTests(undefined));

async function acceptedJob() {
  const ctx = await approvedJob();
  const crew = await makeUser("builder", { kind: "crew" });
  const offer = await offerService.claimJob(crew, ctx.job.id);
  const { contract } = await offerService.decideOffer(ctx.homeowner, offer.id, "accept", "draft-2026-11");
  return { ...ctx, crew, contract: contract! };
}
const status = async (jobId: string) => (await sql<{ status: string }[]>`select status from public.jobs where id = ${jobId}`)[0]!.status;

describe("deposits", () => {
  it("only the homeowner can start the deposit, and only at the right stage", async () => {
    const { job, crew } = await acceptedJob();
    expect(await codeOf(paymentService.startDeposit(await makeUser("homeowner"), job.id))).toBe("NOT_FOUND");
    expect(await codeOf(paymentService.startDeposit(crew, job.id))).toBe("FORBIDDEN");
    const fresh = await approvedJob();
    expect(await codeOf(paymentService.startDeposit(fresh.homeowner, fresh.job.id))).toBe("INVALID_TRANSITION");
  });

  it("repeated deposit attempts reuse ONE ledger row and ONE checkout session", async () => {
    const { job, homeowner } = await acceptedJob();
    const a = await paymentService.startDeposit(homeowner, job.id);
    const b = await paymentService.startDeposit(homeowner, job.id);
    expect(a.paymentId).toBe(b.paymentId);
    expect(a.url).toBe(b.url);
    const rows = await sql`select * from public.payments where job_id = ${job.id} and kind = 'deposit'`;
    expect(rows.length).toBe(1);
  });

  it("the job is NOT marked paid until a verified webhook arrives; duplicates are processed once", async () => {
    const { job, homeowner } = await acceptedJob();
    const { paymentId } = await paymentService.startDeposit(homeowner, job.id);
    expect(await status(job.id)).toBe("awaiting_deposit");
    const [p] = await sql<{ providerSessionId: string }[]>`select provider_session_id from public.payments where id = ${paymentId}`;
    const delivery = (payments() as FakePaymentProvider).completeSession(p!.providerSessionId)!;
    expect(await codeOf(paymentService.handleWebhook(delivery.body, "t=1,v1=forged"))).toBe("FORBIDDEN");
    expect(await status(job.id)).toBe("awaiting_deposit");
    expect(await paymentService.handleWebhook(delivery.body, delivery.signature)).toBe("processed");
    expect(await paymentService.handleWebhook(delivery.body, delivery.signature)).toBe("duplicate");
    expect(await status(job.id)).toBe("deposit_paid");
    const audits = await sql`select * from public.audit_log where entity_id = ${paymentId} and action = 'payment.succeeded'`;
    expect(audits.length).toBe(1);
  });

  it("if the webhook is lost, the status check verifies with the provider", async () => {
    const { job, homeowner } = await acceptedJob();
    const { paymentId } = await paymentService.startDeposit(homeowner, job.id);
    const [p] = await sql<{ providerSessionId: string }[]>`select provider_session_id from public.payments where id = ${paymentId}`;
    (payments() as FakePaymentProvider).completeSession(p!.providerSessionId); // paid, webhook never delivered
    expect((await paymentService.getPaymentStatus(homeowner, paymentId)).status).toBe("succeeded");
    expect(await status(job.id)).toBe("deposit_paid");
    expect(await codeOf(paymentService.getPaymentStatus(await makeUser("homeowner"), paymentId))).toBe("NOT_FOUND");
  });

  it("an ambiguous provider timeout is recorded as unknown and retried with the SAME idempotency key", async () => {
    const { job, homeowner } = await acceptedJob();
    const real = payments();
    const keys: string[] = [];
    let first = true;
    const flaky: PaymentProvider = {
      ...real,
      name: "fake",
      retrieveCheckout: (id) => real.retrieveCheckout(id),
      verifyWebhook: (b, s) => real.verifyWebhook(b, s),
      refund: (a, b, c) => real.refund(a, b, c),
      async createCheckout(req) {
        keys.push(req.idempotencyKey);
        if (first) {
          first = false;
          throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        }
        return real.createCheckout(req);
      },
    };
    setPaymentsForTests(flaky);
    expect(await codeOf(paymentService.startDeposit(homeowner, job.id))).toBe("PAYMENT_UNAVAILABLE");
    const [p1] = await sql<{ status: string }[]>`select status from public.payments where job_id = ${job.id}`;
    expect(p1!.status).toBe("unknown");
    await paymentService.startDeposit(homeowner, job.id);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await sql`select * from public.payments where job_id = ${job.id}`).length).toBe(1);
  });

  it("an amount mismatch is never marked as paid", async () => {
    const { job, homeowner } = await acceptedJob();
    const { paymentId } = await paymentService.startDeposit(homeowner, job.id);
    const r = await paymentService.applyCheckoutStatus(paymentId, { sessionId: "cs_x", status: "complete", paymentStatus: "paid", paymentIntentId: "pi_x", amountTotal: 1 });
    expect(r).toBe("mismatch");
    expect(await status(job.id)).toBe("awaiting_deposit");
  });

  it("queued refunds are sent once by reconciliation", async () => {
    const { job, contract } = await acceptedJob();
    const [dep] = await sql<{ id: string }[]>`insert into public.payments (job_id, contract_id, kind, amount_pence, status, idempotency_key, provider_payment_intent_id)
      values (${job.id}, ${contract.id}, 'deposit', ${contract.depositPence}, 'succeeded', ${"dep-r-" + contract.id}, 'pi_fake_refundme') returning id`;
    await sql`insert into public.payments (job_id, contract_id, kind, amount_pence, idempotency_key) values (${job.id}, ${contract.id}, 'refund', ${contract.depositPence}, ${"refund_" + dep!.id})`;
    await paymentService.reconcilePayments();
    const rows = await sql<{ kind: string; status: string }[]>`select kind, status from public.payments where contract_id = ${contract.id} order by kind`;
    expect(rows).toEqual([{ kind: "deposit", status: "refunded" }, { kind: "refund", status: "succeeded" }]);
  });
});
