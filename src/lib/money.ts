/** All money is handled as integer pence, inclusive of VAT, unless named otherwise. */
export type Pence = number;

export function assertPence(value: number, label = "amount"): asserts value is Pence {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a whole number of pence`);
}

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export function formatGBP(pence: Pence): string {
  assertPence(pence);
  return gbp.format(pence / 100);
}

/** Parses "£1,234.50" / "1234.5" / "1234" into pence. Returns null when invalid. */
export function parsePoundsToPence(input: string): Pence | null {
  const cleaned = input.replace(/[£,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
