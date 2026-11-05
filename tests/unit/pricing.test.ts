import { describe, expect, it } from "vitest";
import { calculateBeatPrice, depositPence, exVat, successFeePence } from "@/server/domain/pricing";
import { formatGBP, parsePoundsToPence } from "@/lib/money";

describe("calculateBeatPrice", () => {
  it("landing page example: £8,640 at 8% gives £7,948 (rounded down to the pound, saving £692)", () => {
    const r = calculateBeatPrice(864_000, 800, 50_000);
    expect(r).toEqual({ ok: true, beatPricePence: 794_800, savingPence: 69_200 });
  });
  it("always rounds down to a whole pound so the saving is at least the stated percentage", () => {
    const r = calculateBeatPrice(123_456, 500, 0);
    expect(r.ok && r.beatPricePence).toBe(117_200);
    expect(r.ok && r.savingPence / 123_456).toBeGreaterThanOrEqual(0.05);
  });
  it.each([499, 1001, 750.5, -1])("rejects beat percentages outside 5-10%% (%s bps)", (bps) => {
    expect(calculateBeatPrice(100_000, bps, 0)).toEqual({ ok: false, reason: "INVALID_PERCENT" });
  });
  it("refuses jobs that would fall below the minimum price", () => {
    expect(calculateBeatPrice(50_000, 1000, 50_000)).toMatchObject({ ok: false, reason: "BELOW_MINIMUM", beatPricePence: 45_000 });
  });
  it("rejects non-integer pence", () => {
    expect(() => calculateBeatPrice(100.5, 500, 0)).toThrow(RangeError);
  });
});

describe("VAT, fees and deposits", () => {
  it("converts inc-VAT to ex-VAT at 20%", () => {
    expect(exVat(120_000)).toBe(100_000);
    expect(exVat(100)).toBe(83);
  });
  it("calculates the success fee on the ex-VAT value", () => {
    expect(successFeePence(120_000, 1000)).toBe(10_000);
    expect(successFeePence(120_000, 0)).toBe(0);
    expect(() => successFeePence(120_000, 5000)).toThrow();
  });
  it("rounds deposits up to the penny and never exceeds the price", () => {
    expect(depositPence(794_000, 1000)).toBe(79_400);
    expect(depositPence(333, 1000)).toBe(34);
    expect(() => depositPence(1000, 9000)).toThrow();
  });
});

describe("money helpers", () => {
  it("formats pounds in en-GB", () => {
    expect(formatGBP(794_000)).toBe("£7,940.00");
  });
  it.each([["£4,500.00", 450_000], ["4500", 450_000], ["4500.5", 450_050], ["0.99", 99]])("parses %s", (input, pence) => {
    expect(parsePoundsToPence(input)).toBe(pence);
  });
  it.each(["", "abc", "1.234", "-5", "1e5", "£"])("rejects %s", (input) => {
    expect(parsePoundsToPence(input)).toBeNull();
  });
});
