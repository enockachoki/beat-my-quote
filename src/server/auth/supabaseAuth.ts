import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { AuthIdentity, AuthProvider, SessionState } from "./types";

/**
 * Supabase Auth via @supabase/ssr (HttpOnly cookie sessions, refresh handled by
 * the library). Supabase also applies its own auth rate limits.
 * Status: implemented, not yet verified against a live project.
 */
export class SupabaseAuthProvider implements AuthProvider {
  readonly name = "supabase" as const;
  constructor(private readonly url: string, private readonly anonKey: string) {}

  private async client() {
    const jar = await cookies();
    return createServerClient(this.url, this.anonKey, {
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (items) => {
          try {
            for (const { name, value, options } of items) jar.set(name, value, { ...options, httpOnly: true, sameSite: "lax", secure: true });
          } catch {
            // Called from a Server Component: cookies can't be set there; the proxy refreshes them.
          }
        },
      },
    });
  }

  async readSession(): Promise<SessionState> {
    const jar = await cookies();
    const hadCookie = jar.getAll().some((c) => c.name.startsWith("sb-"));
    const supabase = await this.client();
    // getUser() validates the token with Supabase rather than trusting the cookie.
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return hadCookie ? { state: "expired" } : { state: "none" };
    return { state: "active", identity: { id: data.user.id, email: data.user.email ?? "" } };
  }

  async signIn(email: string, password: string): Promise<AuthIdentity | null> {
    const { data, error } = await (await this.client()).auth.signInWithPassword({ email, password });
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? email };
  }

  async signUp(email: string, password: string) {
    const { data, error } = await (await this.client()).auth.signUp({ email, password });
    if (error) return { error: error.code === "weak_password" ? ("WEAK_PASSWORD" as const) : ("EMAIL_TAKEN" as const) };
    if (!data.user) return { error: "EMAIL_TAKEN" as const };
    return { identity: { id: data.user.id, email } };
  }

  async signOut(): Promise<void> {
    await (await this.client()).auth.signOut();
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    await (await this.client()).auth.resetPasswordForEmail(email, { redirectTo });
  }

  async confirmPasswordReset(code: string, newPassword: string): Promise<boolean> {
    const supabase = await this.client();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return false;
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    return !updateError;
  }
}
