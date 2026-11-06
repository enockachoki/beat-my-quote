import "server-only";
import { auth } from "../auth";
import { config } from "../config";
import { withServiceTx } from "../db/client";
import { AppError } from "../errors";
import { log } from "../observability/logger";
import { audit, SYSTEM_ACTOR } from "./audit";
import { clearRateLimit, enforceRateLimit, RULES } from "./rateLimit";

export async function signUp(input: { email: string; password: string; fullName: string; accountType: "homeowner" | "builder" }, ip: string) {
  await enforceRateLimit(RULES.signUp, `ip:${ip}`, { failClosed: true });
  const result = await auth().signUp(input.email, input.password);
  if ("error" in result) {
    // Same response for "taken" to avoid account enumeration; weak password is safe to report.
    if (result.error === "WEAK_PASSWORD") throw new AppError("VALIDATION_FAILED", { fields: { password: "Please choose a stronger password" } });
    throw new AppError("VALIDATION_FAILED", { fields: { email: "We couldn't create an account with this email. Try signing in or resetting your password." } });
  }
  await withServiceTx(async (tx) => {
    await tx`
      insert into public.profiles (id, role, full_name) values (${result.identity.id}, ${input.accountType}, ${input.fullName})
      on conflict (id) do nothing`;
    await audit(tx, { id: result.identity.id, role: input.accountType, email: input.email }, "auth.sign_up", "profile", result.identity.id, { accountType: input.accountType });
  });
  return { id: result.identity.id, role: input.accountType };
}

export async function signIn(email: string, password: string, ip: string) {
  // Per-account and per-IP limits defeat both targeted and spraying brute force.
  await enforceRateLimit(RULES.signIn, `email:${email}`, { failClosed: true });
  await enforceRateLimit(RULES.signInIp, `ip:${ip}`, { failClosed: true });
  const identity = await auth().signIn(email, password);
  if (!identity) {
    log.warn("auth.sign_in_failed", { email });
    await withServiceTx((tx) => audit(tx, SYSTEM_ACTOR, "auth.sign_in_failed", "auth", null, { email })).catch(() => {});
    throw new AppError("VALIDATION_FAILED", { fields: { _: "Email or password is incorrect." } });
  }
  await clearRateLimit(RULES.signIn, `email:${email}`);
  log.info("auth.sign_in", { userId: identity.id });
  return identity;
}

export async function signOut() {
  await auth().signOut();
}

export async function requestPasswordReset(email: string, ip: string) {
  await enforceRateLimit(RULES.passwordReset, `email:${email}`, { failClosed: true });
  await enforceRateLimit(RULES.signInIp, `ip:${ip}`, { failClosed: true });
  try {
    await auth().requestPasswordReset(email, `${config().APP_ORIGIN}/reset-password`);
  } catch (err) {
    log.error("auth.reset_request_failed", { err });
  }
  // Always the same response, whether or not the account exists.
}

export async function confirmPasswordReset(token: string, password: string, ip: string) {
  await enforceRateLimit(RULES.passwordReset, `ip:${ip}`, { failClosed: true });
  const ok = await auth().confirmPasswordReset(token, password);
  if (!ok) throw new AppError("VALIDATION_FAILED", { fields: { token: "This reset link is invalid or has expired. Please request a new one." } });
}
