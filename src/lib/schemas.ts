import { z } from "zod";
import { parsePoundsToPence } from "./money";

/** Validation shared by browser forms and API routes. The server always re-validates. */

export const TRADES = [
  "bathroom-refit",
  "boiler-replacement",
  "kitchen-fitting",
  "plastering",
  "painting-decorating",
  "roofing",
] as const;
export type Trade = (typeof TRADES)[number];
export const TRADE_LABELS: Record<Trade, string> = {
  "bathroom-refit": "Bathroom refit",
  "boiler-replacement": "Boiler replacement (like for like)",
  "kitchen-fitting": "Kitchen fitting",
  plastering: "Plastering",
  "painting-decorating": "Painting and decorating",
  roofing: "Roofing",
};

const POSTCODE_RE = /^([A-Z]{1,2}[0-9][0-9A-Z]?) ?([0-9][A-Z]{2})$/;

export function normalisePostcode(input: string): string | null {
  const compact = input.toUpperCase().replace(/\s+/g, "");
  const m = POSTCODE_RE.exec(compact);
  return m ? `${m[1]} ${m[2]}` : null;
}

export function postcodeDistrict(postcode: string): string | null {
  const normalised = normalisePostcode(postcode);
  return normalised ? normalised.split(" ")[0]! : null;
}

/** Plain text only: trims, normalises newlines and strips control characters. */
const plainText = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim())
    .pipe(z.string().min(min, min > 0 ? `Please enter at least ${min} characters` : undefined).max(max, `Please keep this under ${max} characters`));

export const postcodeSchema = z
  .string()
  .transform((s, ctx) => {
    const p = normalisePostcode(s);
    if (!p) {
      ctx.addIssue({ code: "custom", message: "Please enter a valid UK postcode" });
      return z.NEVER;
    }
    return p;
  });

export const poundsSchema = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const pence = parsePoundsToPence(String(v));
  if (pence === null) {
    ctx.addIssue({ code: "custom", message: "Please enter an amount in pounds, for example 4500 or 4,500.00" });
    return z.NEVER;
  }
  return pence;
});

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Please enter a valid email address").max(254));
export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128, "Use at most 128 characters");

export const signInSchema = z.object({ email: emailSchema, password: z.string().min(1, "Please enter your password").max(128) });
export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: plainText(1, 120),
  accountType: z.enum(["homeowner", "builder"]),
});
export const resetRequestSchema = z.object({ email: emailSchema });
export const resetConfirmSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });

export const uuidSchema = z.uuid();
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);

export const jobDraftSchema = z.object({
  trade: z.enum(TRADES, { message: "Please choose a trade" }),
  title: plainText(3, 120),
  description: plainText(0, 4000),
  address: z.object({
    line1: plainText(1, 200),
    line2: plainText(0, 200).optional(),
    town: plainText(1, 100),
    postcode: postcodeSchema,
  }),
  quote: z.object({
    pricePounds: poundsSchema.pipe(z.number().int().min(10000, "Quotes must be at least £100").max(100000000, "Please contact us for jobs over £1,000,000")),
    rivalCompanyName: plainText(0, 160).optional(),
    quoteDate: z.iso.date().optional().or(z.literal("").transform(() => undefined)),
  }),
});
export type JobDraftInput = z.input<typeof jobDraftSchema>;
export type JobDraft = z.output<typeof jobDraftSchema>;

export const submitJobSchema = z.object({ consentAccuracy: z.literal(true, { message: "Please confirm" }), consentSharing: z.literal(true, { message: "Please confirm" }) });

export const builderApplicationSchema = z.object({
  companyName: plainText(2, 160),
  companiesHouseNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{8}$/, "Companies House numbers have 8 characters")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  trades: z.array(z.enum(TRADES)).min(1, "Choose at least one trade").max(10),
  serviceDistricts: z
    .array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,2}[0-9][0-9A-Z]?$/, "Use postcode districts like SE15"))
    .min(1, "Add at least one postcode district")
    .max(50),
  phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, "Please enter a valid phone number"),
  insuranceExpiresOn: z.iso.date().optional().or(z.literal("").transform(() => undefined)),
});

export const builderDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), kind: z.enum(["crew", "partner"]) }),
  z.object({ decision: z.literal("reject"), reason: plainText(3, 500) }),
  z.object({ decision: z.literal("suspend"), reason: plainText(3, 500) }),
]);

export const reviewDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    standardScope: plainText(20, 8000),
    beatBasisPoints: z.number().int().min(500).max(1000),
    publishMediaIds: z.array(z.uuid()).max(50),
    expectedVersion: z.number().int().positive(),
  }),
  z.object({ decision: z.literal("reject"), reason: plainText(3, 1000), expectedVersion: z.number().int().positive() }),
]);

export const mediaIntentSchema = z.object({
  kind: z.enum(["photo", "video", "quote_document", "quote_redacted"]),
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        size: z.number().int().positive(),
        type: z.string().max(100),
        fingerprint: z.string().min(8).max(300),
      }),
    )
    .min(1)
    .max(30),
});

export const acceptOfferSchema = z.object({
  termsVersion: z.string().min(1).max(40),
  agreeToContract: z.literal(true, { message: "Please agree to the Job Contract" }),
});

export const prestartSchema = z.object({
  outcome: z.enum(["confirmed", "variation_required"]),
  notes: plainText(0, 4000).optional(),
});

export const variationSchema = z.object({
  reason: z.enum(["not_reasonably_visible", "homeowner_requested"]),
  description: plainText(10, 4000),
  amountPounds: z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const s = String(v).trim();
      const negative = s.startsWith("-");
      const pence = parsePoundsToPence(negative ? s.slice(1) : s);
      if (pence === null || pence === 0) {
        ctx.addIssue({ code: "custom", message: "Enter a non-zero amount in pounds (use - for a reduction)" });
        return z.NEVER;
      }
      return negative ? -pence : pence;
    }),
});

export const variationDecisionSchema = z.object({ decision: z.enum(["approve", "decline"]) });

export const paginationSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const clientErrorSchema = z.object({
  message: z.string().max(500),
  digest: z.string().max(100).optional(),
  path: z.string().max(300).optional(),
  requestId: z.string().max(100).optional(),
});
