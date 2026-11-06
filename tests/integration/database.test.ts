import { afterAll, describe, expect, it } from "vitest";
import { allTransitions } from "@/server/domain/jobStateMachine";
import { approvedJob, asUser, codeOf, draft, makeUser, readyMedia, sql } from "./helpers";
import * as jobService from "@/server/services/jobService";
import { closeDb } from "@/server/db/client";

afterAll(async () => {
  await closeDb();
});

describe("schema guards", () => {
  it("TypeScript transition map matches the database's transition table exactly", async () => {
    const rows = await sql<{ fromStatus: string; toStatus: string }[]>`select from_status, to_status from public.job_status_transitions`;
    const db = rows.map((r) => `${r.fromStatus}>${r.toStatus}`).sort();
    const ts = allTransitions().map(([a, b]) => `${a}>${b}`).sort();
    expect(ts).toEqual(db);
  });

  it("the database rejects invalid job transitions even from the service role", async () => {
    const h = await makeUser("homeowner");
    const { job } = await jobService.createDraft(h, draft(), "key-invalid-transition");
    expect(await codeOf(sql`update public.jobs set status = 'completed' where id = ${job.id}`)).toBe("P0001");
  });

  it("the audit log is append-only", async () => {
    await sql`insert into public.audit_log (action, entity_type) values ('test', 'test')`;
    expect(await codeOf(sql`update public.audit_log set action = 'tampered'`)).toBe("P0001");
    expect(await codeOf(sql`delete from public.audit_log`)).toBe("P0001");
  });

  it("original quotations can never be marked visible to builders", async () => {
    const h = await makeUser("homeowner");
    const { job } = await jobService.createDraft(h, draft(), "key-quote-visible");
    const id = await readyMedia(job.id, h.id, "quote_document");
    expect(await codeOf(sql`update public.media set visible_to_builders = true where id = ${id}`)).toBe("23514");
  });
});

describe("Row Level Security", () => {
  it("homeowners can't read other homeowners' jobs, addresses, quotes or media", async () => {
    const a = await makeUser("homeowner");
    const b = await makeUser("homeowner");
    const { job } = await jobService.createDraft(a, draft(), "key-rls-a");
    await readyMedia(job.id, a.id, "photo");
    const seen = await asUser(b, async (tx) => ({
      jobs: await tx`select id from public.jobs where id = ${job.id}`,
      addr: await tx`select * from public.job_addresses where job_id = ${job.id}`,
      quote: await tx`select * from public.job_quotes where job_id = ${job.id}`,
      media: await tx`select * from public.media where job_id = ${job.id}`,
    }));
    expect(seen.jobs.length + seen.addr.length + seen.quote.length + seen.media.length).toBe(0);
    const own = await asUser(a, (tx) => tx`select id from public.jobs where id = ${job.id}`);
    expect(own.length).toBe(1);
  });

  it("builders see only jobs in their open window, never the quote, and the address only after acceptance", async () => {
    const { job } = await approvedJob();
    const crew = await makeUser("builder", { kind: "crew" });
    const partner = await makeUser("builder", { kind: "partner" });
    const otherArea = await makeUser("builder", { kind: "crew", districts: ["N1"] });
    const pending = await makeUser("builder", { kind: null });
    const vis = async (u: Awaited<ReturnType<typeof makeUser>>) => asUser(u, async (tx) => ({
      job: (await tx`select id from public.jobs where id = ${job.id}`).length,
      quote: (await tx`select * from public.job_quotes where job_id = ${job.id}`).length,
      addr: (await tx`select * from public.job_addresses where job_id = ${job.id}`).length,
      media: (await tx`select kind from public.media where job_id = ${job.id}`).map((m) => m.kind as string).sort(),
    }));
    expect(await vis(crew)).toEqual({ job: 1, quote: 0, addr: 0, media: ["photo", "quote_redacted"] });
    expect((await vis(partner)).job).toBe(0); // crew first refusal
    expect((await vis(otherArea)).job).toBe(0);
    expect((await vis(pending)).job).toBe(0);
  });

  it("builders can't read other builders' records or offers; only admins read the audit log", async () => {
    const b1 = await makeUser("builder", { kind: "crew" });
    const b2 = await makeUser("builder", { kind: "partner" });
    const h = await makeUser("homeowner");
    const admin = await makeUser("admin");
    expect((await asUser(b1, (tx) => tx`select * from public.builders where id = ${b2.id}`)).length).toBe(0);
    expect((await asUser(b1, (tx) => tx`select * from public.builders`)).length).toBe(1);
    expect((await asUser(h, (tx) => tx`select * from public.audit_log`)).length).toBe(0);
    expect((await asUser(b1, (tx) => tx`select * from public.audit_log`)).length).toBe(0);
    expect((await asUser(admin, (tx) => tx`select * from public.audit_log limit 1`)).length).toBe(1);
  });

  it("browser roles cannot write anything directly (no privilege escalation via the API key)", async () => {
    const h = await makeUser("homeowner");
    expect(await codeOf(asUser(h, (tx) => tx`update public.profiles set role = 'admin' where id = ${h.id}`))).toBe("42501");
    expect(await codeOf(asUser(h, (tx) => tx`insert into public.jobs (homeowner_id, trade, title, postcode_district) values (${h.id}, 'roofing', 'x x x', 'SE15')`))).toBe("42501");
    expect(await codeOf(asUser(h, (tx) => tx`delete from public.audit_log`))).toBe("42501");
    expect(await codeOf(asUser(h, (tx) => tx`select * from public.payment_events`))).toBe("42501");
    expect(await codeOf(asUser(h, (tx) => tx`select * from public.dev_credentials`))).toBe("42501");
  });

  it("anonymous users can read nothing", async () => {
    expect(await codeOf(asUser(null, (tx) => tx`select * from public.jobs`))).toBe("42501");
    expect(await codeOf(asUser(null, (tx) => tx`select * from public.profiles`))).toBe("42501");
  });
});
