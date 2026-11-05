"use client";

import { backoffDelayMs } from "@/lib/backoff";
import { ERROR_MESSAGES, isErrorCode, type ErrorCode } from "@/lib/errorCodes";

export interface ApiError { code: ErrorCode; message: string; fields?: Record<string, string>; requestId?: string; status: number }
export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; error: ApiError };

interface Options {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** The server treats this POST as idempotent (e.g. "complete upload"), so retries are safe. */
  retrySafe?: boolean;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function sessionExpired(): void {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  // Full navigation on purpose: drops all client state tied to the old session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/sign-in?expired=1&next=${next}`);
}

/**
 * Fetch wrapper used by every client component:
 * - timeouts on every request;
 * - retries with backoff + jitter ONLY when safe (GET, or a request carrying
 *   an Idempotency-Key the server deduplicates);
 * - maps failures to friendly, typed errors (never raw technical messages);
 * - sends the user to sign in again when the session has expired.
 */
export async function api<T>(path: string, opts: Options = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? "GET";
  const safeToRetry = method === "GET" || !!opts.idempotencyKey || !!opts.retrySafe;
  const retries = opts.retries ?? (safeToRetry ? 2 : 0);
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.ok) return { ok: true, data: json as T, status: res.status };
      const errBody = (json as { error?: { code?: string; message?: string; fields?: Record<string, string>; requestId?: string } } | null)?.error;
      const code: ErrorCode = isErrorCode(errBody?.code) ? errBody.code : res.status >= 500 ? "INTERNAL" : "VALIDATION_FAILED";
      if (code === "SESSION_EXPIRED") sessionExpired();
      const retryable = res.status === 503 || res.status === 504 || res.status === 502 || code === "IDEMPOTENCY_IN_PROGRESS";
      if (retryable && safeToRetry && attempt < retries) {
        await new Promise((r) => setTimeout(r, Math.max(500, backoffDelayMs(attempt, 500, 4000))));
        continue;
      }
      return { ok: false, error: { code, message: errBody?.message ?? ERROR_MESSAGES[code], fields: errBody?.fields, requestId: errBody?.requestId, status: res.status } };
    } catch (err) {
      const aborted = opts.signal?.aborted;
      if (!aborted && safeToRetry && attempt < retries) {
        await new Promise((r) => setTimeout(r, Math.max(500, backoffDelayMs(attempt, 500, 4000))));
        continue;
      }
      const timedOut = (err as Error).name === "AbortError" && !aborted;
      const code: ErrorCode = timedOut ? "TIMEOUT" : "SERVICE_UNAVAILABLE";
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      return { ok: false, error: { code, message: offline ? "You appear to be offline. Your details have been kept. Please reconnect and try again." : ERROR_MESSAGES[code], status: 0 } };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function reportClientError(message: string, extra: { digest?: string; requestId?: string } = {}): void {
  try {
    const body = JSON.stringify({ message: message.slice(0, 500), path: window.location.pathname.slice(0, 300), ...extra });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/client-errors", new Blob([body], { type: "application/json" }));
  } catch {
    // never throw from error reporting
  }
}
