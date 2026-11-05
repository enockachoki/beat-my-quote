export type Template =
  | "job_submitted" | "job_approved" | "job_rejected" | "new_job_available" | "offer_received" | "offer_accepted"
  | "offer_expired" | "deposit_paid" | "variation_proposed" | "variation_decided" | "contract_terminated" | "builder_decided";

/** Plain-text templates. Payloads contain ids and titles only, never addresses or quotes. */
export function render(template: Template, p: Record<string, string>, origin: string): { subject: string; text: string } {
  const link = (path: string) => `${origin}${path}`;
  switch (template) {
    case "job_submitted":
      return { subject: "We've received your quote", text: `Thanks. We're reviewing "${p.title}" and will be in touch soon.\n${link(`/homeowner/jobs/${p.jobId}`)}` };
    case "job_approved":
      return { subject: "Your job is live with our builders", text: `"${p.title}" has been reviewed and offered to builders at ${p.price}.\n${link(`/homeowner/jobs/${p.jobId}`)}` };
    case "job_rejected":
      return { subject: "About your quote", text: `We weren't able to take "${p.title}" forward. ${p.reason ?? ""}\n${link(`/homeowner/jobs/${p.jobId}`)}` };
    case "new_job_available":
      return { subject: "New job available", text: `A new ${p.trade} job in ${p.district} is available at ${p.price}.\n${link(`/builder/jobs/${p.jobId}`)}` };
    case "offer_received":
      return { subject: "A builder will beat your quote", text: `A vetted builder will do "${p.title}" for ${p.price}. Review and accept before ${p.expires}.\n${link(`/homeowner/jobs/${p.jobId}`)}` };
    case "offer_accepted":
      return { subject: "Your offer was accepted", text: `The homeowner accepted your offer for "${p.title}". You can now see the address. Work can start once the deposit is paid and the pre-start check is done.\n${link(`/builder/jobs/${p.jobId}`)}` };
    case "offer_expired":
      return { subject: "An offer expired", text: `The offer for "${p.title}" expired.\n${link(`/homeowner/jobs/${p.jobId}`)}` };
    case "deposit_paid":
      return { subject: "Deposit received", text: `The deposit for "${p.title}" has been received and is held securely.\n${link(p.path ?? "/")}` };
    case "variation_proposed":
      return { subject: "A change to your job needs your decision", text: `Your builder has proposed a written variation for "${p.title}".\n${link(`/homeowner/jobs/${p.jobId}`)}` };
    case "variation_decided":
      return { subject: "Variation decision", text: `The homeowner ${p.decision} the variation for "${p.title}".\n${link(`/builder/jobs/${p.jobId}`)}` };
    case "contract_terminated":
      return { subject: "Your job contract has ended", text: `The contract for "${p.title}" has ended. ${p.refund ?? ""}\n${link(p.path ?? "/")}` };
    case "builder_decided":
      return { subject: "Your builder application", text: `Your application has been ${p.decision}.\n${link("/builder")}` };
  }
}
