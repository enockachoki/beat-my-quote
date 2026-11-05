export const JOB_STATUSES = [
  "draft", "submitted", "in_review", "rejected", "crew_window", "partner_window", "offer_pending",
  "awaiting_deposit", "deposit_paid", "in_progress", "completed", "cancelled", "unmatched",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type Actor = "homeowner" | "builder" | "admin" | "system";

/**
 * Mirrors public.job_status_transitions (the database enforces it with a
 * trigger). `by` lists who may cause each transition.
 */
export const JOB_TRANSITIONS: Record<JobStatus, Partial<Record<JobStatus, readonly Actor[]>>> = {
  draft: { submitted: ["homeowner"], cancelled: ["homeowner", "admin"] },
  submitted: { in_review: ["admin"], cancelled: ["homeowner", "admin"] },
  in_review: { crew_window: ["admin"], rejected: ["admin"], cancelled: ["admin"] },
  rejected: {},
  crew_window: { partner_window: ["system"], offer_pending: ["builder"], cancelled: ["homeowner", "admin"] },
  partner_window: { offer_pending: ["builder"], unmatched: ["system"], cancelled: ["homeowner", "admin"] },
  offer_pending: {
    awaiting_deposit: ["homeowner"],
    crew_window: ["homeowner", "system"],
    partner_window: ["homeowner", "system"],
    unmatched: ["homeowner", "system"],
    cancelled: ["homeowner", "admin"],
  },
  awaiting_deposit: { deposit_paid: ["system"], cancelled: ["homeowner", "admin", "system"] },
  deposit_paid: { in_progress: ["builder"], cancelled: ["homeowner", "admin", "system"] },
  in_progress: { completed: ["builder", "admin"] },
  completed: {},
  cancelled: {},
  unmatched: {},
};

export function canTransition(from: JobStatus, to: JobStatus, actor?: Actor): boolean {
  const allowed = JOB_TRANSITIONS[from]?.[to];
  if (!allowed) return false;
  return actor === undefined || allowed.includes(actor);
}

export function allTransitions(): Array<[JobStatus, JobStatus]> {
  const out: Array<[JobStatus, JobStatus]> = [];
  for (const from of JOB_STATUSES) for (const to of Object.keys(JOB_TRANSITIONS[from]) as JobStatus[]) out.push([from, to]);
  return out;
}

export const TERMINAL: readonly JobStatus[] = ["rejected", "completed", "cancelled", "unmatched"];

/** Statuses in which the homeowner's address is hidden from builders. */
export function addressRevealed(status: JobStatus): boolean {
  return ["awaiting_deposit", "deposit_paid", "in_progress", "completed"].includes(status);
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  draft: "Draft",
  submitted: "Submitted for review",
  in_review: "Being reviewed",
  rejected: "Not accepted",
  crew_window: "Offered to our crews",
  partner_window: "Offered to partner builders",
  offer_pending: "Offer waiting for you",
  awaiting_deposit: "Waiting for deposit",
  deposit_paid: "Deposit paid",
  in_progress: "Work in progress",
  completed: "Completed",
  cancelled: "Cancelled",
  unmatched: "No builder found",
};
