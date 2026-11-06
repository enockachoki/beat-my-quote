import { describe, expect, it } from "vitest";
import { addressRevealed, allTransitions, canTransition, JOB_STATUSES, TERMINAL } from "@/server/domain/jobStateMachine";
import { agreedPricePence, checkProposedVariation, declineOutcome } from "@/server/domain/variations";

describe("job state machine", () => {
  it("allows the happy path in order", () => {
    const path = ["draft", "submitted", "in_review", "crew_window", "offer_pending", "awaiting_deposit", "deposit_paid", "in_progress", "completed"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it("blocks skipping review, payment or the pre-start stage", () => {
    expect(canTransition("draft", "crew_window")).toBe(false);
    expect(canTransition("submitted", "crew_window")).toBe(false);
    expect(canTransition("offer_pending", "deposit_paid")).toBe(false);
    expect(canTransition("awaiting_deposit", "in_progress")).toBe(false);
    expect(canTransition("crew_window", "awaiting_deposit")).toBe(false);
  });
  it("enforces who may cause a transition", () => {
    expect(canTransition("in_review", "crew_window", "admin")).toBe(true);
    expect(canTransition("in_review", "crew_window", "homeowner")).toBe(false);
    expect(canTransition("awaiting_deposit", "deposit_paid", "homeowner")).toBe(false); // only the verified payment system
    expect(canTransition("crew_window", "offer_pending", "builder")).toBe(true);
    expect(canTransition("crew_window", "partner_window", "builder")).toBe(false);
  });
  it("has no transitions out of terminal states", () => {
    for (const t of TERMINAL) for (const s of JOB_STATUSES) expect(canTransition(t, s)).toBe(false);
  });
  it("lists every transition exactly once", () => {
    const all = allTransitions().map(([a, b]) => `${a}>${b}`);
    expect(new Set(all).size).toBe(all.length);
  });
  it("reveals the address only after acceptance", () => {
    expect(addressRevealed("offer_pending")).toBe(false);
    expect(addressRevealed("crew_window")).toBe(false);
    expect(addressRevealed("awaiting_deposit")).toBe(true);
  });
});

describe("variations", () => {
  const v = (amountPence: number, status: "proposed" | "approved" | "declined" | "withdrawn") => ({ amountPence, status });
  it("only approved variations change the agreed price", () => {
    expect(agreedPricePence(794_000, [v(50_000, "approved"), v(99_999, "proposed"), v(10_000, "declined"), v(-4_000, "approved")])).toBe(840_000);
  });
  it("rejects zero and price-erasing variations", () => {
    expect(checkProposedVariation(100_000, 0)).toEqual({ ok: false, reason: "ZERO_AMOUNT" });
    expect(checkProposedVariation(100_000, -100_000)).toEqual({ ok: false, reason: "WOULD_MAKE_PRICE_NON_POSITIVE" });
    expect(checkProposedVariation(100_000, 25_000)).toEqual({ ok: true, newPricePence: 125_000 });
  });
  it("declining a hidden-problem variation before work starts ends the contract with a refund", () => {
    expect(declineOutcome("not_reasonably_visible", "deposit_paid")).toBe("terminate_and_refund");
    expect(declineOutcome("homeowner_requested", "deposit_paid")).toBe("keep_contract");
    expect(declineOutcome("not_reasonably_visible", "in_progress")).toBe("keep_contract");
  });
});
