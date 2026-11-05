import type { Tx } from "../client";
import type { ContractRow, OfferRow, VariationRow } from "../types";
import { decodeCursor, toPage } from "../pagination";

export async function insertOffer(tx: Tx, o: { jobId: string; builderId: string; viaWindow: "crew" | "partner"; pricePence: number; expiresAt: Date }): Promise<OfferRow> {
  const [row] = await tx<OfferRow[]>`
    insert into public.offers (job_id, builder_id, via_window, price_pence, expires_at)
    values (${o.jobId}, ${o.builderId}, ${o.viaWindow}, ${o.pricePence}, ${o.expiresAt}) returning *`;
  return row!;
}

export async function getOffer(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<OfferRow | null> {
  const rows = opts.forUpdate
    ? await tx<OfferRow[]>`select * from public.offers where id = ${id} for update`
    : await tx<OfferRow[]>`select * from public.offers where id = ${id}`;
  return rows[0] ?? null;
}

export async function liveOfferForJob(tx: Tx, jobId: string): Promise<OfferRow | null> {
  const [row] = await tx<OfferRow[]>`select * from public.offers where job_id = ${jobId} and status in ('pending', 'accepted')`;
  return row ?? null;
}

export async function setOfferStatus(tx: Tx, id: string, from: OfferRow["status"], to: OfferRow["status"]): Promise<OfferRow | null> {
  const [row] = await tx<OfferRow[]>`
    update public.offers set status = ${to}, decided_at = now() where id = ${id} and status = ${from} returning *`;
  return row ?? null;
}

export async function listForBuilder(tx: Tx, builderId: string, cursor: string | undefined, limit: number) {
  const c = decodeCursor(cursor);
  const rows = await tx<(OfferRow & { title: string; jobStatus: string })[]>`
    select o.*, j.title, j.status as job_status from public.offers o join public.jobs j on j.id = o.job_id
    where o.builder_id = ${builderId}
    ${c ? tx`and (o.created_at, o.id) < (${c.createdAt}, ${c.id})` : tx``}
    order by o.created_at desc, o.id desc limit ${limit + 1}`;
  return toPage(rows, limit);
}

export async function expiredPendingOffers(tx: Tx, limit = 100): Promise<OfferRow[]> {
  return tx<OfferRow[]>`
    select * from public.offers where status = 'pending' and expires_at <= now()
    order by expires_at limit ${limit} for update skip locked`;
}

export async function insertContract(tx: Tx, c: Omit<ContractRow, "id" | "status" | "homeownerAcceptedAt" | "terminatedReason">): Promise<ContractRow> {
  const [row] = await tx<ContractRow[]>`
    insert into public.contracts (job_id, offer_id, homeowner_id, builder_id, price_pence, deposit_pence, terms_version)
    values (${c.jobId}, ${c.offerId}, ${c.homeownerId}, ${c.builderId}, ${c.pricePence}, ${c.depositPence}, ${c.termsVersion})
    returning *`;
  return row!;
}

export async function contractForJob(tx: Tx, jobId: string, opts: { forUpdate?: boolean } = {}): Promise<ContractRow | null> {
  const rows = opts.forUpdate
    ? await tx<ContractRow[]>`select * from public.contracts where job_id = ${jobId} for update`
    : await tx<ContractRow[]>`select * from public.contracts where job_id = ${jobId}`;
  return rows[0] ?? null;
}

export async function terminateContract(tx: Tx, id: string, reason: string): Promise<void> {
  await tx`update public.contracts set status = 'terminated', terminated_reason = ${reason} where id = ${id} and status = 'active'`;
}

export async function completeContract(tx: Tx, id: string): Promise<void> {
  await tx`update public.contracts set status = 'completed' where id = ${id} and status = 'active'`;
}

export async function insertPrestart(tx: Tx, jobId: string, builderId: string, outcome: string, notes: string | null): Promise<void> {
  await tx`insert into public.prestart_checks (job_id, builder_id, outcome, notes) values (${jobId}, ${builderId}, ${outcome}, ${notes})`;
}

export async function latestPrestart(tx: Tx, jobId: string): Promise<{ outcome: string; checkedAt: Date; notes: string | null } | null> {
  const [row] = await tx<{ outcome: string; checkedAt: Date; notes: string | null }[]>`
    select outcome, checked_at, notes from public.prestart_checks where job_id = ${jobId} order by checked_at desc limit 1`;
  return row ?? null;
}

export async function insertVariation(tx: Tx, v: Pick<VariationRow, "jobId" | "contractId" | "proposedBy" | "reason" | "description" | "amountPence">): Promise<VariationRow> {
  const [row] = await tx<VariationRow[]>`
    insert into public.variations (job_id, contract_id, proposed_by, reason, description, amount_pence)
    values (${v.jobId}, ${v.contractId}, ${v.proposedBy}, ${v.reason}, ${v.description}, ${v.amountPence}) returning *`;
  return row!;
}

export async function getVariation(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<VariationRow | null> {
  const rows = opts.forUpdate
    ? await tx<VariationRow[]>`select * from public.variations where id = ${id} for update`
    : await tx<VariationRow[]>`select * from public.variations where id = ${id}`;
  return rows[0] ?? null;
}

export async function variationsForJob(tx: Tx, jobId: string): Promise<VariationRow[]> {
  return tx<VariationRow[]>`select * from public.variations where job_id = ${jobId} order by created_at desc limit 100`;
}

export async function decideVariation(tx: Tx, id: string, status: "approved" | "declined", by: string): Promise<VariationRow | null> {
  const [row] = await tx<VariationRow[]>`
    update public.variations set status = ${status}, decided_by = ${by}, decided_at = now()
    where id = ${id} and status = 'proposed' returning *`;
  return row ?? null;
}

export async function agreedPrice(tx: Tx, jobId: string): Promise<number | null> {
  const [row] = await tx<{ price: number | null }[]>`select public.job_agreed_price_pence(${jobId}) as price`;
  return row?.price ?? null;
}
