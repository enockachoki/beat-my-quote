import { route } from "@/server/http/handler";
import * as paymentsSvc from "@/server/services/paymentService";

export const dynamic = "force-dynamic";

/** Signature-verified provider webhook. Raw body is required for verification. */
export const POST = route({ auth: "public", allowCrossOrigin: true }, async (ctx) => {
  const raw = await ctx.req.text();
  if (raw.length > 512 * 1024) return { status: 413, body: { error: "too large" } };
  const outcome = await paymentsSvc.handleWebhook(raw, ctx.req.headers.get("stripe-signature"));
  return { body: { received: true, outcome } };
});
