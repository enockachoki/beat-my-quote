import { route } from "@/server/http/handler";
import { submitJobSchema, uuidSchema } from "@/lib/schemas";
import * as jobs from "@/server/services/jobService";

export const POST = route<{ jobId: string }>({ auth: ["homeowner"], idempotent: true }, async (ctx) => {
  await ctx.body(submitJobSchema);
  const job = await jobs.submitJob(ctx.user!, uuidSchema.parse(ctx.params.jobId));
  return { body: { id: job.id, status: job.status } };
});
