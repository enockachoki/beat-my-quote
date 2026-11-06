import "server-only";
import { withServiceTx } from "../db/client";
import * as jobsRepo from "../db/repositories/jobs";
import * as offersRepo from "../db/repositories/offers";
import * as paymentsRepo from "../db/repositories/payments";
import { AppError, fromDatabase } from "../errors";
import { assertContractBuilder, assertContractHomeowner, assertVariationAllowed, requireRole, type SessionUser } from "../authz/policies";
import { checkProposedVariation, declineOutcome } from "../domain/variations";
import { formatGBP } from "@/lib/money";
import { audit } from "./audit";
import { enqueue } from "./notificationService";
import { queueRefund } from "./paymentService";

/** Pre-start check (not a quote visit): the builder confirms the job matches the uploads. */
export async function recordPrestart(user: SessionUser, jobId: string, outcome: "confirmed" | "variation_required", notes?: string) {
  requireRole(user, "builder");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    assertContractBuilder(user, await offersRepo.contractForJob(tx, jobId));
    if (job.status !== "deposit_paid") throw new AppError("INVALID_TRANSITION");
    await offersRepo.insertPrestart(tx, jobId, user.id, outcome, notes ?? null);
    await audit(tx, user, "prestart.recorded", "job", jobId, { outcome });
    return { outcome };
  });
}

export async function proposeVariation(user: SessionUser, jobId: string, v: { reason: "not_reasonably_visible" | "homeowner_requested"; description: string; amountPounds: number }) {
  requireRole(user, "builder");
  try {
    return await withServiceTx(async (tx) => {
      const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
      if (!job) throw new AppError("NOT_FOUND");
      const contract = assertContractBuilder(user, await offersRepo.contractForJob(tx, jobId));
      assertVariationAllowed(job.status);
      const agreed = (await offersRepo.agreedPrice(tx, jobId)) ?? 0;
      const check = checkProposedVariation(agreed, v.amountPounds);
      if (!check.ok) throw new AppError("VALIDATION_FAILED", { fields: { amountPounds: "This change would make the price zero or less." } });
      const row = await offersRepo.insertVariation(tx, { jobId, contractId: contract.id, proposedBy: user.id, reason: v.reason, description: v.description, amountPence: v.amountPounds });
      await audit(tx, user, "variation.proposed", "variation", row.id, { jobId, amountPence: row.amountPence, reason: row.reason });
      await enqueue(tx, contract.homeownerId, "variation_proposed", { jobId, title: job.title }, `variation_proposed:${row.id}`, ["email", "sms"]);
      return row;
    });
  } catch (err) {
    const mapped = fromDatabase(err);
    if (mapped?.code === "CONFLICT") throw new AppError("CONFLICT", { fields: { _: "There is already a variation waiting for a decision." } });
    throw mapped ?? err;
  }
}

/**
 * Homeowner decides a written Variation Form. Approval is the ONLY way the
 * agreed price changes. Declining a "not reasonably visible" variation before
 * work starts ends the contract and refunds the deposit in full.
 */
export async function decideVariation(user: SessionUser, variationId: string, decision: "approve" | "decline") {
  requireRole(user, "homeowner");
  return withServiceTx(async (tx) => {
    const v0 = await offersRepo.getVariation(tx, variationId);
    if (!v0) throw new AppError("NOT_FOUND");
    const job = await jobsRepo.getJob(tx, v0.jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    const contract = assertContractHomeowner(user, await offersRepo.contractForJob(tx, job.id, { forUpdate: true }));
    const v = await offersRepo.getVariation(tx, variationId, { forUpdate: true });
    if (!v || v.status !== "proposed") throw new AppError("INVALID_TRANSITION");
    const decided = await offersRepo.decideVariation(tx, v.id, decision === "approve" ? "approved" : "declined", user.id);
    await audit(tx, user, decision === "approve" ? "variation.approved" : "variation.declined", "variation", v.id, { jobId: job.id, amountPence: v.amountPence });
    await enqueue(tx, contract.builderId, "variation_decided", { jobId: job.id, title: job.title, decision: decision === "approve" ? "approved" : "declined" }, `variation_decided:${v.id}`);

    let terminated = false;
    if (decision === "decline" && declineOutcome(v.reason, job.status) === "terminate_and_refund") {
      await offersRepo.terminateContract(tx, contract.id, "variation_declined");
      await jobsRepo.transition(tx, job.id, "deposit_paid", "cancelled");
      const deposit = await paymentsRepo.liveDeposit(tx, contract.id, { forUpdate: true });
      if (deposit?.status === "succeeded") await queueRefund(tx, deposit);
      await audit(tx, user, "contract.terminated", "contract", contract.id, { reason: "variation_declined", refundPence: deposit?.amountPence ?? 0 });
      const refund = deposit ? `Your deposit of ${formatGBP(deposit.amountPence)} will be refunded in full.` : "";
      await enqueue(tx, contract.homeownerId, "contract_terminated", { title: job.title, refund, path: `/homeowner/jobs/${job.id}` }, `terminated:${contract.id}:h`);
      await enqueue(tx, contract.builderId, "contract_terminated", { title: job.title, path: `/builder/jobs/${job.id}` }, `terminated:${contract.id}:b`);
      terminated = true;
    }
    return { variation: decided, terminated, agreedPricePence: await offersRepo.agreedPrice(tx, job.id) };
  });
}

export async function startWork(user: SessionUser, jobId: string) {
  requireRole(user, "builder");
  try {
    return await withServiceTx(async (tx) => {
      const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
      if (!job) throw new AppError("NOT_FOUND");
      assertContractBuilder(user, await offersRepo.contractForJob(tx, jobId));
      if (job.status === "in_progress") return job;
      // The database trigger independently checks contract, paid deposit, confirmed pre-start check and no open variation.
      const moved = await jobsRepo.transition(tx, jobId, "deposit_paid", "in_progress");
      if (!moved) throw new AppError("START_CONDITIONS_UNMET");
      await audit(tx, user, "job.started", "job", jobId);
      return moved;
    });
  } catch (err) {
    throw fromDatabase(err) ?? err;
  }
}

export async function completeWork(user: SessionUser, jobId: string) {
  requireRole(user, "builder", "admin");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    const contract = await offersRepo.contractForJob(tx, jobId, { forUpdate: true });
    if (user.role === "builder") assertContractBuilder(user, contract);
    if (await tx`select 1 from public.variations where job_id = ${jobId} and status = 'proposed'`.then((r) => r.length > 0)) throw new AppError("INVALID_TRANSITION", { internal: "open variation" });
    const moved = await jobsRepo.transition(tx, jobId, "in_progress", "completed");
    if (!moved) throw new AppError("INVALID_TRANSITION");
    if (contract) await offersRepo.completeContract(tx, contract.id);
    await audit(tx, user, "job.completed", "job", jobId);
    return moved;
  });
}
