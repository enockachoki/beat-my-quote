import Link from "next/link";
import { requirePageUser } from "@/server/http/pageAuth";
import * as builders from "@/server/services/builderService";
import { formatGBP } from "@/lib/money";
import { TRADE_LABELS, type Trade } from "@/lib/schemas";
import { STATUS_LABELS } from "@/server/domain/jobStateMachine";
import { Notice } from "@/components/ui";

export const metadata = { title: "Builder dashboard" };

export default async function BuilderHome({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const user = await requirePageUser(["builder"], "/builder");
  const me = await builders.getMyBuilder(user);
  if (!me) {
    return (
      <div className="card">
        <h1>Join as a builder</h1>
        <p>Tell us about your company, trades and the areas you cover.</p>
        <Link className="btn btn-primary" href="/builder/apply">Start your application</Link>
      </div>
    );
  }
  if (me.status !== "approved") {
    return (
      <div className="card">
        <h1>{me.companyName}</h1>
        <Notice kind={me.status === "pending" ? "info" : "warning"}>
          {me.status === "pending" ? "Your application is being reviewed. We check ID, insurance and references before you can take jobs." : `Your account is ${me.status}. Please contact us.`}
        </Notice>
        {me.status === "rejected" ? <Link href="/builder/apply">Update and resubmit your application</Link> : null}
      </div>
    );
  }
  const { cursor } = await searchParams;
  const [jobs, offers] = await Promise.all([builders.listAvailableJobs(user, cursor, 20), builders.listMyOffers(user, undefined, 20)]);
  return (
    <>
      <h1>Jobs for {me.companyName}</h1>
      <p className="small">{me.kind === "crew" ? "In-house crew: you see jobs first." : "Partner builder: you see jobs after our crews have passed."} Builders never quote: you take a job at its beat price.</p>
      <section className="card">
        <h2>Available jobs</h2>
        {jobs.items.length === 0 ? <p>No jobs in your trades and areas right now.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Job</th><th>Type</th><th>Area</th><th>Price inc VAT</th><th>Window closes</th></tr></thead>
            <tbody>{jobs.items.map((j) => (
              <tr key={j.id}>
                <td><Link href={`/builder/jobs/${j.id}`}>{j.title}</Link></td>
                <td>{TRADE_LABELS[j.trade as Trade] ?? j.trade}</td>
                <td>{j.postcodeDistrict}</td>
                <td>{formatGBP(j.beatPricePence ?? 0)}</td>
                <td>{j.windowEndsAt ? j.windowEndsAt.toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" }) : "–"}</td>
              </tr>))}
            </tbody></table></div>
        )}
        {jobs.nextCursor ? <div className="pager"><Link className="btn btn-secondary" href={`/builder?cursor=${encodeURIComponent(jobs.nextCursor)}`}>More jobs</Link></div> : null}
      </section>
      <section className="card">
        <h2>My jobs and offers</h2>
        {offers.items.length === 0 ? <p>None yet.</p> : (
          <div className="table-wrap"><table><thead><tr><th>Job</th><th>Offer</th><th>Job status</th></tr></thead>
            <tbody>{offers.items.map((o) => (
              <tr key={o.id}><td><Link href={`/builder/jobs/${o.jobId}`}>{o.title}</Link></td><td><span className="badge">{o.status}</span> {formatGBP(o.pricePence)}</td><td>{STATUS_LABELS[o.jobStatus as keyof typeof STATUS_LABELS] ?? o.jobStatus}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>
    </>
  );
}
