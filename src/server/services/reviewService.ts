import "server-only";
import { config } from "../config";
import { withServiceTx } from "../db/client";
import * as jobsRepo from "../db/repositories/jobs";
import * as mediaRepo from "../db/repositories/media";
import { AppError } from "../errors";
import { requireRole, type SessionUser } from "../authz/policies";
import { calculateBeatPrice } from "../domain/pricing";
import { formatGBP } from "@/lib/money";
import { audit } from "./audit";
import { enqueue } from "./notificationService";
import { publicMediaView } from "./jobService";
import type { JobStatus } from "../domain/jobStateMachine";

export async function listQueue(user: SessionUser, statuses: JobStatus[], cursor: string | undefined, limit: number) {
  requireRole(user, "admin");
  return withServiceTx((tx) => jobsRepo.listByStatus(tx, statuses, cursor, limit));
}

export async function startReview(user: SessionUser, jobId: string) {
  requireRole(user, "admin");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.transition(tx, jobId, "submitted", "in_review", { reviewed_by: user.id });
    if (!job) {
      const existing = await jobsRepo.getJob(tx, jobId);
      if (!existing) throw new AppError("NOT_FOUND");
      if (existing.status === "in_review") return existing;
      throw new AppError("INVALID_TRANSITION");
    }
    await audit(tx, user, "job.review_started", "job", jobId);
    return job;
  });
}

export async function getReviewDetail(user: SessionUser, jobId: string) {
  requireRole(user, "admin");
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId);
    if (!job) throw new AppError("NOT_FOUND");
    const [quote, media, address] = await Promise.all([jobsRepo.getQuote(tx, jobId), mediaRepo.listForJob(tx, jobId), jobsRepo.getAddress(tx, jobId)]);
    return { job, quote, address, media: media.map(publicMediaView) };
  });
}

type Decision =
  | { decision: "approve"; standardScope: string; beatBasisPoints: number; publishMediaIds: string[]; expectedVersion: number }
  | { decision: "reject"; reason: string; expectedVersion: number };

export async function decide(user: SessionUser, jobId: string, d: Decision) {
  requireRole(user, "admin");
  const cfg = config();
  return withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
    if (!job) throw new AppError("NOT_FOUND");
    if (job.version !== d.expectedVersion) throw new AppError("CONFLICT");
    if (job.status !== "in_review") throw new AppError("INVALID_TRANSITION");

    if (d.decision === "reject") {
      const updated = await jobsRepo.transition(tx, jobId, "in_review", "rejected", { rejection_reason: d.reason, reviewed_by: user.id, reviewed_at: new Date() });
      await audit(tx, user, "job.rejected", "job", jobId, { reason: d.reason });
      await enqueue(tx, job.homeownerId, "job_rejected", { jobId, title: job.title, reason: d.reason }, `job_rejected:${jobId}`);
      return updated!;
    }

    const quote = await jobsRepo.getQuote(tx, jobId);
    if (!quote) throw new AppError("VALIDATION_FAILED", { internal: "no quote" });
    const price = calculateBeatPrice(quote.quotePricePence, d.beatBasisPoints, cfg.MINIMUM_JOB_PRICE_PENCE);
    if (!price.ok) throw new AppError(price.reason === "BELOW_MINIMUM" ? "BELOW_MINIMUM_PRICE" : "VALIDATION_FAILED");

    // Publish only media the admin explicitly selected and that passed processing.
    const media = await mediaRepo.listForJob(tx, jobId);
    const byId = new Map(media.map((m) => [m.id, m]));
    for (const id of d.publishMediaIds) {
      const m = byId.get(id);
      if (!m) throw new AppError("VALIDATION_FAILED", { fields: { publishMediaIds: "Unknown media item" } });
      if (m.kind === "quote_document") throw new AppError("VALIDATION_FAILED", { fields: { publishMediaIds: "Original quotations can never be published. Upload a redacted copy." } });
      if (m.status !== "ready" || m.scanStatus === "infected") throw new AppError("VALIDATION_FAILED", { fields: { publishMediaIds: `${m.originalFilename} is not ready to publish` } });
    }
    const publishing = d.publishMediaIds.map((id) => byId.get(id)!);
    if (!publishing.some((m) => m.kind === "quote_redacted")) throw new AppError("VALIDATION_FAILED", { fields: { publishMediaIds: "Publish a redacted copy of the quote before approving." } });
    if (!publishing.some((m) => m.kind === "photo")) throw new AppError("VALIDATION_FAILED", { fields: { publishMediaIds: "Publish at least one photo." } });

    for (const m of publishing) {
      await mediaRepo.update(tx, m.id, { visible_to_builders: true });
      await audit(tx, user, "media.published", "media", m.id, { jobId, kind: m.kind });
    }
    const windowEndsAt = new Date(Date.now() + cfg.CREW_WINDOW_HOURS * 3600_000);
    const updated = await jobsRepo.transition(tx, jobId, "in_review", "crew_window", {
      standard_scope: d.standardScope,
      beat_percent: (d.beatBasisPoints / 100).toFixed(2),
      beat_price_pence: price.beatPricePence,
      current_window: "crew",
      window_ends_at: windowEndsAt,
      reviewed_by: user.id,
      reviewed_at: new Date(),
    });
    await audit(tx, user, "job.approved", "job", jobId, { beatPricePence: price.beatPricePence, beatBps: d.beatBasisPoints, published: publishing.length });
    await enqueue(tx, job.homeownerId, "job_approved", { jobId, title: job.title, price: formatGBP(price.beatPricePence) }, `job_approved:${jobId}`);
    const crews = await tx<{ id: string }[]>`
      select id from public.builders where status = 'approved' and kind = 'crew'
        and ${job.trade} = any(trades) and ${job.postcodeDistrict} = any(service_districts) limit 200`;
    for (const c of crews) {
      await enqueue(tx, c.id, "new_job_available", { jobId, trade: job.trade, district: job.postcodeDistrict, price: formatGBP(price.beatPricePence) }, `new_job:${jobId}:${c.id}`, ["email", "sms"]);
    }
    return updated!;
  });
}
