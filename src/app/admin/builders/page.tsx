import Link from "next/link";
import { requirePageUser } from "@/server/http/pageAuth";
import * as builders from "@/server/services/builderService";
import { BuilderDecisionForm } from "@/components/forms/AdminForms";

export const metadata = { title: "Builders" };
const STATUSES = ["pending", "approved", "rejected", "suspended"] as const;

export default async function AdminBuilders({ searchParams }: { searchParams: Promise<{ status?: string; cursor?: string }> }) {
  const user = await requirePageUser(["admin"], "/admin/builders");
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as (typeof STATUSES)[number]) : "pending";
  const page = await builders.adminListBuilders(user, status, sp.cursor, 20);
  return (
    <>
      <h1>Builders: {status}</h1>
      <nav className="row" aria-label="Filter">{STATUSES.map((s) => <Link key={s} className="badge" href={`/admin/builders?status=${s}`}>{s}</Link>)}</nav>
      {page.items.length === 0 ? <div className="card"><p>None.</p></div> : page.items.map((b) => (
        <div key={b.id} className="card">
          <h2>{b.companyName} {b.kind ? <span className="badge">{b.kind}</span> : null}</h2>
          <p className="small">Trades: {b.trades.join(", ")}. Districts: {b.serviceDistricts.join(", ")}. Companies House: {b.companiesHouseNumber ?? "–"}. Insurance expires: {b.insuranceExpiresOn ?? "not given"}.</p>
          {status === "pending" ? <BuilderDecisionForm builderId={b.id} /> : null}
        </div>
      ))}
      {page.nextCursor ? <div className="pager"><Link className="btn btn-secondary" href={`/admin/builders?status=${status}&cursor=${encodeURIComponent(page.nextCursor)}`}>Next page</Link></div> : null}
    </>
  );
}
