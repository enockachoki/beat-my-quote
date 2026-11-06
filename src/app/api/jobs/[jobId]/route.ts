import { route } from "@/server/http/handler";
import { jobDraftSchema, uuidSchema } from "@/lib/schemas";
import * as jobs from "@/server/services/jobService";
import { AppError } from "@/server/errors";

type P = { jobId: string };
const id = (p: P) => {
  const r = uuidSchema.safeParse(p.jobId);
  if (!r.success) throw new AppError("NOT_FOUND");
  return r.data;
};

export const GET = route<P>({ auth: ["homeowner"] }, async (ctx) => ({ body: await jobs.getHomeownerJob(ctx.user!, id(ctx.params)) }));

export const PATCH = route<P>({ auth: ["homeowner"] }, async (ctx) => {
  const draft = await ctx.body(jobDraftSchema);
  const job = await jobs.updateDraft(ctx.user!, id(ctx.params), draft);
  return { body: { id: job.id, status: job.status } };
});
