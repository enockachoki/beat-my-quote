import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-signed, expiring tokens for the local dev storage emulator. */
export interface StorageToken { p: string; op: "put" | "tus" | "get"; exp: number; max?: number; ct?: string }

export function signToken(secret: string, t: StorageToken): string {
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken(secret: string, token: string, op: StorageToken["op"], now = Date.now()): StorageToken | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  // Compare the canonical text, not decoded bytes: base64 decoders ignore the
  // spare bits of the last character, so a byte compare would accept altered tokens.
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StorageToken;
    if (t.op !== op || typeof t.p !== "string" || t.exp * 1000 < now) return null;
    if (t.p.includes("..") || t.p.startsWith("/")) return null;
    return t;
  } catch {
    return null;
  }
}
