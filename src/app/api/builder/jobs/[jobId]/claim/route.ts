import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as offers from "@/server/services/offerService";
import { RULES } from "@/server/services/rateLimit";

export const POST = route<{ jobId: string }>({ auth: ["builder"], idempotent: true, rateLimit: RULES.claim }, async (ctx) => {
  const offer = await offers.claimJob(ctx.user!, uuidSchema.parse(ctx.params.jobId));
  return { status: 201, body: { offerId: offer.id, status: offer.status, expiresAt: offer.expiresAt } };
});
