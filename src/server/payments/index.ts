import "server-only";
import { config } from "../config";
import { FakePaymentProvider } from "./fake";
import { StripePaymentProvider } from "./stripe";
import type { PaymentProvider } from "./types";

let provider: PaymentProvider | undefined;

export function payments(): PaymentProvider {
  if (!provider) {
    const cfg = config();
    if (cfg.PAYMENT_PROVIDER === "stripe") {
      if (!cfg.STRIPE_SECRET_KEY || !cfg.STRIPE_WEBHOOK_SECRET) throw new Error("Stripe is not configured");
      if (cfg.APP_ENV !== "production" && cfg.STRIPE_SECRET_KEY.startsWith("sk_live_")) throw new Error("Refusing to use a live Stripe key outside production");
      provider = new StripePaymentProvider(cfg.STRIPE_SECRET_KEY, cfg.STRIPE_WEBHOOK_SECRET);
    } else {
      if (cfg.APP_ENV === "production") throw new Error("Fake payments are not allowed in production");
      provider = new FakePaymentProvider(cfg.FAKE_PAYMENT_WEBHOOK_SECRET ?? "whsec_fake_local_development_only", cfg.APP_ORIGIN);
    }
  }
  return provider;
}

export function setPaymentsForTests(p: PaymentProvider | undefined): void {
  provider = p;
}
