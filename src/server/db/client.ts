import "server-only";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { config } from "../config";
import { log } from "../observability/logger";
import { withRetry, withTimeout } from "../domain/resilience";
import type { SessionUser } from "../authz/policies";

export type Tx = TransactionSql<Record<string, unknown>>;
export type Db = Sql<Record<string, unknown>>;

const globalForDb = globalThis as unknown as { __bmqSql?: Db };

/**
 * Server-only connection. Uses the database owner role (bypasses RLS) and is
 * therefore only used AFTER explicit authorisation checks in services. Reads on
 * behalf of a user can use withUserTx, which drops to the `authenticated` role
 * so Row Level Security applies as a second line of defence.
 */
export function db(): Db {
  if (!globalForDb.__bmqSql) {
    const cfg = config();
    globalForDb.__bmqSql = postgres(cfg.DATABASE_URL, {
      max: cfg.DATABASE_POOL_MAX,
      prepare: false, // compatible with Supabase's transaction pooler (pgbouncer)
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
      connection: { statement_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS, application_name: "bmq-web" },
      onnotice: () => {},
      transform: { ...postgres.camel, undefined: null },
    });
  }
  return globalForDb.__bmqSql;
}

/** Errors where the transaction certainly did not commit, so a retry is safe. */
function safeToRetry(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "40001" || code === "40P01" || code === "CONNECT_TIMEOUT" || code === "ECONNREFUSED";
}

export async function withServiceTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRetry(() => db().begin((tx) => fn(tx as unknown as Tx)) as Promise<T>, {
    retries: 2,
    retryOn: safeToRetry,
    onRetry: (err, attempt, delayMs) => log.warn("db.retry", { attempt, delayMs, code: (err as { code?: string }).code }),
  });
}

/** Runs queries as the given user under RLS, exactly as Supabase's API would. */
export async function withUserTx<T>(user: SessionUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRetry(
    () =>
      db().begin(async (raw) => {
        const tx = raw as unknown as Tx;
        const claims = JSON.stringify({ sub: user.id, role: "authenticated", email: user.email });
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx`set local role authenticated`;
        return fn(tx);
      }) as Promise<T>,
    { retries: 2, retryOn: safeToRetry },
  );
}

export async function pingDatabase(timeoutMs = 2000): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await withTimeout("db.ping", timeoutMs, () => db()`select 1`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as { code?: string }).code ?? "unavailable" };
  }
}

export async function closeDb(): Promise<void> {
  await globalForDb.__bmqSql?.end({ timeout: 5 });
  globalForDb.__bmqSql = undefined;
}
