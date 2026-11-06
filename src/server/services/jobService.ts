import "server-only";
import { withServiceTx } from "../db/client";
import * as jobsRepo from "../db/repositories/jobs";
import * as mediaRepo from "../db/repositories/media";
import * as offersRepo from "../db/repositories/offers";
import * as paymentsRepo from "../db/repositories/payments";
import { AppError } from "../errors";
import { assertOwnsJob, requireRole, type SessionUser } from "../authz/policies";
import type { JobDraft } from "@/lib/schemas";
import type { MediaRow } from "../db/types";
import { audit } from "./audit";
import { enqueue } from "./notificationService";

export async function createDraft(user: SessionUser, draft: JobDraft, submissionKey: string) {
  requireRole(user, "homeowner");
  return withServiceTx(async (tx) => {
    const { job, created } = await jobsRepo.insertDraft(tx, user.id, draft, submissionKey);
    if (created) await audit(tx, user, "job.created", "job", job.id, { trade: job.trade });
    return { job, created };
  });
}

export async function updateDraft(user: SessionUser, jobId: string, draft: JobDraft) {
  requireRole(user, "homeowner");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    if (job.status !== "draft") throw new AppError("INVALID_TRANSITION");
    const updated = await jobsRepo.updateDraft(tx, jobId, draft);
    await audit(tx, user, "job.updated", "job", jobId);
    return updated;
  });
}

export async function submitJob(user: SessionUser, jobId: string) {
  requireRole(user, "homeowner");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    if (job.status === "submitted") return job; // repeat submit is a no-op
    if (job.status !== "draft") throw new AppError("INVALID_TRANSITION");
    const media = await mediaRepo.listForJob(tx, jobId);
    const usable = media.filter((m) => ["uploaded", "processing", "ready"].includes(m.status));
    const hasQuote = usable.some((m) => m.kind === "quote_document");
    const hasPhoto = usable.some((m) => m.kind === "photo");
    const pending = media.some((m) => m.status === "pending_upload");
    if (!hasQuote || !hasPhoto) throw new AppError("SUBMISSION_INCOMPLETE");
    if (pending) throw new AppError("SUBMISSION_INCOMPLETE", { fields: { media: "Please wait for all uploads to finish, or remove the ones that failed." } });
    const updated = await jobsRepo.transition(tx, jobId, "draft", "submitted", { submitted_at: new Date() });
    if (!updated) throw new AppError("CONFLICT");
    await audit(tx, user, "job.submitted", "job", jobId);
    await enqueue(tx, user.id, "job_submitted", { jobId, title: job.title }, `job_submitted:${jobId}`);
    return updated;
  });
}

export async function cancelJob(user: SessionUser, jobId: string) {
  requireRole(user, "homeowner", "admin");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    const cancellable = user.role === "admin"
      ? ["draft", "submitted", "in_review", "crew_window", "partner_window", "offer_pending", "awaiting_deposit"]
      : ["draft", "submitted", "crew_window", "partner_window", "offer_pending", "awaiting_deposit"];
    if (!cancellable.includes(job.status)) throw new AppError("INVALID_TRANSITION");
    const offer = await offersRepo.liveOfferForJob(tx, jobId);
    if (offer?.status === "pending") await offersRepo.setOfferStatus(tx, offer.id, "pending", "withdrawn");
    const contract = await offersRepo.contractForJob(tx, jobId, { forUpdate: true });
    if (contract) {
      const deposit = await paymentsRepo.liveDeposit(tx, contract.id);
      if (deposit && deposit.status === "succeeded") throw new AppError("INVALID_TRANSITION", { internal: "paid deposit; use variation/termination flow" });
      await offersRepo.terminateContract(tx, contract.id, "cancelled_before_deposit");
    }
    const updated = await jobsRepo.transition(tx, jobId, job.status, "cancelled");
    if (!updated) throw new AppError("CONFLICT");
    await audit(tx, user, "job.cancelled", "job", jobId, { from: job.status });
    return updated;
  });
}

export async function listMyJobs(user: SessionUser, cursor: string | undefined, limit: number) {
  requireRole(user, "homeowner");
  return withServiceTx((tx) => jobsRepo.listForHomeowner(tx, user.id, cursor, limit));
}

/** Everything the homeowner sees on their job page. */
export async function getHomeownerJob(user: SessionUser, jobId: string) {
  requireRole(user, "homeowner");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId);
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    const [address, quote, media, offer, contract] = await Promise.all([
      jobsRepo.getAddress(tx, jobId),
      jobsRepo.getQuote(tx, jobId),
      mediaRepo.listForJob(tx, jobId),
      offersRepo.liveOfferForJob(tx, jobId),
      offersRepo.contractForJob(tx, jobId),
    ]);
    const [variations, payments, agreed] = contract
      ? await Promise.all([offersRepo.variationsForJob(tx, jobId), paymentsRepo.listForJob(tx, jobId), offersRepo.agreedPrice(tx, jobId)])
      : [[], [], null];
    return {
      job, address, quote, offer, contract, variations, payments, agreedPricePence: agreed,
      media: media.filter((m) => m.kind !== "quote_redacted").map(publicMediaView),
    };
  });
}

export function publicMediaView(m: MediaRow) {
  return {
    id: m.id, kind: m.kind, status: m.status, scanStatus: m.scanStatus, filename: m.originalFilename,
    sizeBytes: Number(m.sizeBytes), mime: m.detectedMime ?? m.declaredMime, hasThumbnail: !!m.thumbnailPath,
    visibleToBuilders: m.visibleToBuilders, metadataStripped: m.metadataStripped, errorCode: m.errorCode,
  };
}
export type PublicMedia = ReturnType<typeof publicMediaView>;
