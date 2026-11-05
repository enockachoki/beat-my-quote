import "server-only";
import { z } from "zod";

/**
 * Server configuration. Read once, validated, and never sent to the browser.
 * Only variables prefixed NEXT_PUBLIC_ may reach client bundles, and none of
 * those are secrets.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Deployment environment. Production safety checks key off this, not NODE_ENV
    // (which is "production" for any optimised build, including local E2E runs).
    // Defaults to production for production builds, so forgetting it fails safe.
    APP_ENV: z.enum(["development", "test", "staging", "production"]).optional(),
    APP_ORIGIN: z.url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@localhost:5432/bmq_dev"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),

    AUTH_PROVIDER: z.enum(["supabase", "dev"]).default("dev"),
    SESSION_SECRET: z.string().min(32).optional(), // dev auth cookie signing
    NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    STORAGE_PROVIDER: z.enum(["supabase", "local"]).default("local"),
    LOCAL_STORAGE_DIR: z.string().default(".dev-storage"),
    STORAGE_SIGNING_SECRET: z.string().min(32).optional(),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
    UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(7200).default(900),

    PAYMENT_PROVIDER: z.enum(["stripe", "fake"]).default("fake"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    FAKE_PAYMENT_WEBHOOK_SECRET: z.string().min(16).optional(),

    EMAIL_PROVIDER: z.enum(["resend", "console"]).default("console"),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default("Beat My Quote <no-reply@example.invalid>"),
    SMS_PROVIDER: z.enum(["twilio", "console"]).default("console"),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM: z.string().optional(),

    MALWARE_SCANNER_URL: z.url().optional(),
    CRON_SECRET: z.string().min(32).optional(),
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    // Test-only: scales the per-minute API limits (never the sign-in limits) so
    // parallel browser tests do not trip each other. Rejected outside APP_ENV=test.
    RATE_LIMIT_MULTIPLIER: z.coerce.number().int().min(1).max(100).default(1),

    // Business parameters. Placeholder values pending owner decisions.
    CREW_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PARTNER_WINDOW_HOURS: z.coerce.number().int().min(1).max(336).default(72),
    OFFER_ACCEPT_HOURS: z.coerce.number().int().min(1).max(336).default(72),
    DEPOSIT_BASIS_POINTS: z.coerce.number().int().min(100).max(2500).default(1000),
    SUCCESS_FEE_BASIS_POINTS: z.coerce.number().int().min(0).max(3000).default(0),
    MINIMUM_JOB_PRICE_PENCE: z.coerce.number().int().min(0).default(50000),
    CONTRACT_TERMS_VERSION: z.string().default("draft-2026-11"),
  })
  .transform((env) => ({ ...env, APP_ENV: env.APP_ENV ?? (env.NODE_ENV === "production" ? "production" : "development") }))
  .superRefine((env, ctx) => {
    if (env.APP_ENV === "production") {
      const need = (cond: boolean, key: string) => {
        if (!cond) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required in production` });
      };
      need(env.AUTH_PROVIDER === "supabase", "AUTH_PROVIDER");
      need(env.STORAGE_PROVIDER === "supabase", "STORAGE_PROVIDER");
      need(env.PAYMENT_PROVIDER === "stripe", "PAYMENT_PROVIDER");
      need(!!env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
      need(!!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET");
      need(!!env.CRON_SECRET, "CRON_SECRET");
      need(env.APP_ORIGIN.startsWith("https://"), "APP_ORIGIN");
    }
    if (env.RATE_LIMIT_MULTIPLIER !== 1 && env.APP_ENV !== "test") {
      ctx.addIssue({ code: "custom", path: ["RATE_LIMIT_MULTIPLIER"], message: "RATE_LIMIT_MULTIPLIER is only allowed when APP_ENV=test" });
    }
    if (env.AUTH_PROVIDER === "dev" && !env.SESSION_SECRET && env.APP_ENV !== "test") {
      ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "SESSION_SECRET is required for dev auth" });
    }
  });

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function config(): AppConfig {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      // Report which keys are wrong, never their values.
      const keys = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid server configuration: ${keys}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetConfigForTests(overrides: Partial<Record<keyof AppConfig, string>> = {}): void {
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  cached = undefined;
}
