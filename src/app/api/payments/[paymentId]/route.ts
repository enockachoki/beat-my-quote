import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as paymentsSvc from "@/server/services/paymentService";

export const GET = route<{ paymentId: string }>({ auth: ["homeowner"] }, async (ctx) => ({
  body: await paymentsSvc.getPaymentStatus(ctx.user!, uuidSchema.parse(ctx.params.paymentId)),
}));
