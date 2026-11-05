import { z } from "zod";
import { route } from "@/server/http/handler";
import { paginationSchema } from "@/lib/schemas";
import * as review from "@/server/services/reviewService";
import { JOB_STATUSES } from "@/server/domain/jobStateMachine";

export const GET = route({ auth: ["admin"] }, async (ctx) => {
  const q = ctx.query(paginationSchema.extend({ status: z.enum(JOB_STATUSES).optional() }));
  return { body: await review.listQueue(ctx.user!, q.status ? [q.status] : ["submitted", "in_review"], q.cursor, q.limit) };
});
