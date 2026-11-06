import { z } from "zod";
import { route } from "@/server/http/handler";
import { idempotencyKeySchema, jobDraftSchema, paginationSchema } from "@/lib/schemas";
import * as jobs from "@/server/services/jobService";

export const GET = route({ auth: ["homeowner"] }, async (ctx) => {
  const { cursor, limit } = ctx.query(paginationSchema);
  return { body: await jobs.listMyJobs(ctx.user!, cursor, limit) };
});

/** Creating a draft is idempotent on submissionKey, so a retried request never makes two jobs. */
export const POST = route({ auth: ["homeowner"] }, async (ctx) => {
  const { submissionKey, draft } = await ctx.body(z.object({ submissionKey: idempotencyKeySchema, draft: jobDraftSchema }));
  const { job, created } = await jobs.createDraft(ctx.user!, draft, submissionKey);
  return { status: created ? 201 : 200, body: { id: job.id, status: job.status } };
});
