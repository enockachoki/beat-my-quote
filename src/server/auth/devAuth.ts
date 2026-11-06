import "server-only";
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { db } from "../db/client";
import { config } from "../config";
import type { AuthIdentity, AuthProvider, SessionState } from "./types";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const SESSION_COOKIE = "bmq_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Used to keep timing similar when the email doesn't exist.
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

interface SessionPayload { sub: string; email: string; iat: number; exp: number; sid: string }

export function signSession(secret: string, p: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function parseSession(secret: string, value: string, now = Date.now()): SessionState {
  const [body, mac] = value.split(".");
  if (!body || !mac) return { state: "none" };
  // Canonical text compare (see storage/signing.ts): decoded bytes ignore spare bits.
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { state: "none" };
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (p.exp * 1000 <= now) return { state: "expired" };
    return { state: "active", identity: { id: p.sub, email: p.email } };
  } catch {
    return { state: "none" };
  }
}

/**
 * DEVELOPMENT/E2E ONLY auth provider (refused in production by config). It
 * mirrors the security properties we rely on from Supabase Auth: hashed
 * passwords, signed HttpOnly session cookies with expiry, non-enumerating
 * password reset with single-use hashed tokens.
 */
export class DevAuthProvider implements AuthProvider {
  readonly name = "dev" as const;
  constructor(private readonly secret: string, private readonly secureCookies: boolean) {}

  async readSession(): Promise<SessionState> {
    const jar = await cookies();
    const value = jar.get(SESSION_COOKIE)?.value;
    if (!value) return { state: "none" };
    return parseSession(this.secret, value);
  }

  private async setSession(identity: AuthIdentity): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const token = signSession(this.secret, { sub: identity.id, email: identity.email, iat: now, exp: now + SESSION_TTL_SECONDS, sid: randomBytes(12).toString("base64url") });
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, { httpOnly: true, secure: this.secureCookies, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS });
  }

  async signIn(email: string, password: string): Promise<AuthIdentity | null> {
    const [row] = await db()<{ userId: string; email: string; passwordHash: string }[]>`
      select user_id, email, password_hash from public.dev_credentials where email = ${email}`;
    const ok = await verifyPassword(password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !ok) return null;
    const identity = { id: row.userId, email: row.email };
    await this.setSession(identity);
    return identity;
  }

  async signUp(email: string, password: string) {
    const hash = await hashPassword(password);
    const sql = db();
    const created = await sql.begin(async (tx) => {
      const [u] = await tx<{ id: string }[]>`insert into auth.users (email) values (${email}) on conflict (email) do nothing returning id`;
      if (!u) return null;
      await tx`insert into public.dev_credentials (user_id, email, password_hash) values (${u.id}, ${email}, ${hash})`;
      return u.id;
    });
    if (!created) return { error: "EMAIL_TAKEN" as const };
    const identity = { id: created, email };
    await this.setSession(identity);
    return { identity };
  }

  async signOut(): Promise<void> {
    (await cookies()).delete(SESSION_COOKIE);
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    const rows = await db()`
      update public.dev_credentials set reset_token_hash = ${hash}, reset_expires_at = now() + interval '30 minutes'
      where email = ${email} returning user_id`;
    if (rows.length > 0 && config().APP_ENV !== "production") {
      // Dev only: there is no email provider, so print the link to the server console.
      console.warn(`[dev-auth] password reset link: ${redirectTo}?token=${token}`);
    }
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<boolean> {
    const hash = createHash("sha256").update(token).digest("hex");
    const newHash = await hashPassword(newPassword);
    const rows = await db()`
      update public.dev_credentials set password_hash = ${newHash}, reset_token_hash = null, reset_expires_at = null
      where reset_token_hash = ${hash} and reset_expires_at > now() returning user_id`;
    return rows.length === 1;
  }
}
