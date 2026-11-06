import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as paymentsSvc from "@/server/services/paymentService";

export const POST = route<{ jobId: string }>({ auth: ["homeowner"], idempotent: true }, async (ctx) => {
  return { body: await paymentsSvc.startDeposit(ctx.user!, uuidSchema.parse(ctx.params.jobId)) };
});
