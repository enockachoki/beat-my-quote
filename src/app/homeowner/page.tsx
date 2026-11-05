import Link from "next/link";
import { requirePageUser } from "@/server/http/pageAuth";
import * as jobs from "@/server/services/jobService";
import { STATUS_LABELS } from "@/server/domain/jobStateMachine";
import { formatGBP } from "@/lib/money";
import { TRADE_LABELS, type Trade } from "@/lib/schemas";

export const metadata = { title: "My jobs" };

export default async function HomeownerHome({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const user = await requirePageUser(["homeowner"], "/homeowner");
  const { cursor } = await searchParams;
  const page = await jobs.listMyJobs(user, cursor, 20);
  return (
    <>
      <div className="row between">
        <h1>My jobs</h1>
        <Link className="btn btn-primary" href="/homeowner/jobs/new">Upload a new quote</Link>
      </div>
      {page.items.length === 0 ? (
        <div className="card"><p>You haven&apos;t uploaded a quote yet.</p><Link href="/homeowner/jobs/new">Upload your first quote</Link></div>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Beat price</th></tr></thead>
            <tbody>
              {page.items.map((j) => (
                <tr key={j.id}>
                  <td><Link href={`/homeowner/jobs/${j.id}`}>{j.title}</Link></td>
                  <td>{TRADE_LABELS[j.trade as Trade] ?? j.trade}</td>
                  <td><span className="badge">{STATUS_LABELS[j.status]}</span></td>
                  <td>{j.beatPricePence ? formatGBP(j.beatPricePence) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor ? <div className="pager"><Link className="btn btn-secondary" href={`/homeowner?cursor=${encodeURIComponent(page.nextCursor)}`}>Older jobs</Link></div> : null}
    </>
  );
}
