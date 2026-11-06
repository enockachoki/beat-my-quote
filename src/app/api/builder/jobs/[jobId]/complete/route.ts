import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as workflow from "@/server/services/workflowService";

export const POST = route<{ jobId: string }>({ auth: ["builder"], idempotent: true }, async (ctx) => {
  const job = await workflow.completeWork(ctx.user!, uuidSchema.parse(ctx.params.jobId));
  return { body: { status: job.status } };
});
