import { backoffDelayMs } from "@/lib/backoff";

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(label: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries: number;
  baseMs?: number;
  maxMs?: number;
  /** Decide whether an error is safe to retry. Default: never. */
  retryOn: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Retries with exponential backoff and full jitter. Only use for operations
 * that are idempotent. Payments are NOT retried with this helper: their
 * provider status is verified instead (see services/paymentService.ts).
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !opts.retryOn(err, attempt)) throw err;
      const delay = backoffDelayMs(attempt, opts.baseMs ?? 200, opts.maxMs ?? 5000, opts.random);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

/** Transient = network / connection / timeout style failures. */
export function isTransient(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const code = (err as { code?: string } | null)?.code;
  if (!code) return false;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "CONNECTION_CLOSED", "CONNECT_TIMEOUT", "CONNECTION_ENDED", "57P01", "53300", "08006", "08001", "40001", "40P01"].includes(code);
}
