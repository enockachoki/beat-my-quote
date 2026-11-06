import { AppError } from "../errors";
import type { JobStatus } from "../domain/jobStateMachine";

/**
 * Server-side authorisation rules, as pure functions so they can be unit
 * tested. Every service calls these before touching data; RLS in the database
 * is a second, independent layer. Hidden buttons in the UI are never relied on.
 */
export type Role = "homeowner" | "builder" | "admin";

export interface SessionUser {
  id: string;
  role: Role;
  email: string;
}

export interface BuilderAuth {
  id: string;
  status: "pending" | "approved" | "rejected" | "suspended";
  kind: "crew" | "partner" | null;
  trades: string[];
  serviceDistricts: string[];
}

export interface JobAuth {
  id: string;
  homeownerId: string;
  status: JobStatus;
  trade: string;
  postcodeDistrict: string;
  windowEndsAt: Date | null;
}

export function requireRole(user: SessionUser | null, ...roles: Role[]): SessionUser {
  if (!user) throw new AppError("UNAUTHENTICATED");
  if (!roles.includes(user.role)) throw new AppError("FORBIDDEN", { internal: `role ${user.role} not in ${roles.join(",")}` });
  return user;
}

export function assertOwnsJob(user: SessionUser, job: Pick<JobAuth, "homeownerId">): void {
  // NOT_FOUND rather than FORBIDDEN so we don't confirm another user's job exists.
  if (user.role !== "admin" && job.homeownerId !== user.id) throw new AppError("NOT_FOUND", { internal: "not job owner" });
}

export function builderMatchesJob(builder: BuilderAuth, job: Pick<JobAuth, "trade" | "postcodeDistrict">): boolean {
  return builder.trades.includes(job.trade) && builder.serviceDistricts.includes(job.postcodeDistrict);
}

/** Crews get first refusal; partners only once the crew window has passed. */
export function windowOpenFor(builder: BuilderAuth, job: Pick<JobAuth, "status" | "windowEndsAt">, now: Date): boolean {
  if (job.windowEndsAt && job.windowEndsAt.getTime() <= now.getTime()) return false;
  if (job.status === "crew_window") return builder.kind === "crew";
  if (job.status === "partner_window") return builder.kind === "crew" || builder.kind === "partner";
  return false;
}

export function assertCanClaim(builder: BuilderAuth | null, job: JobAuth, now: Date): void {
  if (!builder || builder.status !== "approved" || !builder.kind) throw new AppError("BUILDER_NOT_APPROVED");
  if (!builderMatchesJob(builder, job)) throw new AppError("NOT_FOUND", { internal: "trade/area mismatch" });
  if (!windowOpenFor(builder, job, now)) throw new AppError("JOB_NOT_AVAILABLE", { internal: `status ${job.status}` });
}

export interface OfferAuth {
  id: string;
  jobId: string;
  builderId: string;
  status: "pending" | "accepted" | "declined" | "expired" | "withdrawn";
  expiresAt: Date;
}

export function assertCanDecideOffer(user: SessionUser, job: JobAuth, offer: OfferAuth, now: Date): void {
  assertOwnsJob(user, job);
  if (user.role !== "homeowner") throw new AppError("FORBIDDEN", { internal: "only the homeowner decides offers" });
  if (offer.jobId !== job.id) throw new AppError("NOT_FOUND");
  if (job.status !== "offer_pending") throw new AppError("INVALID_TRANSITION", { internal: `job ${job.status}` });
  if (offer.status !== "pending") throw new AppError(offer.status === "expired" ? "OFFER_EXPIRED" : "INVALID_TRANSITION");
  if (offer.expiresAt.getTime() <= now.getTime()) throw new AppError("OFFER_EXPIRED");
}

export interface ContractAuth {
  id: string;
  jobId: string;
  builderId: string;
  homeownerId: string;
  status: "active" | "terminated" | "completed";
}

export function assertContractBuilder(user: SessionUser, contract: ContractAuth | null): ContractAuth {
  if (!contract || user.role !== "builder" || contract.builderId !== user.id) throw new AppError("NOT_FOUND", { internal: "not contract builder" });
  if (contract.status !== "active") throw new AppError("INVALID_TRANSITION", { internal: `contract ${contract.status}` });
  return contract;
}

export function assertContractHomeowner(user: SessionUser, contract: ContractAuth | null): ContractAuth {
  if (!contract || user.role !== "homeowner" || contract.homeownerId !== user.id) throw new AppError("NOT_FOUND", { internal: "not contract homeowner" });
  if (contract.status !== "active") throw new AppError("INVALID_TRANSITION", { internal: `contract ${contract.status}` });
  return contract;
}

/** Variations only before or during work, never after completion or cancellation. */
export function assertVariationAllowed(jobStatus: JobStatus): void {
  if (jobStatus !== "deposit_paid" && jobStatus !== "in_progress") throw new AppError("INVALID_TRANSITION", { internal: `variation in ${jobStatus}` });
}

/** Media kinds each role may upload. */
export function assertCanUploadKind(user: SessionUser, kind: "photo" | "video" | "quote_document" | "quote_redacted"): void {
  if (kind === "quote_redacted" && user.role !== "admin") throw new AppError("FORBIDDEN", { internal: "only admin uploads redacted quotes" });
  if (kind !== "quote_redacted" && user.role !== "homeowner" && user.role !== "admin") throw new AppError("FORBIDDEN");
}

/** Homeowners may add/remove media only before the job leaves draft. */
export function assertMediaEditable(user: SessionUser, jobStatus: JobStatus): void {
  if (user.role === "admin") {
    if (!["submitted", "in_review"].includes(jobStatus)) throw new AppError("INVALID_TRANSITION");
    return;
  }
  if (jobStatus !== "draft") throw new AppError("INVALID_TRANSITION", { internal: `media edit in ${jobStatus}` });
}
