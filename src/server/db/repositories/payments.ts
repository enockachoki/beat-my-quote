import type { Tx } from "../client";
import type { PaymentRow } from "../types";

export async function insertPayment(
  tx: Tx,
  p: Pick<PaymentRow, "jobId" | "contractId" | "kind" | "amountPence" | "idempotencyKey">,
): Promise<{ row: PaymentRow; created: boolean }> {
  const inserted = await tx<PaymentRow[]>`
    insert into public.payments (job_id, contract_id, kind, amount_pence, idempotency_key)
    values (${p.jobId}, ${p.contractId}, ${p.kind}, ${p.amountPence}, ${p.idempotencyKey})
    on conflict (idempotency_key) do nothing returning *`;
  if (inserted[0]) return { row: inserted[0], created: true };
  const [existing] = await tx<PaymentRow[]>`select * from public.payments where idempotency_key = ${p.idempotencyKey}`;
  return { row: existing!, created: false };
}

export async function liveDeposit(tx: Tx, contractId: string, opts: { forUpdate?: boolean } = {}): Promise<PaymentRow | null> {
  const rows = opts.forUpdate
    ? await tx<PaymentRow[]>`select * from public.payments where contract_id = ${contractId} and kind = 'deposit' and status in ('created','pending','unknown','succeeded') for update`
    : await tx<PaymentRow[]>`select * from public.payments where contract_id = ${contractId} and kind = 'deposit' and status in ('created','pending','unknown','succeeded')`;
  return rows[0] ?? null;
}

export async function getByProviderSession(tx: Tx, sessionId: string): Promise<PaymentRow | null> {
  const [row] = await tx<PaymentRow[]>`select * from public.payments where provider_session_id = ${sessionId} for update`;
  return row ?? null;
}

export async function getById(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<PaymentRow | null> {
  const rows = opts.forUpdate
    ? await tx<PaymentRow[]>`select * from public.payments where id = ${id} for update`
    : await tx<PaymentRow[]>`select * from public.payments where id = ${id}`;
  return rows[0] ?? null;
}

export async function update(tx: Tx, id: string, fields: Partial<Record<"status" | "provider_session_id" | "provider_payment_intent_id" | "failure_code", unknown>>): Promise<PaymentRow | null> {
  const [row] = await tx<PaymentRow[]>`update public.payments set ${tx(fields as Record<string, never>)} where id = ${id} returning *`;
  return row ?? null;
}

export async function listForJob(tx: Tx, jobId: string): Promise<PaymentRow[]> {
  return tx<PaymentRow[]>`select * from public.payments where job_id = ${jobId} order by created_at limit 100`;
}

export async function unsettled(tx: Tx, olderThanMinutes: number, limit: number): Promise<PaymentRow[]> {
  return tx<PaymentRow[]>`
    select * from public.payments where status in ('created', 'pending', 'unknown')
      and updated_at < now() - make_interval(mins => ${olderThanMinutes})
    order by updated_at limit ${limit} for update skip locked`;
}

/** Returns true the first time an event id is seen; false for duplicates. */
export async function recordEvent(tx: Tx, providerEventId: string, type: string): Promise<boolean> {
  const rows = await tx`
    insert into public.payment_events (provider_event_id, type) values (${providerEventId}, ${type})
    on conflict (provider_event_id) do nothing returning id`;
  return rows.length === 1;
}

export async function markEventProcessed(tx: Tx, providerEventId: string, outcome: string): Promise<void> {
  await tx`update public.payment_events set processed_at = now(), outcome = ${outcome} where provider_event_id = ${providerEventId}`;
}
