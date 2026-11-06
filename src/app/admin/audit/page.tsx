import Link from "next/link";
import { requirePageUser } from "@/server/http/pageAuth";
import { withServiceTx } from "@/server/db/client";

export const metadata = { title: "Audit log" };

interface Row { id: number; at: Date; actorRole: string | null; action: string; entityType: string; entityId: string | null; correlationId: string | null }

export default async function Audit({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  await requirePageUser(["admin"], "/admin/audit");
  const sp = await searchParams;
  const before = Number(sp.before);
  const rows = await withServiceTx((tx) => tx<Row[]>`
    select id, at, actor_role, action, entity_type, entity_id, correlation_id from public.audit_log
    ${Number.isSafeInteger(before) && before > 0 ? tx`where id < ${before}` : tx``} order by id desc limit 50`);
  return (
    <>
      <h1>Audit log</h1>
      <div className="card table-wrap">
        <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Request</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td>{r.at.toLocaleString("en-GB")}</td><td>{r.actorRole}</td><td>{r.action}</td><td>{r.entityType} {r.entityId?.slice(0, 8)}</td><td className="small">{r.correlationId?.slice(0, 8)}</td></tr>
          ))}</tbody></table>
      </div>
      {rows.length === 50 ? <div className="pager"><Link className="btn btn-secondary" href={`/admin/audit?before=${rows[49]!.id}`}>Older</Link></div> : null}
    </>
  );
}
