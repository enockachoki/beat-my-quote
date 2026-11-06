import { describe, expect, it } from "vitest";
import {
  assertCanClaim, assertCanDecideOffer, assertCanUploadKind, assertContractBuilder, assertMediaEditable, assertOwnsJob,
  requireRole, windowOpenFor, type BuilderAuth, type JobAuth, type SessionUser,
} from "@/server/authz/policies";
import { AppError } from "@/server/errors";

const homeowner: SessionUser = { id: "h1", role: "homeowner", email: "h@x" };
const other: SessionUser = { id: "h2", role: "homeowner", email: "o@x" };
const admin: SessionUser = { id: "a1", role: "admin", email: "a@x" };
const builderUser: SessionUser = { id: "b1", role: "builder", email: "b@x" };
const now = new Date("2026-11-05T12:00:00Z");
const later = new Date("2026-11-06T12:00:00Z");
const job: JobAuth = { id: "j1", homeownerId: "h1", status: "crew_window", trade: "bathroom-refit", postcodeDistrict: "SE15", windowEndsAt: later };
const crew: BuilderAuth = { id: "b1", status: "approved", kind: "crew", trades: ["bathroom-refit"], serviceDistricts: ["SE15"] };
const partner: BuilderAuth = { ...crew, id: "b2", kind: "partner" };

const code = (fn: () => void) => {
  try {
    fn();
    return "OK";
  } catch (e) {
    return (e as AppError).code;
  }
};

describe("role and ownership checks", () => {
  it("rejects anonymous users and wrong roles", () => {
    expect(code(() => requireRole(null, "admin"))).toBe("UNAUTHENTICATED");
    expect(code(() => requireRole(homeowner, "admin"))).toBe("FORBIDDEN");
    expect(code(() => requireRole(builderUser, "admin"))).toBe("FORBIDDEN");
    expect(code(() => requireRole(admin, "admin"))).toBe("OK");
  });
  it("a homeowner can't reach another homeowner's job (reported as not found)", () => {
    expect(code(() => assertOwnsJob(other, job))).toBe("NOT_FOUND");
    expect(code(() => assertOwnsJob(homeowner, job))).toBe("OK");
    expect(code(() => assertOwnsJob(admin, job))).toBe("OK");
  });
});

describe("claiming jobs", () => {
  it("crews get first refusal; partners wait for the partner window", () => {
    expect(windowOpenFor(crew, job, now)).toBe(true);
    expect(windowOpenFor(partner, job, now)).toBe(false);
    expect(windowOpenFor(partner, { ...job, status: "partner_window" }, now)).toBe(true);
  });
  it("closed windows can't be claimed", () => {
    expect(code(() => assertCanClaim(crew, { ...job, windowEndsAt: now }, now))).toBe("JOB_NOT_AVAILABLE");
  });
  it("unapproved or suspended builders can't claim", () => {
    expect(code(() => assertCanClaim(null, job, now))).toBe("BUILDER_NOT_APPROVED");
    expect(code(() => assertCanClaim({ ...crew, status: "pending" }, job, now))).toBe("BUILDER_NOT_APPROVED");
    expect(code(() => assertCanClaim({ ...crew, status: "suspended" }, job, now))).toBe("BUILDER_NOT_APPROVED");
  });
  it("builders only see jobs in their trades and areas", () => {
    expect(code(() => assertCanClaim({ ...crew, serviceDistricts: ["N1"] }, job, now))).toBe("NOT_FOUND");
    expect(code(() => assertCanClaim({ ...crew, trades: ["roofing"] }, job, now))).toBe("NOT_FOUND");
  });
  it("a job already taken is not available", () => {
    expect(code(() => assertCanClaim(crew, { ...job, status: "offer_pending" }, now))).toBe("JOB_NOT_AVAILABLE");
  });
});

describe("offers", () => {
  const offer = { id: "o1", jobId: "j1", builderId: "b1", status: "pending" as const, expiresAt: later };
  const pendingJob = { ...job, status: "offer_pending" as const };
  it("only the owning homeowner can accept, and not after expiry", () => {
    expect(code(() => assertCanDecideOffer(homeowner, pendingJob, offer, now))).toBe("OK");
    expect(code(() => assertCanDecideOffer(other, pendingJob, offer, now))).toBe("NOT_FOUND");
    expect(code(() => assertCanDecideOffer(admin, pendingJob, offer, now))).toBe("FORBIDDEN");
    expect(code(() => assertCanDecideOffer(homeowner, pendingJob, { ...offer, expiresAt: now }, now))).toBe("OFFER_EXPIRED");
    expect(code(() => assertCanDecideOffer(homeowner, pendingJob, { ...offer, status: "expired" }, now))).toBe("OFFER_EXPIRED");
    expect(code(() => assertCanDecideOffer(homeowner, pendingJob, { ...offer, status: "accepted" }, now))).toBe("INVALID_TRANSITION");
  });
});

describe("contracts and media", () => {
  const contract = { id: "c1", jobId: "j1", builderId: "b1", homeownerId: "h1", status: "active" as const };
  it("only the contracted builder acts on a contract", () => {
    expect(code(() => assertContractBuilder(builderUser, contract))).toBe("OK");
    expect(code(() => assertContractBuilder({ ...builderUser, id: "b9" }, contract))).toBe("NOT_FOUND");
    expect(code(() => assertContractBuilder(builderUser, { ...contract, status: "terminated" }))).toBe("INVALID_TRANSITION");
  });
  it("only admins upload redacted quotes; builders upload nothing", () => {
    expect(code(() => assertCanUploadKind(homeowner, "quote_redacted"))).toBe("FORBIDDEN");
    expect(code(() => assertCanUploadKind(admin, "quote_redacted"))).toBe("OK");
    expect(code(() => assertCanUploadKind(builderUser, "photo"))).toBe("FORBIDDEN");
  });
  it("homeowners can only change media while the job is a draft", () => {
    expect(code(() => assertMediaEditable(homeowner, "draft"))).toBe("OK");
    expect(code(() => assertMediaEditable(homeowner, "submitted"))).toBe("INVALID_TRANSITION");
    expect(code(() => assertMediaEditable(admin, "in_review"))).toBe("OK");
  });
});
