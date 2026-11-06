import { route } from "@/server/http/handler";
import { prestartSchema, uuidSchema } from "@/lib/schemas";
import * as workflow from "@/server/services/workflowService";

export const POST = route<{ jobId: string }>({ auth: ["builder"], idempotent: true }, async (ctx) => {
  const { outcome, notes } = await ctx.body(prestartSchema);
  return { body: await workflow.recordPrestart(ctx.user!, uuidSchema.parse(ctx.params.jobId), outcome, notes) };
});
