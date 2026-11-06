import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { SessionUser } from "@/server/authz/policies";
import * as jobService from "@/server/services/jobService";
import * as reviewService from "@/server/services/reviewService";
import type { JobDraft } from "@/lib/schemas";
import { jobDraftSchema } from "@/lib/schemas";

export const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {}, transform: postgres.camel });

export async function makeUser(role: "homeowner" | "builder" | "admin", builder?: { kind: "crew" | "partner" | null; status?: "approved" | "pending" | "suspended" | "rejected"; trades?: string[]; districts?: string[] }): Promise<SessionUser> {
  const email = `${role}-${randomUUID().slice(0, 8)}@bmq.test`;
  const [u] = await sql<{ id: string }[]>`insert into auth.users (email) values (${email}) returning id`;
  await sql`insert into public.profiles (id, role, full_name) values (${u!.id}, ${role}, ${"Test " + role})`;
  if (builder) {
    await sql`insert into public.builders (id, kind, status, company_name, trades, service_districts)
      values (${u!.id}, ${builder.kind}, ${builder.status ?? (builder.kind ? "approved" : "pending")}, ${"Co " + email}, ${builder.trades ?? ["bathroom-refit"]}, ${builder.districts ?? ["SE15"]})`;
  }
  return { id: u!.id, role, email };
}

export function draft(overrides: Partial<Record<string, unknown>> = {}): JobDraft {
  return jobDraftSchema.parse({
    trade: "bathroom-refit", title: "Bathroom refit", description: "First floor bathroom",
    address: { line1: "1 Secret Street", town: "London", postcode: "SE15 4AA" },
    quote: { pricePounds: "8640", rivalCompanyName: "Rival Bathrooms Ltd" },
    ...overrides,
  });
}

/** Inserts a media row that has already passed the pipeline (no storage involved). */
export async function readyMedia(jobId: string, uploadedBy: string, kind: "photo" | "video" | "quote_document" | "quote_redacted", mime = kind === "photo" ? "image/jpeg" : kind === "video" ? "video/mp4" : "application/pdf") {
  const id = randomUUID();
  await sql`insert into public.media (id, job_id, uploaded_by, kind, status, client_fingerprint, original_filename, declared_mime, detected_mime, size_bytes, storage_path, processed_path, thumbnail_path, metadata_stripped, upload_expires_at, scan_status)
    values (${id}, ${jobId}, ${uploadedBy}, ${kind}, 'ready', ${"fp-" + id}, ${kind + ".bin"}, ${mime}, ${mime}, 1000, ${`jobs/${jobId}/${id}.bin`}, ${`jobs/${jobId}/${id}.clean.bin`}, ${`jobs/${jobId}/${id}.thumb.webp`}, true, now() + interval '1 hour', 'clean')`;
  return id;
}

/** A job taken all the way to the crew window. */
export async function approvedJob(opts: { homeowner?: SessionUser; admin?: SessionUser; trade?: string; quotePounds?: string } = {}) {
  const homeowner = opts.homeowner ?? (await makeUser("homeowner"));
  const admin = opts.admin ?? (await makeUser("admin"));
  const { job } = await jobService.createDraft(homeowner, draft({ trade: opts.trade ?? "bathroom-refit", quote: { pricePounds: opts.quotePounds ?? "8640" } }), randomUUID().replace(/-/g, ""));
  await readyMedia(job.id, homeowner.id, "quote_document");
  const photo = await readyMedia(job.id, homeowner.id, "photo");
  await jobService.submitJob(homeowner, job.id);
  const inReview = await reviewService.startReview(admin, job.id);
  const redacted = await readyMedia(job.id, admin.id, "quote_redacted");
  const approved = await reviewService.decide(admin, job.id, {
    decision: "approve", standardScope: "Strip out and refit bathroom with supplied suite, tiling 14m2.", beatBasisPoints: 800,
    publishMediaIds: [photo, redacted], expectedVersion: inReview.version,
  });
  return { homeowner, admin, job: approved, photo, redacted };
}

/** Runs a query as a given user under RLS, as Supabase's API would. */
export async function asUser<T>(user: SessionUser | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (user) {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user.id, role: "authenticated" })}, true)`;
      await tx`set local role authenticated`;
    } else {
      await tx`set local role anon`;
    }
    return fn(tx);
  }) as Promise<T>;
}

export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}
