import "server-only";
import { createHash } from "node:crypto";
import { config } from "../config";
import { db } from "../db/client";
import { AppError } from "../errors";
import { log } from "../observability/logger";

export interface RateRule { name: string; max: number; windowSeconds: number; scalableInTests?: boolean }

export const RULES = {
  signIn: { name: "sign_in", max: 5, windowSeconds: 15 * 60 },
  signInIp: { name: "sign_in_ip", max: 30, windowSeconds: 15 * 60, scalableInTests: true },
  signUp: { name: "sign_up", max: 5, windowSeconds: 60 * 60 },
  passwordReset: { name: "pw_reset", max: 3, windowSeconds: 60 * 60 },
  mutation: { name: "mutation", max: 60, windowSeconds: 60, scalableInTests: true },
  uploadIntent: { name: "upload_intent", max: 30, windowSeconds: 60, scalableInTests: true },
  clientError: { name: "client_error", max: 20, windowSeconds: 60, scalableInTests: true },
  claim: { name: "claim", max: 10, windowSeconds: 60, scalableInTests: true },
} satisfies Record<string, RateRule>;

/** Keys are hashed so emails/IPs are not stored in clear in rate_limits. */
function bucketKey(rule: RateRule, subject: string): string {
  return `${rule.name}:${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
}

/**
 * Enforces a rate limit backed by Postgres (works across serverless instances).
 * If the database is unavailable we fail CLOSED for auth endpoints and OPEN for
 * others, since an outage will fail those requests anyway.
 */
export async function enforceRateLimit(rule: RateRule, subject: string, opts: { failClosed?: boolean } = {}): Promise<void> {
  let result: { allowed: boolean; resetAt: Date } | undefined;
  const max = rule.scalableInTests ? rule.max * config().RATE_LIMIT_MULTIPLIER : rule.max;
  try {
    const [row] = await db()<{ allowed: boolean; resetAt: Date }[]>`
      select allowed, reset_at from public.rate_limit_hit(${bucketKey(rule, subject)}, ${max}, ${rule.windowSeconds})`;
    result = row;
  } catch (err) {
    log.warn("rate_limit.unavailable", { rule: rule.name, err });
    if (opts.failClosed) throw new AppError("SERVICE_UNAVAILABLE", { cause: err });
    return;
  }
  if (result && !result.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000));
    log.warn("rate_limit.exceeded", { rule: rule.name });
    throw new AppError("RATE_LIMITED", { retryAfterSeconds });
  }
}

/**
 * Clears one bucket. Used after a successful sign-in so the per-account limit
 * counts failed attempts only and a person signing in often is never locked out.
 */
export async function clearRateLimit(rule: RateRule, subject: string): Promise<void> {
  try {
    await db()`delete from public.rate_limits where bucket = ${bucketKey(rule, subject)}`;
  } catch (err) {
    log.warn("rate_limit.clear_failed", { rule: rule.name, err });
  }
}
