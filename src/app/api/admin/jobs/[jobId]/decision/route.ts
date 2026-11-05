import { route } from "@/server/http/handler";
import { reviewDecisionSchema, uuidSchema } from "@/lib/schemas";
import * as review from "@/server/services/reviewService";

export const POST = route<{ jobId: string }>({ auth: ["admin"], idempotent: true }, async (ctx) => {
  const d = await ctx.body(reviewDecisionSchema);
  const job = await review.decide(ctx.user!, uuidSchema.parse(ctx.params.jobId), d);
  return { body: { status: job.status, beatPricePence: job.beatPricePence } };
});
