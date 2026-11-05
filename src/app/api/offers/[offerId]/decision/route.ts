import { z } from "zod";
import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as offers from "@/server/services/offerService";

const schema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept"), termsVersion: z.string().min(1).max(40), agreeToContract: z.literal(true, { message: "Please agree to the Job Contract" }) }),
  z.object({ decision: z.literal("decline") }),
]);

export const POST = route<{ offerId: string }>({ auth: ["homeowner"], idempotent: true }, async (ctx) => {
  const d = await ctx.body(schema);
  const r = await offers.decideOffer(ctx.user!, uuidSchema.parse(ctx.params.offerId), d.decision, d.decision === "accept" ? d.termsVersion : undefined);
  return { body: { offerStatus: r.offer.status, contractId: r.contract?.id ?? null } };
});
