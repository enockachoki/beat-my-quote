import type { Tx } from "../db/client";
import { requestContext } from "../observability/logger";
import { redact } from "../observability/logger";
import type { SessionUser } from "../authz/policies";

export type AuditAction =
  | "auth.sign_in" | "auth.sign_in_failed" | "auth.sign_up" | "auth.password_reset_requested" | "auth.password_reset"
  | "job.created" | "job.updated" | "job.submitted" | "job.cancelled" | "job.review_started" | "job.approved" | "job.rejected"
  | "job.window_advanced" | "job.unmatched" | "job.started" | "job.completed"
  | "media.original_viewed" | "media.published" | "media.removed" | "media.quarantined"
  | "builder.applied" | "builder.approved" | "builder.rejected" | "builder.suspended"
  | "offer.created" | "offer.accepted" | "offer.declined" | "offer.expired"
  | "contract.created" | "contract.terminated"
  | "prestart.recorded" | "variation.proposed" | "variation.approved" | "variation.declined"
  | "payment.created" | "payment.succeeded" | "payment.failed" | "payment.refund_requested" | "payment.reconciled" | "payment.webhook_duplicate";

/** Writes an append-only audit record in the same transaction as the change. */
export async function audit(
  tx: Tx,
  actor: SessionUser | { id: null; role: "system" },
  action: AuditAction,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  const correlationId = requestContext.getStore()?.requestId ?? null;
  const safe = redact(details) as Record<string, unknown>;
  await tx`
    insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id, correlation_id, details)
    values (${actor.id}, ${actor.role}, ${action}, ${entityType}, ${entityId}, ${correlationId}, ${tx.json(safe as never)})
  `;
}

export const SYSTEM_ACTOR = { id: null, role: "system" } as const;
