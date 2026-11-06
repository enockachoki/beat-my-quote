import { route, assertCron } from "@/server/http/handler";
import { AppError } from "@/server/errors";
import * as media from "@/server/services/mediaService";
import * as offers from "@/server/services/offerService";
import * as paymentsSvc from "@/server/services/paymentService";
import { processDueNotifications } from "@/server/services/notificationService";
import { withServiceTx } from "@/server/db/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TASKS: Record<string, () => Promise<unknown>> = {
  "process-media": () => media.processPending(10),
  "cleanup-uploads": () => media.cleanupStaleUploads(100),
  "advance-windows": async () => ({ windows: await offers.advanceWindows(), offers: await offers.expireOffers() }),
  "send-notifications": () => processDueNotifications(25),
  "reconcile-payments": () => paymentsSvc.reconcilePayments(),
  prune: () =>
    withServiceTx(async (tx) => {
      await tx`delete from public.idempotency_keys where created_at < now() - interval '2 days'`;
      await tx`delete from public.rate_limits where window_start < now() - interval '1 day'`;
      return { ok: true };
    }),
};

/** Scheduled jobs (Vercel Cron). Each task is safe to run concurrently and repeatedly. */
const handler = route<{ task: string }>({ auth: "public", allowCrossOrigin: true }, async (ctx) => {
  assertCron(ctx.req);
  const task = TASKS[ctx.params.task];
  if (!task) throw new AppError("NOT_FOUND");
  return { body: { task: ctx.params.task, result: await task() } };
});
export const GET = handler;
export const POST = handler;
