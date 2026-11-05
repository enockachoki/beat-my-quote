import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as jobService from "@/server/services/jobService";
import * as reviewService from "@/server/services/reviewService";
import * as offerService from "@/server/services/offerService";
import * as builderService from "@/server/services/builderService";
import * as workflow from "@/server/services/workflowService";
import { closeDb } from "@/server/db/client";
import { approvedJob, codeOf, draft, makeUser, readyMedia, sql } from "./helpers";

afterAll(async () => {
  await closeDb();
});

describe("job submission", () => {
  it("creating a draft is idempotent on the submission key", async () => {
    const h = await makeUser("homeowner");
    const key = randomUUID().replace(/-/g, "");
    const [a, b] = await Promise.all([jobService.createDraft(h, draft(), key), jobService.createDraft(h, draft(), key)]);
    expect(a.job.id).toBe(b.job.id);
    expect([a.created, b.created].filter(Boolean).length).toBe(1);
  });
  it("requires a quote and a photo, and repeat submits are harmless", async () => {
    const h = await makeUser("homeowner");
    const { job } = await jobService.createDraft(h, draft(), "key-submit-1");
    expect(await codeOf(jobService.submitJob(h, job.id))).toBe("SUBMISSION_INCOMPLETE");
    await readyMedia(job.id, h.id, "quote_document");
    expect(await codeOf(jobService.submitJob(h, job.id))).toBe("SUBMISSION_INCOMPLETE");
    await readyMedia(job.id, h.id, "photo");
    expect((await jobService.submitJob(h, job.id)).status).toBe("submitted");
    expect((await jobService.submitJob(h, job.id)).status).toBe("submitted");
  });
  it("other users and roles can't submit, edit or view someone's job", async () => {
    const h = await makeUser("homeowner");
    const other = await makeUser("homeowner");
    const builder = await makeUser("builder", { kind: "crew" });
    const { job } = await jobService.createDraft(h, draft(), "key-submit-2");
    expect(await codeOf(jobService.submitJob(other, job.id))).toBe("NOT_FOUND");
    expect(await codeOf(jobService.getHomeownerJob(other, job.id))).toBe("NOT_FOUND");
    expect(await codeOf(jobService.updateDraft(other, job.id, draft()))).toBe("NOT_FOUND");
    expect(await codeOf(jobService.getHomeownerJob(builder, job.id))).toBe("FORBIDDEN");
  });
});

describe("admin review", () => {
  it("only admins can review; homeowners and builders are refused", async () => {
    const h = await makeUser("homeowner");
    const { job } = await jobService.createDraft(h, draft(), "key-review-1");
    expect(await codeOf(reviewService.startReview(h, job.id))).toBe("FORBIDDEN");
    expect(await codeOf(reviewService.listQueue(await makeUser("builder", { kind: "crew" }), ["submitted"], undefined, 10))).toBe("FORBIDDEN");
  });
  it("won't publish the original quote, requires a redacted copy, and sets the beat price", async () => {
    const h = await makeUser("homeowner");
    const admin = await makeUser("admin");
    const { job } = await jobService.createDraft(h, draft(), "key-review-2");
    const original = await readyMedia(job.id, h.id, "quote_document");
    const photo = await readyMedia(job.id, h.id, "photo");
    await jobService.submitJob(h, job.id);
    const r = await reviewService.startReview(admin, job.id);
    const base = { decision: "approve" as const, standardScope: "A standard scope of at least twenty chars", beatBasisPoints: 800, expectedVersion: r.version };
    expect(await codeOf(reviewService.decide(admin, job.id, { ...base, publishMediaIds: [original, photo] }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(reviewService.decide(admin, job.id, { ...base, publishMediaIds: [photo] }))).toBe("VALIDATION_FAILED");
    expect(await codeOf(reviewService.decide(admin, job.id, { ...base, expectedVersion: r.version - 1, publishMediaIds: [photo] }))).toBe("CONFLICT");
    const redacted = await readyMedia(job.id, admin.id, "quote_redacted");
    const approved = await reviewService.decide(admin, job.id, { ...base, publishMediaIds: [photo, redacted] });
    expect(approved.status).toBe("crew_window");
    expect(approved.beatPricePence).toBe(794_800);
    const [orig] = await sql<{ visibleToBuilders: boolean }[]>`select visible_to_builders from public.media where id = ${original}`;
    expect(orig!.visibleToBuilders).toBe(false);
    const notes = await sql`select template from public.notifications where user_id = ${h.id}`;
    expect(notes.map((n) => n.template)).toContain("job_approved");
  });
});

describe("claiming and offers", () => {
  it("exactly one of many builders claiming at once wins", async () => {
    const { job } = await approvedJob();
    const crews = await Promise.all(Array.from({ length: 8 }, () => makeUser("builder", { kind: "crew" })));
    const results = await Promise.all(crews.map((c) => codeOf(offerService.claimJob(c, job.id))));
    expect(results.filter((r) => r === "OK").length).toBe(1);
    expect(results.filter((r) => r === "JOB_NOT_AVAILABLE").length).toBe(7);
    const live = await sql`select * from public.offers where job_id = ${job.id} and status in ('pending','accepted')`;
    expect(live.length).toBe(1);
  });
  it("the same builder retrying gets the same offer (idempotent)", async () => {
    const { job } = await approvedJob();
    const crew = await makeUser("builder", { kind: "crew" });
    const [a, b] = [await offerService.claimJob(crew, job.id), await offerService.claimJob(crew, job.id)];
    expect(a.id).toBe(b.id);
  });
  it("partners, unapproved and suspended builders can't take a job in the crew window", async () => {
    const { job } = await approvedJob();
    expect(await codeOf(offerService.claimJob(await makeUser("builder", { kind: "partner" }), job.id))).toBe("JOB_NOT_AVAILABLE");
    expect(await codeOf(offerService.claimJob(await makeUser("builder", { kind: null }), job.id))).toBe("BUILDER_NOT_APPROVED");
    expect(await codeOf(offerService.claimJob(await makeUser("builder", { kind: "crew", status: "suspended" }), job.id))).toBe("BUILDER_NOT_APPROVED");
    expect(await codeOf(offerService.claimJob(await makeUser("homeowner"), job.id))).toBe("FORBIDDEN");
  });
  it("crew window expiry passes the job to partners, then to unmatched", async () => {
    const { job } = await approvedJob();
    await sql`update public.jobs set window_ends_at = now() - interval '1 minute' where id = ${job.id}`;
    await offerService.advanceWindows();
    const [j1] = await sql<{ status: string }[]>`select status from public.jobs where id = ${job.id}`;
    expect(j1!.status).toBe("partner_window");
    const partner = await makeUser("builder", { kind: "partner" });
    expect((await builderService.getBuilderJob(partner, job.id)).job.id).toBe(job.id);
    await sql`update public.jobs set window_ends_at = now() - interval '1 minute' where id = ${job.id}`;
    await offerService.advanceWindows();
    const [j2] = await sql<{ status: string }[]>`select status from public.jobs where id = ${job.id}`;
    expect(j2!.status).toBe("unmatched");
  });
  it("a homeowner can't accept an expired offer, and expiry reopens the job", async () => {
    const { job, homeowner } = await approvedJob();
    const crew = await makeUser("builder", { kind: "crew" });
    const offer = await offerService.claimJob(crew, job.id);
    await sql`update public.offers set expires_at = now() - interval '1 second' where id = ${offer.id}`;
    expect(await codeOf(offerService.decideOffer(homeowner, offer.id, "accept", "draft-2026-11"))).toBe("OFFER_EXPIRED");
    await offerService.expireOffers();
    const [j] = await sql<{ status: string }[]>`select status from public.jobs where id = ${job.id}`;
    expect(j!.status).toBe("crew_window");
  });
  it("accepting creates a contract, reveals the address to that builder only, and can't happen twice", async () => {
    const { job, homeowner } = await approvedJob();
    const crew = await makeUser("builder", { kind: "crew" });
    const rival = await makeUser("builder", { kind: "crew" });
    const offer = await offerService.claimJob(crew, job.id);
    expect((await builderService.getBuilderJob(crew, job.id)).address).toBeNull();
    expect(await codeOf(offerService.decideOffer(await makeUser("homeowner"), offer.id, "accept", "draft-2026-11"))).toBe("NOT_FOUND");
    expect(await codeOf(offerService.decideOffer(homeowner, offer.id, "accept", "old-terms"))).toBe("CONFLICT");
    const r = await offerService.decideOffer(homeowner, offer.id, "accept", "draft-2026-11");
    expect(r.contract!.pricePence).toBe(794_800);
    expect(r.contract!.depositPence).toBe(79_480);
    expect((await builderService.getBuilderJob(crew, job.id)).address?.line1).toBe("1 Secret Street");
    expect(await codeOf(builderService.getBuilderJob(rival, job.id))).toBe("NOT_FOUND");
    expect(await codeOf(offerService.decideOffer(homeowner, offer.id, "accept", "draft-2026-11"))).toBe("INVALID_TRANSITION");
  });
});

describe("pre-start, variations and starting work", () => {
  async function paidJob() {
    const ctx = await approvedJob();
    const crew = await makeUser("builder", { kind: "crew" });
    const offer = await offerService.claimJob(crew, ctx.job.id);
    const { contract } = await offerService.decideOffer(ctx.homeowner, offer.id, "accept", "draft-2026-11");
    await sql`insert into public.payments (job_id, contract_id, kind, amount_pence, status, idempotency_key, provider_payment_intent_id)
      values (${ctx.job.id}, ${contract!.id}, 'deposit', ${contract!.depositPence}, 'succeeded', ${"dep-" + contract!.id}, ${"pi_test_" + contract!.id.slice(0, 8)})`;
    await sql`update public.jobs set status = 'deposit_paid' where id = ${ctx.job.id}`;
    return { ...ctx, crew, contract: contract! };
  }

  it("work can't start without a confirmed pre-start check, enforced by the database too", async () => {
    const { job, crew } = await paidJob();
    expect(await codeOf(workflow.startWork(crew, job.id))).toBe("START_CONDITIONS_UNMET");
    expect(await codeOf(sql`update public.jobs set status = 'in_progress' where id = ${job.id}`)).toBe("P0001");
    await workflow.recordPrestart(crew, job.id, "confirmed");
    expect((await workflow.startWork(crew, job.id)).status).toBe("in_progress");
  });
  it("only the contracted builder can mark started work complete, and only once", async () => {
    const { job, crew } = await paidJob();
    await workflow.recordPrestart(crew, job.id, "confirmed");
    expect(await codeOf(workflow.completeWork(crew, job.id))).toBe("INVALID_TRANSITION"); // not started yet
    await workflow.startWork(crew, job.id);
    const other = await makeUser("builder", { kind: "crew" });
    expect(await codeOf(workflow.completeWork(other, job.id))).toBe("NOT_FOUND"); // existence not revealed
    expect((await workflow.completeWork(crew, job.id)).status).toBe("completed");
    expect(await codeOf(workflow.completeWork(crew, job.id))).toBe("INVALID_TRANSITION");
  });
  it("work can't start while a variation is waiting for a decision", async () => {
    const { job, crew } = await paidJob();
    await workflow.recordPrestart(crew, job.id, "confirmed");
    await workflow.proposeVariation(crew, job.id, { reason: "homeowner_requested", description: "Add a heated towel rail", amountPounds: 25_000 });
    expect(await codeOf(workflow.startWork(crew, job.id))).toBe("START_CONDITIONS_UNMET");
  });
  it("only an approved variation changes the agreed price; contract price itself is immutable", async () => {
    const { job, crew, homeowner, contract } = await paidJob();
    const v = await workflow.proposeVariation(crew, job.id, { reason: "homeowner_requested", description: "Add a heated towel rail", amountPounds: 25_000 });
    expect(await codeOf(workflow.proposeVariation(crew, job.id, { reason: "homeowner_requested", description: "Another change here", amountPounds: 100 }))).toBe("CONFLICT");
    expect(await codeOf(workflow.decideVariation(await makeUser("homeowner"), v.id, "approve"))).toBe("NOT_FOUND");
    expect(await codeOf(workflow.decideVariation(crew, v.id, "approve"))).toBe("FORBIDDEN");
    const r = await workflow.decideVariation(homeowner, v.id, "approve");
    expect(r.agreedPricePence).toBe(794_800 + 25_000);
    expect(await codeOf(sql`update public.contracts set price_pence = 1 where id = ${contract.id}`)).toBe("P0001");
  });
  it("declining a hidden-problem variation ends the contract and queues a full deposit refund", async () => {
    const { job, crew, homeowner, contract } = await paidJob();
    const v = await workflow.proposeVariation(crew, job.id, { reason: "not_reasonably_visible", description: "Rotten joists under floor", amountPounds: 90_000 });
    const r = await workflow.decideVariation(homeowner, v.id, "decline");
    expect(r.terminated).toBe(true);
    const [j] = await sql<{ status: string }[]>`select status from public.jobs where id = ${job.id}`;
    expect(j!.status).toBe("cancelled");
    const refunds = await sql<{ amountPence: number; status: string }[]>`select amount_pence, status from public.payments where contract_id = ${contract.id} and kind = 'refund'`;
    expect(refunds).toEqual([{ amountPence: contract.depositPence, status: "created" }]);
  });
  it("other builders can't record checks, propose variations or start someone else's job", async () => {
    const { job } = await paidJob();
    const intruder = await makeUser("builder", { kind: "crew" });
    expect(await codeOf(workflow.recordPrestart(intruder, job.id, "confirmed"))).toBe("NOT_FOUND");
    expect(await codeOf(workflow.proposeVariation(intruder, job.id, { reason: "homeowner_requested", description: "Sneaky extra charge", amountPounds: 100_000 }))).toBe("NOT_FOUND");
    expect(await codeOf(workflow.startWork(intruder, job.id))).toBe("NOT_FOUND");
  });
});
