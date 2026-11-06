export interface AuthIdentity { id: string; email: string }
export type SessionState = { state: "none" } | { state: "expired" } | { state: "active"; identity: AuthIdentity };

export interface AuthProvider {
  readonly name: "supabase" | "dev";
  readSession(): Promise<SessionState>;
  signIn(email: string, password: string): Promise<AuthIdentity | null>;
  signUp(email: string, password: string): Promise<{ identity: AuthIdentity } | { error: "EMAIL_TAKEN" | "WEAK_PASSWORD" }>;
  signOut(): Promise<void>;
  /** Always resolves the same way whether or not the email exists (no account enumeration). */
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  confirmPasswordReset(token: string, newPassword: string): Promise<boolean>;
}
