import { describe, expect, it } from "vitest";
import { builderApplicationSchema, jobDraftSchema, normalisePostcode, postcodeDistrict, reviewDecisionSchema, signUpSchema, variationSchema } from "@/lib/schemas";

const draft = {
  trade: "bathroom-refit",
  title: "Full bathroom refit",
  description: "First floor",
  address: { line1: "1 Test Street", town: "London", postcode: "se15 4aa" },
  quote: { pricePounds: "8,640.00" },
};

describe("job draft validation", () => {
  it("accepts and normalises a valid draft", () => {
    const r = jobDraftSchema.parse(draft);
    expect(r.address.postcode).toBe("SE15 4AA");
    expect(r.quote.pricePounds).toBe(864_000);
  });
  it("rejects bad postcodes, trades and prices", () => {
    expect(jobDraftSchema.safeParse({ ...draft, address: { ...draft.address, postcode: "NOTAPOSTCODE" } }).success).toBe(false);
    expect(jobDraftSchema.safeParse({ ...draft, trade: "hacking" }).success).toBe(false);
    expect(jobDraftSchema.safeParse({ ...draft, quote: { pricePounds: "50" } }).success).toBe(false);
    expect(jobDraftSchema.safeParse({ ...draft, quote: { pricePounds: "-100" } }).success).toBe(false);
  });
  it("strips control characters and trims", () => {
    const r = jobDraftSchema.parse({ ...draft, title: "  Bath\u0000room\u0007 refit  " });
    expect(r.title).toBe("Bathroom refit");
  });
  it("keeps HTML as plain text (rendered escaped by React, never as HTML)", () => {
    const r = jobDraftSchema.parse({ ...draft, description: "<img src=x onerror=alert(1)>" });
    expect(r.description).toBe("<img src=x onerror=alert(1)>");
  });
  it("rejects over-long input and wrong types", () => {
    expect(jobDraftSchema.safeParse({ ...draft, title: "x".repeat(121) }).success).toBe(false);
    expect(jobDraftSchema.safeParse({ ...draft, title: 42 }).success).toBe(false);
    expect(jobDraftSchema.safeParse(null).success).toBe(false);
  });
});

describe("other schemas", () => {
  it("postcodes", () => {
    expect(normalisePostcode("sw1a1aa")).toBe("SW1A 1AA");
    expect(postcodeDistrict("M1 1AE")).toBe("M1");
    expect(normalisePostcode("12345")).toBeNull();
  });
  it("sign-up requires a 10+ character password and a known account type", () => {
    expect(signUpSchema.safeParse({ email: "a@b.co", password: "short", fullName: "A", accountType: "homeowner" }).success).toBe(false);
    expect(signUpSchema.safeParse({ email: "a@b.co", password: "longenough1", fullName: "A", accountType: "admin" }).success).toBe(false);
    expect(signUpSchema.safeParse({ email: "A@B.CO ", password: "longenough1", fullName: "A", accountType: "builder" }).data?.email).toBe("a@b.co");
  });
  it("builder application validates districts", () => {
    expect(builderApplicationSchema.safeParse({ companyName: "Acme", trades: ["roofing"], serviceDistricts: ["SE15"], phone: "07700 900000" }).success).toBe(true);
    expect(builderApplicationSchema.safeParse({ companyName: "Acme", trades: ["roofing"], serviceDistricts: ["; drop table"], phone: "07700 900000" }).success).toBe(false);
  });
  it("review decision bounds the beat percentage to 5-10%", () => {
    const base = { decision: "approve", standardScope: "x".repeat(30), publishMediaIds: [], expectedVersion: 1 };
    expect(reviewDecisionSchema.safeParse({ ...base, beatBasisPoints: 400 }).success).toBe(false);
    expect(reviewDecisionSchema.safeParse({ ...base, beatBasisPoints: 1100 }).success).toBe(false);
    expect(reviewDecisionSchema.safeParse({ ...base, beatBasisPoints: 800 }).success).toBe(true);
  });
  it("variation amounts parse negatives and reject zero", () => {
    expect(variationSchema.parse({ reason: "homeowner_requested", description: "Extra socket in hallway", amountPounds: "-120.50" }).amountPounds).toBe(-12_050);
    expect(variationSchema.safeParse({ reason: "homeowner_requested", description: "Extra socket in hallway", amountPounds: "0" }).success).toBe(false);
    expect(variationSchema.safeParse({ reason: "because", description: "Extra socket in hallway", amountPounds: "10" }).success).toBe(false);
  });
});
