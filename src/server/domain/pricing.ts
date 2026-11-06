import { assertPence, type Pence } from "@/lib/money";

export const MIN_BEAT_BPS = 500; // 5%
export const MAX_BEAT_BPS = 1000; // 10%
export const VAT_BPS = 2000; // 20% standard UK VAT

export type BeatPriceResult =
  | { ok: true; beatPricePence: Pence; savingPence: Pence }
  | { ok: false; reason: "INVALID_PERCENT" | "BELOW_MINIMUM"; beatPricePence?: Pence };

/**
 * Beat price = quote less 5-10%, rounded DOWN to the whole pound so the
 * homeowner always saves at least the stated percentage. All values inc VAT.
 */
export function calculateBeatPrice(quotePence: Pence, beatBps: number, minimumPence: Pence): BeatPriceResult {
  assertPence(quotePence, "quote");
  assertPence(minimumPence, "minimum");
  if (!Number.isInteger(beatBps) || beatBps < MIN_BEAT_BPS || beatBps > MAX_BEAT_BPS) return { ok: false, reason: "INVALID_PERCENT" };
  if (quotePence <= 0) return { ok: false, reason: "BELOW_MINIMUM" };
  const raw = Math.floor((quotePence * (10_000 - beatBps)) / 10_000);
  const beatPricePence = Math.floor(raw / 100) * 100;
  if (beatPricePence < minimumPence) return { ok: false, reason: "BELOW_MINIMUM", beatPricePence };
  return { ok: true, beatPricePence, savingPence: quotePence - beatPricePence };
}

/** Converts an inc-VAT amount to ex-VAT, rounding to the nearest penny. */
export function exVat(incVatPence: Pence, vatBps = VAT_BPS): Pence {
  assertPence(incVatPence);
  return Math.round((incVatPence * 10_000) / (10_000 + vatBps));
}

/**
 * Partner success fee: a percentage of the job value ex VAT, charged only on
 * jobs the partner wins. The rate is not set yet (config SUCCESS_FEE_BASIS_POINTS).
 */
export function successFeePence(jobPriceIncVatPence: Pence, feeBps: number): Pence {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 3000) throw new RangeError("fee basis points out of range");
  return Math.round((exVat(jobPriceIncVatPence) * feeBps) / 10_000);
}

/** Deposit, rounded up to the penny, never more than the price. */
export function depositPence(pricePence: Pence, depositBps: number): Pence {
  assertPence(pricePence);
  if (!Number.isInteger(depositBps) || depositBps < 100 || depositBps > 2500) throw new RangeError("deposit basis points out of range");
  return Math.min(pricePence, Math.ceil((pricePence * depositBps) / 10_000));
}
