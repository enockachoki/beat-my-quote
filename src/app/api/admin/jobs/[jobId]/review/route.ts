import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as review from "@/server/services/reviewService";

export const POST = route<{ jobId: string }>({ auth: ["admin"] }, async (ctx) => {
  const job = await review.startReview(ctx.user!, uuidSchema.parse(ctx.params.jobId));
  return { body: { status: job.status, version: job.version } };
});
