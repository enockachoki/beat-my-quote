import { route } from "@/server/http/handler";
import { uuidSchema, variationDecisionSchema } from "@/lib/schemas";
import * as workflow from "@/server/services/workflowService";

export const POST = route<{ variationId: string }>({ auth: ["homeowner"], idempotent: true }, async (ctx) => {
  const { decision } = await ctx.body(variationDecisionSchema);
  const r = await workflow.decideVariation(ctx.user!, uuidSchema.parse(ctx.params.variationId), decision);
  return { body: { status: r.variation?.status, terminated: r.terminated, agreedPricePence: r.agreedPricePence } };
});
