import "server-only";
import { createHash } from "node:crypto";
import { db } from "../db/client";
import { AppError } from "../errors";

export interface StoredResponse { status: number; body: unknown }

export function hashRequest(route: string, body: unknown): string {
  return createHash("sha256").update(route).update("\n").update(JSON.stringify(body ?? null)).digest("hex");
}

/**
 * Idempotency-Key handling for sensitive POSTs (submissions, claims, offer
 * acceptance, payments). The first request reserves the key; repeats with the
 * same body get the stored response; a different body with the same key is
 * rejected; a repeat while the first is still running gets 409.
 */
export async function runIdempotent(
  userId: string,
  key: string,
  route: string,
  body: unknown,
  fn: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const requestHash = hashRequest(route, body);
  const sql = db();
  const reserved = await sql`
    insert into public.idempotency_keys (user_id, key, route, request_hash) values (${userId}, ${key}, ${route}, ${requestHash})
    on conflict (user_id, key) do nothing returning key`;
  if (reserved.length === 0) {
    const [existing] = await sql<{ route: string; requestHash: string; state: string; responseStatus: number | null; responseBody: unknown; createdAt: Date }[]>`
      select route, request_hash, state, response_status, response_body, created_at from public.idempotency_keys where user_id = ${userId} and key = ${key}`;
    if (!existing) throw new AppError("CONFLICT");
    if (existing.route !== route || existing.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_MISMATCH");
    if (existing.state === "completed") return { status: existing.responseStatus ?? 200, body: existing.responseBody, replayed: true };
    // A crashed request leaves the key in progress; let it be retried after 2 minutes.
    if (Date.now() - new Date(existing.createdAt).getTime() < 120_000) throw new AppError("IDEMPOTENCY_IN_PROGRESS", { retryAfterSeconds: 2 });
    await sql`update public.idempotency_keys set created_at = now() where user_id = ${userId} and key = ${key}`;
  }
  try {
    const res = await fn();
    // Only store successful or definitive client errors; transient errors release the key.
    await sql`
      update public.idempotency_keys set state = 'completed', response_status = ${res.status}, response_body = ${sql.json(res.body as never)}
      where user_id = ${userId} and key = ${key}`;
    return { ...res, replayed: false };
  } catch (err) {
    if (err instanceof AppError && err.status >= 400 && err.status < 500 && err.code !== "RATE_LIMITED" && err.code !== "CONFLICT") {
      const body = { error: { code: err.code, message: err.message, fields: err.fields } };
      await sql`
        update public.idempotency_keys set state = 'completed', response_status = ${err.status}, response_body = ${sql.json(body as never)}
        where user_id = ${userId} and key = ${key}`.catch(() => {});
    } else {
      await sql`delete from public.idempotency_keys where user_id = ${userId} and key = ${key} and state = 'in_progress'`.catch(() => {});
    }
    throw err;
  }
}
