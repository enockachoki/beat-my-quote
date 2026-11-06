import Link from "next/link";
import { loadOr404, requirePageUser } from "@/server/http/pageAuth";
import * as review from "@/server/services/reviewService";
import { config } from "@/server/config";
import { STATUS_LABELS } from "@/server/domain/jobStateMachine";
import { formatGBP } from "@/lib/money";
import { ActionButton } from "@/components/forms/Actions";
import { ReviewDecisionForm } from "@/components/forms/AdminForms";

export const metadata = { title: "Review job" };

export default async function AdminJob({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requirePageUser(["admin"], `/admin/jobs/${jobId}`);
  const d = await loadOr404(() => review.getReviewDetail(user, jobId));
  const { job } = d;
  return (
    <>
      <p><Link href="/admin">← Review queue</Link></p>
      <div className="row between"><h1>{job.title}</h1><span className="badge" data-testid="job-status">{STATUS_LABELS[job.status]}</span></div>
      <div className="grid">
        <div className="card">
          <h2>Homeowner&apos;s details (private)</h2>
          <dl className="facts">
            <dt>Trade</dt><dd>{job.trade}</dd>
            <dt>District</dt><dd>{job.postcodeDistrict}</dd>
            <dt>Quote</dt><dd>{d.quote ? formatGBP(d.quote.quotePricePence) : "–"}</dd>
            <dt>Quoted by</dt><dd>{d.quote?.rivalCompanyName ?? "–"}</dd>
            <dt>Address</dt><dd>{d.address ? `${d.address.line1}, ${d.address.town}, ${d.address.postcode}` : "–"}</dd>
          </dl>
          <p style={{ whiteSpace: "pre-wrap" }}>{job.description}</p>
        </div>
        <div className="card">
          <h2>Uploads</h2>
          <ul>
            {d.media.filter((m) => m.status !== "deleted").map((m) => (
              <li key={m.id}>
                <a href={`/api/media/${m.id}/view?variant=full`} target="_blank" rel="noopener noreferrer">{m.kind}: {m.filename}</a>{" "}
                <span className="badge">{m.status}</span> {m.scanStatus === "infected" ? <span className="badge">MALWARE</span> : null} {m.visibleToBuilders ? <span className="badge">published</span> : null}
                {m.kind === "quote_document" ? <span className="small"> (original, never published; viewing is audited)</span> : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {job.status === "submitted" ? <ActionButton endpoint={`/api/admin/jobs/${job.id}/review`} label="Start review" testId="start-review" /> : null}
      {job.status === "in_review" && d.quote ? <ReviewDecisionForm jobId={job.id} version={job.version} quotePence={d.quote.quotePricePence} media={d.media} minimumPence={config().MINIMUM_JOB_PRICE_PENCE} /> : null}
      {job.standardScope ? <section className="card"><h2>Standard scope</h2><p style={{ whiteSpace: "pre-wrap" }}>{job.standardScope}</p></section> : null}
    </>
  );
}
