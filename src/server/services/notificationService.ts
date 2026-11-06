import "server-only";
import type { Tx } from "../db/client";
import { withServiceTx } from "../db/client";
import { config } from "../config";
import { log } from "../observability/logger";
import { backoffDelayMs } from "@/lib/backoff";
import { emailSender, smsSender } from "../notifications/providers";
import { render, type Template } from "../notifications/templates";

/**
 * Transactional outbox: notifications are written in the same transaction as
 * the change they describe, then sent by a background worker with retries.
 * A provider outage therefore never loses or blocks a business operation.
 */
export async function enqueue(tx: Tx, userId: string, template: Template, payload: Record<string, string>, dedupeKey?: string, channels: Array<"email" | "sms"> = ["email"]): Promise<void> {
  for (const channel of channels) {
    await tx`
      insert into public.notifications (user_id, channel, template, payload, dedupe_key)
      values (${userId}, ${channel}, ${template}, ${tx.json(payload)}, ${dedupeKey ? `${dedupeKey}:${channel}` : null})
      on conflict (dedupe_key) do nothing`;
  }
}

const MAX_ATTEMPTS = 6;

export async function processDueNotifications(limit = 25): Promise<{ sent: number; failed: number; dead: number }> {
  const result = { sent: 0, failed: 0, dead: 0 };
  const due = await withServiceTx(async (tx) =>
    tx<{ id: string; userId: string; channel: "email" | "sms"; template: Template; payload: Record<string, string>; attempts: number; email: string | null; phone: string | null }[]>`
      update public.notifications n set attempts = n.attempts + 1, next_attempt_at = now() + interval '5 minutes'
      from (select n2.id, u.email, p.phone from public.notifications n2
            join public.profiles p on p.id = n2.user_id join auth.users u on u.id = n2.user_id
            where n2.status in ('pending', 'failed') and n2.next_attempt_at <= now()
            order by n2.next_attempt_at limit ${limit} for update of n2 skip locked) d
      where n.id = d.id
      returning n.id, n.user_id, n.channel, n.template, n.payload, n.attempts, d.email, d.phone`,
  );
  const origin = config().APP_ORIGIN;
  for (const n of due) {
    const to = n.channel === "email" ? n.email : n.phone;
    try {
      if (!to) throw Object.assign(new Error("no recipient"), { code: "PERMANENT" });
      const msg = render(n.template, n.payload, origin);
      await (n.channel === "email" ? emailSender() : smsSender()).send({ to, subject: msg.subject, text: msg.text });
      await withServiceTx((tx) => tx`update public.notifications set status = 'sent', sent_at = now(), last_error = null where id = ${n.id}`);
      result.sent++;
    } catch (err) {
      const permanent = (err as { code?: string }).code === "PERMANENT";
      const dead = permanent || n.attempts >= MAX_ATTEMPTS;
      const delayMs = Math.max(30_000, backoffDelayMs(n.attempts, 30_000, 6 * 60 * 60 * 1000));
      await withServiceTx((tx) => tx`
        update public.notifications set status = ${dead ? "dead" : "failed"}, last_error = ${String((err as Error).message).slice(0, 200)},
          next_attempt_at = now() + make_interval(secs => ${Math.round(delayMs / 1000)})
        where id = ${n.id}`);
      log.warn("notification.failed", { id: n.id, template: n.template, channel: n.channel, attempts: n.attempts, dead });
      if (dead) result.dead++;
      else result.failed++;
    }
  }
  return result;
}
