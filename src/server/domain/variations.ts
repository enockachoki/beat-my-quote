import { assertPence, type Pence } from "@/lib/money";

export interface VariationLike {
  amountPence: Pence;
  status: "proposed" | "approved" | "declined" | "withdrawn";
}

/** Only approved variations change the agreed price. */
export function agreedPricePence(contractPricePence: Pence, variations: readonly VariationLike[]): Pence {
  assertPence(contractPricePence);
  const total = variations.filter((v) => v.status === "approved").reduce((sum, v) => sum + v.amountPence, contractPricePence);
  return total;
}

export type VariationCheck = { ok: true; newPricePence: Pence } | { ok: false; reason: "WOULD_MAKE_PRICE_NON_POSITIVE" | "ZERO_AMOUNT" };

export function checkProposedVariation(currentAgreedPence: Pence, amountPence: Pence): VariationCheck {
  assertPence(amountPence);
  if (amountPence === 0) return { ok: false, reason: "ZERO_AMOUNT" };
  const next = currentAgreedPence + amountPence;
  if (next <= 0) return { ok: false, reason: "WOULD_MAKE_PRICE_NON_POSITIVE" };
  return { ok: true, newPricePence: next };
}

/**
 * Declining a variation for something not reasonably visible in the uploads
 * ends the contract with a full deposit refund (before work starts). Declining
 * an extra the homeowner asked for simply leaves the price unchanged.
 */
export function declineOutcome(reason: "not_reasonably_visible" | "homeowner_requested", jobStatus: string): "terminate_and_refund" | "keep_contract" {
  if (reason === "not_reasonably_visible" && jobStatus === "deposit_paid") return "terminate_and_refund";
  return "keep_contract";
}
