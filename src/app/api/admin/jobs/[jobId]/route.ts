import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as review from "@/server/services/reviewService";

export const GET = route<{ jobId: string }>({ auth: ["admin"] }, async (ctx) => ({ body: await review.getReviewDetail(ctx.user!, uuidSchema.parse(ctx.params.jobId)) }));
