import Link from "next/link";
import { requirePageUser } from "@/server/http/pageAuth";
import * as review from "@/server/services/reviewService";
import { JOB_STATUSES, STATUS_LABELS, type JobStatus } from "@/server/domain/jobStateMachine";

export const metadata = { title: "Review queue" };

export default async function AdminHome({ searchParams }: { searchParams: Promise<{ cursor?: string; status?: string }> }) {
  const user = await requirePageUser(["admin"], "/admin");
  const sp = await searchParams;
  const status = JOB_STATUSES.includes(sp.status as JobStatus) ? [sp.status as JobStatus] : (["submitted", "in_review"] as JobStatus[]);
  const page = await review.listQueue(user, status, sp.cursor, 25);
  return (
    <>
      <h1>Review queue</h1>
      <nav className="row" aria-label="Filter by status">
        {(["submitted", "in_review", "crew_window", "partner_window", "offer_pending", "awaiting_deposit", "deposit_paid", "in_progress", "unmatched"] as JobStatus[]).map((s) => (
          <Link key={s} href={`/admin?status=${s}`} className="badge">{STATUS_LABELS[s]}</Link>
        ))}
      </nav>
      <div className="card table-wrap" style={{ marginTop: "1rem" }}>
        {page.items.length === 0 ? <p>Nothing here.</p> : (
          <table><thead><tr><th>Job</th><th>Trade</th><th>Area</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{page.items.map((j) => (
              <tr key={j.id}><td><Link href={`/admin/jobs/${j.id}`}>{j.title}</Link></td><td>{j.trade}</td><td>{j.postcodeDistrict}</td><td>{STATUS_LABELS[j.status]}</td><td>{j.createdAt.toLocaleDateString("en-GB")}</td></tr>
            ))}</tbody></table>
        )}
      </div>
      {page.nextCursor ? <div className="pager"><Link className="btn btn-secondary" href={`/admin?cursor=${encodeURIComponent(page.nextCursor)}${sp.status ? `&status=${sp.status}` : ""}`}>Next page</Link></div> : null}
    </>
  );
}
