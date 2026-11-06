import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as jobs from "@/server/services/jobService";

export const POST = route<{ jobId: string }>({ auth: ["homeowner", "admin"], idempotent: true }, async (ctx) => {
  const job = await jobs.cancelJob(ctx.user!, uuidSchema.parse(ctx.params.jobId));
  return { body: { id: job.id, status: job.status } };
});
