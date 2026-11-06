import { route } from "@/server/http/handler";
import { uuidSchema, variationSchema } from "@/lib/schemas";
import * as workflow from "@/server/services/workflowService";

export const POST = route<{ jobId: string }>({ auth: ["builder"], idempotent: true }, async (ctx) => {
  const v = await ctx.body(variationSchema);
  const row = await workflow.proposeVariation(ctx.user!, uuidSchema.parse(ctx.params.jobId), v);
  return { status: 201, body: { id: row.id, status: row.status } };
});
