import type { Tx } from "../client";
import type { BuilderRow } from "../types";
import { decodeCursor, toPage } from "../pagination";

export async function getBuilder(tx: Tx, id: string): Promise<BuilderRow | null> {
  const [row] = await tx<BuilderRow[]>`select * from public.builders where id = ${id}`;
  return row ?? null;
}

export async function upsertApplication(
  tx: Tx,
  id: string,
  a: { companyName: string; companiesHouseNumber?: string; trades: string[]; serviceDistricts: string[]; insuranceExpiresOn?: string },
): Promise<BuilderRow> {
  const [row] = await tx<BuilderRow[]>`
    insert into public.builders (id, company_name, companies_house_number, trades, service_districts, insurance_expires_on)
    values (${id}, ${a.companyName}, ${a.companiesHouseNumber ?? null}, ${a.trades}, ${a.serviceDistricts}, ${a.insuranceExpiresOn ?? null})
    on conflict (id) do update set company_name = excluded.company_name, companies_house_number = excluded.companies_house_number,
      trades = excluded.trades, service_districts = excluded.service_districts, insurance_expires_on = excluded.insurance_expires_on,
      status = case when public.builders.status = 'rejected' then 'pending'::public.builder_status else public.builders.status end
    returning *`;
  return row!;
}

export async function setDecision(tx: Tx, id: string, status: BuilderRow["status"], kind: BuilderRow["kind"], decidedBy: string): Promise<BuilderRow | null> {
  const [row] = await tx<BuilderRow[]>`
    update public.builders set status = ${status}, kind = coalesce(${kind}::public.builder_kind, kind),
      decided_by = ${decidedBy}, decided_at = now()
    where id = ${id} returning *`;
  return row ?? null;
}

export async function listByStatus(tx: Tx, status: BuilderRow["status"], cursor: string | undefined, limit: number) {
  const c = decodeCursor(cursor);
  const rows = await tx<BuilderRow[]>`
    select * from public.builders where status = ${status}
    ${c ? tx`and (created_at, id) < (${c.createdAt}, ${c.id})` : tx``}
    order by created_at desc, id desc limit ${limit + 1}`;
  return toPage(rows, limit);
}
