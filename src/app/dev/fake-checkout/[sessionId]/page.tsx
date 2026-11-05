import { notFound } from "next/navigation";
import { config } from "@/server/config";
import { payments } from "@/server/payments";
import { FakePaymentProvider } from "@/server/payments/fake";
import { formatGBP } from "@/lib/money";
import { FakeCheckoutButtons } from "@/components/forms/FakeCheckout";

export const metadata = { title: "Test checkout" };

/** DEV ONLY: stands in for Stripe's hosted checkout page. */
export default async function FakeCheckout({ params }: { params: Promise<{ sessionId: string }> }) {
  const cfg = config();
  const provider = payments();
  if (cfg.APP_ENV === "production" || !(provider instanceof FakePaymentProvider)) notFound();
  const { sessionId } = await params;
  const s = await provider.retrieveCheckout(sessionId).catch(() => null);
  if (!s) notFound();
  return (
    <div className="card" style={{ maxWidth: 520, margin: "0 auto" }}>
      <p className="badge">TEST PAYMENT PAGE: NO MONEY MOVES</p>
      <h1>Pay {formatGBP(s.amountTotal ?? 0)}</h1>
      <FakeCheckoutButtons sessionId={sessionId} />
    </div>
  );
}
