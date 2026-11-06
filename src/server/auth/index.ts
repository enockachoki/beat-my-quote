import "server-only";
import { cache } from "react";
import { config } from "../config";
import { db } from "../db/client";
import { AppError } from "../errors";
import type { Role, SessionUser } from "../authz/policies";
import { DevAuthProvider } from "./devAuth";
import { SupabaseAuthProvider } from "./supabaseAuth";
import type { AuthProvider } from "./types";

let provider: AuthProvider | undefined;

export function auth(): AuthProvider {
  if (!provider) {
    const cfg = config();
    if (cfg.AUTH_PROVIDER === "supabase") {
      if (!cfg.NEXT_PUBLIC_SUPABASE_URL || !cfg.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error("Supabase auth is not configured");
      provider = new SupabaseAuthProvider(cfg.NEXT_PUBLIC_SUPABASE_URL, cfg.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    } else {
      if (cfg.APP_ENV === "production") throw new Error("Dev auth is not allowed in production");
      provider = new DevAuthProvider(cfg.SESSION_SECRET ?? "test-only-secret-test-only-secret-000", cfg.APP_ORIGIN.startsWith("https://"));
    }
  }
  return provider;
}

export type CurrentUser = { state: "none" } | { state: "expired" } | { state: "active"; user: SessionUser };

/**
 * Resolves the signed-in user. The ROLE always comes from our profiles table,
 * never from token claims or user metadata (which users can edit).
 */
export const currentUser = cache(async (): Promise<CurrentUser> => {
  const session = await auth().readSession();
  if (session.state !== "active") return session;
  const [profile] = await db()<{ role: Role }[]>`select role from public.profiles where id = ${session.identity.id}`;
  if (!profile) return { state: "none" };
  return { state: "active", user: { id: session.identity.id, email: session.identity.email, role: profile.role } };
});

export async function requireUser(): Promise<SessionUser> {
  const cu = await currentUser();
  if (cu.state === "expired") throw new AppError("SESSION_EXPIRED");
  if (cu.state !== "active") throw new AppError("UNAUTHENTICATED");
  return cu.user;
}
