import type { Tx } from "../client";
import type { AddressRow, JobRow, QuoteRow } from "../types";
import type { JobStatus } from "../../domain/jobStateMachine";
import { decodeCursor, toPage } from "../pagination";
import type { JobDraft } from "@/lib/schemas";
import { postcodeDistrict } from "@/lib/schemas";

const JOB_COLS = "j.id, j.homeowner_id, j.status, j.trade, j.title, j.description, j.postcode_district, j.standard_scope, j.beat_percent, j.beat_price_pence, j.current_window, j.window_ends_at, j.submission_key, j.submitted_at, j.reviewed_by, j.reviewed_at, j.rejection_reason, j.version, j.created_at, j.updated_at";

export async function insertDraft(tx: Tx, homeownerId: string, draft: JobDraft, submissionKey: string): Promise<{ job: JobRow; created: boolean }> {
  const district = postcodeDistrict(draft.address.postcode)!;
  const inserted = await tx<JobRow[]>`
    insert into public.jobs (homeowner_id, trade, title, description, postcode_district, submission_key)
    values (${homeownerId}, ${draft.trade}, ${draft.title}, ${draft.description}, ${district}, ${submissionKey})
    on conflict on constraint jobs_submission_key_unique do nothing
    returning *`;
  if (inserted.length === 0) {
    const [existing] = await tx<JobRow[]>`select * from public.jobs where homeowner_id = ${homeownerId} and submission_key = ${submissionKey}`;
    return { job: existing!, created: false };
  }
  const job = inserted[0]!;
  await upsertPrivate(tx, job.id, draft);
  return { job, created: true };
}

export async function upsertPrivate(tx: Tx, jobId: string, draft: JobDraft): Promise<void> {
  await tx`
    insert into public.job_addresses (job_id, line1, line2, town, postcode)
    values (${jobId}, ${draft.address.line1}, ${draft.address.line2 || null}, ${draft.address.town}, ${draft.address.postcode})
    on conflict (job_id) do update set line1 = excluded.line1, line2 = excluded.line2, town = excluded.town, postcode = excluded.postcode`;
  await tx`
    insert into public.job_quotes (job_id, quote_price_pence, rival_company_name, quote_date)
    values (${jobId}, ${draft.quote.pricePounds}, ${draft.quote.rivalCompanyName || null}, ${draft.quote.quoteDate ?? null})
    on conflict (job_id) do update set quote_price_pence = excluded.quote_price_pence,
      rival_company_name = excluded.rival_company_name, quote_date = excluded.quote_date`;
}

export async function updateDraft(tx: Tx, jobId: string, draft: JobDraft): Promise<JobRow> {
  const [job] = await tx<JobRow[]>`
    update public.jobs set trade = ${draft.trade}, title = ${draft.title}, description = ${draft.description},
      postcode_district = ${postcodeDistrict(draft.address.postcode)!}
    where id = ${jobId} and status = 'draft' returning *`;
  await upsertPrivate(tx, jobId, draft);
  return job!;
}

export async function getJob(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<JobRow | null> {
  const rows = opts.forUpdate
    ? await tx<JobRow[]>`select * from public.jobs where id = ${id} for update`
    : await tx<JobRow[]>`select * from public.jobs where id = ${id}`;
  return rows[0] ?? null;
}

export async function getAddress(tx: Tx, jobId: string): Promise<AddressRow | null> {
  const [row] = await tx<AddressRow[]>`select * from public.job_addresses where job_id = ${jobId}`;
  return row ?? null;
}

export async function getQuote(tx: Tx, jobId: string): Promise<QuoteRow | null> {
  const [row] = await tx<QuoteRow[]>`select * from public.job_quotes where job_id = ${jobId}`;
  return row ?? null;
}

/** Compare-and-set status change; returns null when the job wasn't in `from`. */
export async function transition(
  tx: Tx,
  jobId: string,
  from: JobStatus | readonly JobStatus[],
  to: JobStatus,
  extra: Partial<Record<"standard_scope" | "beat_percent" | "beat_price_pence" | "current_window" | "window_ends_at" | "submitted_at" | "reviewed_by" | "reviewed_at" | "rejection_reason", unknown>> = {},
): Promise<JobRow | null> {
  const fromList = (Array.isArray(from) ? from : [from]) as string[];
  const sets = { status: to, ...extra };
  const [row] = await tx<JobRow[]>`
    update public.jobs set ${tx(sets as unknown as Record<string, never>)}
    where id = ${jobId} and status = any(${fromList}::public.job_status[])
    returning *`;
  return row ?? null;
}

export async function listForHomeowner(tx: Tx, homeownerId: string, cursor: string | undefined, limit: number) {
  const c = decodeCursor(cursor);
  const rows = await tx<JobRow[]>`
    select * from public.jobs where homeowner_id = ${homeownerId}
    ${c ? tx`and (created_at, id) < (${c.createdAt}, ${c.id})` : tx``}
    order by created_at desc, id desc limit ${limit + 1}`;
  return toPage(rows, limit);
}

export async function listByStatus(tx: Tx, statuses: JobStatus[], cursor: string | undefined, limit: number) {
  const c = decodeCursor(cursor);
  const rows = await tx<JobRow[]>`
    select * from public.jobs where status = any(${statuses as string[]}::public.job_status[])
    ${c ? tx`and (created_at, id) < (${c.createdAt}, ${c.id})` : tx``}
    order by created_at desc, id desc limit ${limit + 1}`;
  return toPage(rows, limit);
}

export async function listAvailableForBuilder(
  tx: Tx,
  builder: { kind: "crew" | "partner"; trades: string[]; serviceDistricts: string[] },
  cursor: string | undefined,
  limit: number,
) {
  const c = decodeCursor(cursor);
  const statuses = builder.kind === "crew" ? ["crew_window", "partner_window"] : ["partner_window"];
  const rows = await tx<JobRow[]>`
    select * from public.jobs
    where status = any(${statuses}::public.job_status[])
      and window_ends_at > now()
      and trade = any(${builder.trades}) and postcode_district = any(${builder.serviceDistricts})
    ${c ? tx`and (created_at, id) < (${c.createdAt}, ${c.id})` : tx``}
    order by created_at desc, id desc limit ${limit + 1}`;
  return toPage(rows, limit);
}

export async function windowsDue(tx: Tx, limit = 100): Promise<JobRow[]> {
  return tx<JobRow[]>`
    select * from public.jobs where status in ('crew_window', 'partner_window') and window_ends_at <= now()
    order by window_ends_at limit ${limit} for update skip locked`;
}

export { JOB_COLS };
