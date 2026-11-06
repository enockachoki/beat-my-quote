import Link from "next/link";
import { loadOr404, requirePageUser } from "@/server/http/pageAuth";
import * as builders from "@/server/services/builderService";
import { STATUS_LABELS } from "@/server/domain/jobStateMachine";
import { formatGBP } from "@/lib/money";
import { TRADE_LABELS, type Trade } from "@/lib/schemas";
import { ActionButton, PrestartForm, VariationForm } from "@/components/forms/Actions";
import { Notice } from "@/components/ui";

export const metadata = { title: "Job" };

export default async function BuilderJob({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requirePageUser(["builder"], `/builder/jobs/${jobId}`);
  const d = await loadOr404(() => builders.getBuilderJob(user, jobId));
  const { job } = d;
  const mine = !!d.contract;
  const open = (job.status === "crew_window" || job.status === "partner_window") && !d.offer;
  return (
    <>
      <p><Link href="/builder">← Jobs</Link></p>
      <div className="row between"><h1>{job.title}</h1><span className="badge" data-testid="job-status">{STATUS_LABELS[job.status]}</span></div>
      <div className="card">
        <dl className="facts">
          <dt>Type</dt><dd>{TRADE_LABELS[job.trade as Trade] ?? job.trade}</dd>
          <dt>Area</dt><dd>{job.postcodeDistrict}</dd>
          <dt>Price inc VAT</dt><dd><strong>{formatGBP(d.agreedPricePence ?? job.beatPricePence ?? 0)}</strong></dd>
          {d.address ? <><dt>Address</dt><dd data-testid="job-address">{d.address.line1}{d.address.line2 ? `, ${d.address.line2}` : ""}, {d.address.town}, {d.address.postcode}</dd></> : <><dt>Address</dt><dd>Shared once the homeowner accepts your offer</dd></>}
        </dl>
      </div>
      <section className="card"><h2>Standard scope</h2><p style={{ whiteSpace: "pre-wrap" }}>{job.standardScope}</p></section>
      <section className="card">
        <h2>Photos, video and redacted quote</h2>
        <div className="media-grid">
          {d.media.map((m) => (
            <figure key={m.id}>
              <a href={`/api/media/${m.id}/view?variant=full`} target="_blank" rel="noopener noreferrer">
                {m.hasThumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/media/${m.id}/view?variant=thumb`} alt={m.filename} loading="lazy" />
                ) : <div className="upload-preview" style={{ width: "100%", height: 100 }}><span className="file-badge">{m.mime.split("/")[1]}</span></div>}
              </a>
              <figcaption>{m.filename}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      {open ? (
        <div className="card">
          <h2>Take this job at {formatGBP(job.beatPricePence ?? 0)}</h2>
          <p className="small">The homeowner then has a limited time to accept. The price is fixed; it can only change through a written Variation Form.</p>
          <ActionButton endpoint={`/api/builder/jobs/${job.id}/claim`} label="Take this job" testId="claim-job" />
        </div>
      ) : null}
      {d.offer && !mine ? <Notice>Your offer is {d.offer.status}.</Notice> : null}

      {mine && job.status === "awaiting_deposit" ? <Notice>The homeowner has accepted. Waiting for their deposit.</Notice> : null}
      {mine && job.status === "deposit_paid" ? (
        <>
          {d.prestart ? <Notice kind={d.prestart.outcome === "confirmed" ? "success" : "warning"}>Pre-start check recorded: {d.prestart.outcome === "confirmed" ? "site matches the uploads" : "variation required"}.</Notice> : null}
          <PrestartForm jobId={job.id} />
          <VariationForm jobId={job.id} />
          <ActionButton endpoint={`/api/builder/jobs/${job.id}/start`} label="Start work" testId="start-work" />
        </>
      ) : null}
      {mine && job.status === "in_progress" ? (
        <>
          <VariationForm jobId={job.id} />
          <ActionButton endpoint={`/api/builder/jobs/${job.id}/complete`} label="Mark job complete" />
        </>
      ) : null}
      {mine && d.variations.length > 0 ? (
        <section className="card"><h2>Variations</h2>
          <ul>{d.variations.map((v) => <li key={v.id}>{formatGBP(v.amountPence)}: {v.description} <span className="badge">{v.status}</span></li>)}</ul>
        </section>
      ) : null}
    </>
  );
}
