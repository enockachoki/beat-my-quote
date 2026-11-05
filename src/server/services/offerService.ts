import "server-only";
import { config } from "../config";
import { withServiceTx, type Tx } from "../db/client";
import * as buildersRepo from "../db/repositories/builders";
import * as jobsRepo from "../db/repositories/jobs";
import * as offersRepo from "../db/repositories/offers";
import { AppError, fromDatabase } from "../errors";
import { assertCanClaim, assertCanDecideOffer, requireRole, type SessionUser } from "../authz/policies";
import { depositPence } from "../domain/pricing";
import { formatGBP } from "@/lib/money";
import { audit, SYSTEM_ACTOR } from "./audit";
import { enqueue } from "./notificationService";
import { toBuilderAuth } from "./builderService";
import type { JobRow, OfferRow } from "../db/types";
import { log } from "../observability/logger";

/**
 * A builder takes a job at the platform's beat price (builders never quote).
 * The job row is locked FOR UPDATE so concurrent claims serialise; the
 * offers_one_live_per_job unique index is a second guard if locking were ever
 * bypassed. Exactly one builder can win.
 */
export async function claimJob(user: SessionUser, jobId: string, now = new Date()) {
  requireRole(user, "builder");
  const cfg = config();
  try {
    return await withServiceTx(async (tx) => {
      const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true });
      if (!job) throw new AppError("NOT_FOUND");
      const builder = await buildersRepo.getBuilder(tx, user.id);
      const existing = await offersRepo.liveOfferForJob(tx, jobId);
      if (existing?.builderId === user.id) return existing; // idempotent repeat by the same builder
      assertCanClaim(builder ? toBuilderAuth(builder) : null, job, now);
      if (existing) throw new AppError("JOB_NOT_AVAILABLE");
      const offer = await offersRepo.insertOffer(tx, {
        jobId, builderId: user.id, viaWindow: job.status === "crew_window" ? "crew" : "partner",
        pricePence: job.beatPricePence!, expiresAt: new Date(now.getTime() + cfg.OFFER_ACCEPT_HOURS * 3600_000),
      });
      const moved = await jobsRepo.transition(tx, jobId, ["crew_window", "partner_window"], "offer_pending");
      if (!moved) throw new AppError("JOB_NOT_AVAILABLE");
      await audit(tx, user, "offer.created", "offer", offer.id, { jobId, pricePence: offer.pricePence, via: offer.viaWindow });
      await enqueue(tx, job.homeownerId, "offer_received", {
        jobId, title: job.title, price: formatGBP(offer.pricePence), expires: offer.expiresAt.toLocaleString("en-GB", { timeZone: "Europe/London" }),
      }, `offer_received:${offer.id}`, ["email", "sms"]);
      return offer;
    });
  } catch (err) {
    const mapped = fromDatabase(err);
    if (mapped) throw mapped;
    throw err;
  }
}

/** Where a job goes when its offer is declined or expires. */
async function reopenOrClose(tx: Tx, job: JobRow, offer: OfferRow, actor: SessionUser | typeof SYSTEM_ACTOR) {
  const cfg = config();
  const stillOpen = job.windowEndsAt && job.windowEndsAt.getTime() > Date.now();
  if (offer.viaWindow === "crew" && stillOpen) return jobsRepo.transition(tx, job.id, "offer_pending", "crew_window");
  if (offer.viaWindow === "crew" || (offer.viaWindow === "partner" && stillOpen)) {
    const windowEndsAt = stillOpen && offer.viaWindow === "partner" ? job.windowEndsAt : new Date(Date.now() + cfg.PARTNER_WINDOW_HOURS * 3600_000);
    const row = await jobsRepo.transition(tx, job.id, "offer_pending", "partner_window", { current_window: "partner", window_ends_at: windowEndsAt });
    await audit(tx, actor, "job.window_advanced", "job", job.id, { to: "partner_window" });
    return row;
  }
  const row = await jobsRepo.transition(tx, job.id, "offer_pending", "unmatched");
  await audit(tx, actor, "job.unmatched", "job", job.id);
  return row;
}

export async function decideOffer(user: SessionUser, offerId: string, decision: "accept" | "decline", termsVersion?: string, now = new Date()) {
  requireRole(user, "homeowner");
  const cfg = config();
  return withServiceTx(async (tx) => {
    const offer0 = await offersRepo.getOffer(tx, offerId);
    if (!offer0) throw new AppError("NOT_FOUND");
    // Lock order everywhere: job, then offer, then contract.
    const job = await jobsRepo.getJob(tx, offer0.jobId, { forUpdate: true });
    const offer = await offersRepo.getOffer(tx, offerId, { forUpdate: true });
    if (!job || !offer) throw new AppError("NOT_FOUND");
    assertCanDecideOffer(user, job, offer, now);

    if (decision === "decline") {
      await offersRepo.setOfferStatus(tx, offer.id, "pending", "declined");
      await reopenOrClose(tx, job, offer, user);
      await audit(tx, user, "offer.declined", "offer", offer.id, { jobId: job.id });
      return { offer: { ...offer, status: "declined" as const }, contract: null };
    }

    if (termsVersion !== cfg.CONTRACT_TERMS_VERSION) throw new AppError("CONFLICT", { internal: "terms version changed" });
    const builder = await buildersRepo.getBuilder(tx, offer.builderId);
    if (!builder || builder.status !== "approved") throw new AppError("JOB_NOT_AVAILABLE", { internal: "builder no longer approved" });
    const accepted = await offersRepo.setOfferStatus(tx, offer.id, "pending", "accepted");
    if (!accepted) throw new AppError("CONFLICT");
    const contract = await offersRepo.insertContract(tx, {
      jobId: job.id, offerId: offer.id, homeownerId: job.homeownerId, builderId: offer.builderId,
      pricePence: offer.pricePence, depositPence: depositPence(offer.pricePence, cfg.DEPOSIT_BASIS_POINTS), termsVersion: cfg.CONTRACT_TERMS_VERSION,
    });
    const moved = await jobsRepo.transition(tx, job.id, "offer_pending", "awaiting_deposit");
    if (!moved) throw new AppError("CONFLICT");
    await audit(tx, user, "offer.accepted", "offer", offer.id, { jobId: job.id });
    await audit(tx, user, "contract.created", "contract", contract.id, { jobId: job.id, pricePence: contract.pricePence, depositPence: contract.depositPence, terms: contract.termsVersion });
    await enqueue(tx, offer.builderId, "offer_accepted", { jobId: job.id, title: job.title }, `offer_accepted:${offer.id}`, ["email", "sms"]);
    return { offer: accepted, contract };
  });
}

/** Background: expire offers the homeowner didn't answer in time. */
export async function expireOffers(): Promise<number> {
  return withServiceTx(async (tx) => {
    const due = await offersRepo.expiredPendingOffers(tx, 100);
    for (const offer of due) {
      const job = await jobsRepo.getJob(tx, offer.jobId, { forUpdate: true });
      await offersRepo.setOfferStatus(tx, offer.id, "pending", "expired");
      if (job?.status === "offer_pending") await reopenOrClose(tx, job, offer, SYSTEM_ACTOR);
      await audit(tx, SYSTEM_ACTOR, "offer.expired", "offer", offer.id, { jobId: offer.jobId });
      if (job) await enqueue(tx, job.homeownerId, "offer_expired", { jobId: job.id, title: job.title }, `offer_expired:${offer.id}`);
    }
    return due.length;
  });
}

/** Background: crew first refusal ends -> partners; partner window ends -> unmatched. */
export async function advanceWindows(): Promise<number> {
  const cfg = config();
  return withServiceTx(async (tx) => {
    const due = await jobsRepo.windowsDue(tx, 100);
    for (const job of due) {
      if (job.status === "crew_window") {
        await jobsRepo.transition(tx, job.id, "crew_window", "partner_window", {
          current_window: "partner", window_ends_at: new Date(Date.now() + cfg.PARTNER_WINDOW_HOURS * 3600_000),
        });
        await audit(tx, SYSTEM_ACTOR, "job.window_advanced", "job", job.id, { to: "partner_window" });
        const partners = await tx<{ id: string }[]>`
          select id from public.builders where status = 'approved' and kind = 'partner'
            and ${job.trade} = any(trades) and ${job.postcodeDistrict} = any(service_districts) limit 500`;
        for (const p of partners) {
          await enqueue(tx, p.id, "new_job_available", { jobId: job.id, trade: job.trade, district: job.postcodeDistrict, price: formatGBP(job.beatPricePence ?? 0) }, `new_job:${job.id}:${p.id}`, ["email", "sms"]);
        }
      } else {
        await jobsRepo.transition(tx, job.id, "partner_window", "unmatched");
        await audit(tx, SYSTEM_ACTOR, "job.unmatched", "job", job.id);
      }
    }
    if (due.length) log.info("jobs.windows_advanced", { count: due.length });
    return due.length;
  });
}
