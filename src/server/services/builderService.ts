import "server-only";
import { withServiceTx, withUserTx } from "../db/client";
import * as buildersRepo from "../db/repositories/builders";
import * as jobsRepo from "../db/repositories/jobs";
import * as mediaRepo from "../db/repositories/media";
import * as offersRepo from "../db/repositories/offers";
import { AppError } from "../errors";
import { builderMatchesJob, requireRole, type BuilderAuth, type SessionUser } from "../authz/policies";
import { addressRevealed } from "../domain/jobStateMachine";
import { audit } from "./audit";
import { enqueue } from "./notificationService";
import type { BuilderRow } from "../db/types";

export function toBuilderAuth(b: BuilderRow): BuilderAuth {
  return { id: b.id, status: b.status, kind: b.kind, trades: b.trades, serviceDistricts: b.serviceDistricts };
}

export async function apply(user: SessionUser, a: { companyName: string; companiesHouseNumber?: string; trades: string[]; serviceDistricts: string[]; phone: string; insuranceExpiresOn?: string }) {
  requireRole(user, "builder");
  return withServiceTx(async (tx) => {
    const existing = await buildersRepo.getBuilder(tx, user.id);
    if (existing && (existing.status === "approved" || existing.status === "suspended")) {
      // Approved builders can't silently widen their own trades/areas.
      throw new AppError("FORBIDDEN", { internal: "approved builders change details via admin" });
    }
    await tx`update public.profiles set phone = ${a.phone} where id = ${user.id}`;
    const row = await buildersRepo.upsertApplication(tx, user.id, a);
    await audit(tx, user, "builder.applied", "builder", user.id, { trades: a.trades, districts: a.serviceDistricts.length });
    return row;
  });
}

export async function getMyBuilder(user: SessionUser) {
  requireRole(user, "builder");
  return withServiceTx((tx) => buildersRepo.getBuilder(tx, user.id));
}

export async function listAvailableJobs(user: SessionUser, cursor: string | undefined, limit: number) {
  requireRole(user, "builder");
  return withServiceTx(async (tx) => {
    const b = await buildersRepo.getBuilder(tx, user.id);
    if (!b || b.status !== "approved" || !b.kind) throw new AppError("BUILDER_NOT_APPROVED");
    const page = await jobsRepo.listAvailableForBuilder(tx, { kind: b.kind, trades: b.trades, serviceDistricts: b.serviceDistricts }, cursor, limit);
    return { ...page, items: page.items.map(builderJobView) };
  });
}

export async function listMyOffers(user: SessionUser, cursor: string | undefined, limit: number) {
  requireRole(user, "builder");
  return withServiceTx((tx) => offersRepo.listForBuilder(tx, user.id, cursor, limit));
}

/** Only the fields a builder may see. No quote price, rival name or homeowner identity. */
export function builderJobView(j: import("../db/types").JobRow) {
  return {
    id: j.id, status: j.status, trade: j.trade, title: j.title, postcodeDistrict: j.postcodeDistrict,
    standardScope: j.standardScope, beatPricePence: j.beatPricePence, currentWindow: j.currentWindow,
    windowEndsAt: j.windowEndsAt, createdAt: j.createdAt,
  };
}

/**
 * Builder's view of one job. Reads run as the builder under RLS, so even a bug
 * in this function cannot return a job outside their window or another
 * builder's contract.
 */
export async function getBuilderJob(user: SessionUser, jobId: string) {
  requireRole(user, "builder");
  const data = await withUserTx(user, async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId);
    if (!job) return null;
    const [media, offer, contract, address] = await Promise.all([
      mediaRepo.listVisibleToBuilders(tx, jobId),
      tx<import("../db/types").OfferRow[]>`select * from public.offers where job_id = ${jobId} and builder_id = ${user.id} order by created_at desc limit 1`,
      offersRepo.contractForJob(tx, jobId),
      jobsRepo.getAddress(tx, jobId),
    ]);
    const variations = contract ? await offersRepo.variationsForJob(tx, jobId) : [];
    const prestart = contract ? await offersRepo.latestPrestart(tx, jobId) : null;
    const agreed = contract ? await offersRepo.agreedPrice(tx, jobId) : null;
    return { job, media, offer: offer[0] ?? null, contract, address, variations, prestart, agreed };
  });
  if (!data) throw new AppError("NOT_FOUND");
  const myContract = data.contract && data.contract.builderId === user.id ? data.contract : null;
  // The address is revealed only once the homeowner has accepted this builder's offer.
  const showAddress = !!myContract && addressRevealed(data.job.status);
  return {
    job: builderJobView(data.job),
    media: data.media.map((m) => ({ id: m.id, kind: m.kind, filename: m.kind === "quote_redacted" ? "Redacted quote" : m.originalFilename, mime: m.detectedMime ?? m.declaredMime, hasThumbnail: !!m.thumbnailPath })),
    offer: data.offer,
    contract: myContract,
    address: showAddress ? data.address : null,
    variations: myContract ? data.variations : [],
    prestart: myContract ? data.prestart : null,
    agreedPricePence: myContract ? data.agreed : null,
  };
}

export async function adminListBuilders(user: SessionUser, status: BuilderRow["status"], cursor: string | undefined, limit: number) {
  requireRole(user, "admin");
  return withServiceTx((tx) => buildersRepo.listByStatus(tx, status, cursor, limit));
}

export async function adminDecide(
  user: SessionUser,
  builderId: string,
  d: { decision: "approve"; kind: "crew" | "partner" } | { decision: "reject" | "suspend"; reason: string },
) {
  requireRole(user, "admin");
  if (builderId === user.id) throw new AppError("FORBIDDEN", { internal: "self-approval" });
  return withServiceTx(async (tx) => {
    const b = await buildersRepo.getBuilder(tx, builderId);
    if (!b) throw new AppError("NOT_FOUND");
    const status = d.decision === "approve" ? "approved" : d.decision === "reject" ? "rejected" : "suspended";
    const row = await buildersRepo.setDecision(tx, builderId, status, d.decision === "approve" ? d.kind : null, user.id);
    await audit(tx, user, d.decision === "approve" ? "builder.approved" : d.decision === "reject" ? "builder.rejected" : "builder.suspended", "builder", builderId, d);
    await enqueue(tx, builderId, "builder_decided", { decision: status }, `builder_decided:${builderId}:${status}:${Date.now()}`);
    return row;
  });
}

export { builderMatchesJob };
