import Link from "next/link";
import { loadOr404, requirePageUser } from "@/server/http/pageAuth";
import * as jobs from "@/server/services/jobService";
import { config } from "@/server/config";
import { STATUS_LABELS } from "@/server/domain/jobStateMachine";
import { formatGBP } from "@/lib/money";
import { TRADE_LABELS, type Trade } from "@/lib/schemas";
import { DraftUploads, EditDraftForm } from "@/components/forms/JobForms";
import { ActionButton, DepositButton, OfferDecision, VariationDecision } from "@/components/forms/Actions";
import { Notice } from "@/components/ui";

export const metadata = { title: "Your job" };

export default async function HomeownerJob({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const user = await requirePageUser(["homeowner"], `/homeowner/jobs/${jobId}`);
  const d = await loadOr404(() => jobs.getHomeownerJob(user, jobId));
  const { job } = d;
  const cfg = config();
  const cancellable = ["draft", "submitted", "crew_window", "partner_window", "offer_pending", "awaiting_deposit"].includes(job.status);

  return (
    <>
      <p><Link href="/homeowner">← My jobs</Link></p>
      <div className="row between">
        <h1>{job.title}</h1>
        <span className="badge" data-testid="job-status">{STATUS_LABELS[job.status]}</span>
      </div>
      <div className="card">
        <dl className="facts">
          <dt>Type</dt><dd>{TRADE_LABELS[job.trade as Trade] ?? job.trade}</dd>
          <dt>Area</dt><dd>{job.postcodeDistrict}</dd>
          <dt>Your quote</dt><dd>{d.quote ? formatGBP(d.quote.quotePricePence) : "–"}</dd>
          {job.beatPricePence ? <><dt>Beat price</dt><dd><strong>{formatGBP(job.beatPricePence)}</strong></dd></> : null}
          {d.agreedPricePence ? <><dt>Agreed price</dt><dd><strong data-testid="agreed-price">{formatGBP(d.agreedPricePence)}</strong></dd></> : null}
        </dl>
      </div>

      {job.status === "draft" && d.address && d.quote ? (
        <>
          <EditDraftForm jobId={job.id} initial={{
            trade: job.trade, title: job.title, description: job.description, line1: d.address.line1, line2: d.address.line2 ?? "",
            town: d.address.town, postcode: d.address.postcode, pricePounds: (d.quote.quotePricePence / 100).toFixed(2),
            rivalCompanyName: d.quote.rivalCompanyName ?? "", quoteDate: d.quote.quoteDate ?? "",
          }} />
          <DraftUploads jobId={job.id} existing={d.media.map((m) => ({ ...m, kind: m.kind }))} />
        </>
      ) : null}

      {job.status === "submitted" || job.status === "in_review" ? <Notice>Thanks, your quote is in. We&apos;ll check it within one working day, hide the other builder&apos;s details and set a beat price.</Notice> : null}
      {job.status === "rejected" ? <Notice kind="warning">We couldn&apos;t take this job forward. {job.rejectionReason}</Notice> : null}
      {job.status === "crew_window" || job.status === "partner_window" ? <Notice>Your job is with {job.status === "crew_window" ? "our own crews" : "vetted partner builders"} at {formatGBP(job.beatPricePence ?? 0)}. We&apos;ll tell you as soon as a builder takes it.</Notice> : null}
      {job.status === "unmatched" ? <Notice kind="warning">Sorry, no builder was available for this job this time.</Notice> : null}

      {job.status === "offer_pending" && d.offer?.status === "pending" ? (
        <OfferDecision offerId={d.offer.id} termsVersion={cfg.CONTRACT_TERMS_VERSION} pricePence={d.offer.pricePence} expiresAt={d.offer.expiresAt.toISOString()} />
      ) : null}

      {job.status === "awaiting_deposit" && d.contract ? <DepositButton jobId={job.id} depositPence={d.contract.depositPence} /> : null}
      {job.status === "deposit_paid" ? <Notice kind="success">Deposit received and held securely. Your builder will arrange the short pre-start check.</Notice> : null}

      {d.variations.length > 0 ? (
        <section className="card">
          <h2>Variations</h2>
          {d.variations.map((v) => (
            <div key={v.id} className="card">
              <p><strong>{v.amountPence > 0 ? "+" : ""}{formatGBP(v.amountPence)}</strong> <span className="badge">{v.status}</span> <span className="small">{v.reason === "not_reasonably_visible" ? "Not reasonably visible in your uploads" : "Extra work you asked for"}</span></p>
              <p>{v.description}</p>
              {v.status === "proposed" ? <VariationDecision variationId={v.id} reason={v.reason} amountPence={v.amountPence} /> : null}
            </div>
          ))}
        </section>
      ) : null}

      {d.payments.length > 0 ? (
        <section className="card">
          <h2>Payments</h2>
          <table><thead><tr><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>{d.payments.map((p) => <tr key={p.id}><td>{p.kind}</td><td>{formatGBP(p.amountPence)}</td><td>{p.status}</td></tr>)}</tbody></table>
        </section>
      ) : null}

      {job.status !== "draft" && d.media.length > 0 ? (
        <section className="card">
          <h2>Your uploads</h2>
          <div className="media-grid">
            {d.media.filter((m) => m.status !== "deleted").map((m) => (
              <figure key={m.id}>
                {m.hasThumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/media/${m.id}/view?variant=thumb`} alt={m.filename} loading="lazy" />
                ) : <div className="upload-preview" style={{ width: "100%", height: 100 }}><span className="file-badge">{m.mime.split("/")[1]}</span></div>}
                <figcaption>{m.filename}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {cancellable ? <ActionButton endpoint={`/api/jobs/${job.id}/cancel`} label="Cancel this job" variant="danger" confirm="Cancel this job? This can't be undone." /> : null}
    </>
  );
}
