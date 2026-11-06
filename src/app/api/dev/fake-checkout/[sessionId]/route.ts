import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/server/config";
import { payments } from "@/server/payments";
import { FakePaymentProvider } from "@/server/payments/fake";
import { checkSameOrigin } from "@/server/http/handler";

export const dynamic = "force-dynamic";

/**
 * DEV ONLY: simulates the homeowner paying on the provider's page, then
 * delivers a Stripe-format signed webhook to our real webhook endpoint.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  const cfg = config();
  const provider = payments();
  if (cfg.APP_ENV === "production" || !(provider instanceof FakePaymentProvider) || !checkSameOrigin(req)) return new NextResponse(null, { status: 404 });
  const { sessionId } = await ctx.params;
  const delivery = provider.completeSession(sessionId);
  if (!delivery) return NextResponse.json({ error: "session not open" }, { status: 409 });
  const skipWebhook = req.nextUrl.searchParams.get("skipWebhook") === "1"; // simulate a lost webhook
  if (!skipWebhook) {
    await fetch(`${cfg.APP_ORIGIN}/api/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": delivery.signature }, body: delivery.body });
  }
  return NextResponse.json({ ok: true, successUrl: delivery.successUrl });
}
