import { ERROR_MESSAGES, type ErrorCode } from "@/lib/errorCodes";
import type { ZodError } from "zod";

const STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  BUILDER_NOT_APPROVED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  UPLOAD_INVALID_TYPE: 422,
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_TOO_MANY: 422,
  UPLOAD_CONTENT_MISMATCH: 422,
  UPLOAD_INCOMPLETE: 422,
  UPLOAD_EXPIRED: 410,
  SUBMISSION_INCOMPLETE: 422,
  BELOW_MINIMUM_PRICE: 422,
  UPLOAD_DUPLICATE: 409,
  CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  IDEMPOTENCY_MISMATCH: 422,
  INVALID_TRANSITION: 409,
  JOB_NOT_AVAILABLE: 409,
  OFFER_EXPIRED: 410,
  START_CONDITIONS_UNMET: 409,
  RATE_LIMITED: 429,
  PAYMENT_PENDING: 202,
  PAYMENT_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 504,
  INTERNAL: 500,
};

/** An expected, user-safe error. `internal` is for logs only and never returned. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string>;
  readonly internal?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    opts: { fields?: Record<string, string>; internal?: string; cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(ERROR_MESSAGES[code], { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code] ?? 400;
    this.fields = opts.fields;
    this.internal = opts.internal;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export function fromZod(error: ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!fields[key]) fields[key] = issue.message;
  }
  return new AppError("VALIDATION_FAILED", { fields });
}

/** Maps database exceptions raised by our triggers/constraints to AppErrors. */
export function fromDatabase(err: unknown): AppError | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: string; message?: string; constraint_name?: string };
  if (e.code === "P0001" && e.message) {
    if (e.message.startsWith("INVALID_JOB_TRANSITION")) return new AppError("INVALID_TRANSITION", { internal: e.message });
    if (e.message.startsWith("START_")) return new AppError("START_CONDITIONS_UNMET", { internal: e.message });
    if (e.message === "CONTRACT_IMMUTABLE") return new AppError("FORBIDDEN", { internal: e.message });
  }
  if (e.code === "23505") {
    if (e.constraint_name === "offers_one_live_per_job") return new AppError("JOB_NOT_AVAILABLE", { internal: e.constraint_name });
    if (e.constraint_name === "media_no_duplicate_uploads") return new AppError("UPLOAD_DUPLICATE", { internal: e.constraint_name });
    return new AppError("CONFLICT", { internal: e.constraint_name });
  }
  if (e.code === "23514" || e.code === "22P02" || e.code === "23503") return new AppError("VALIDATION_FAILED", { internal: e.constraint_name ?? e.code });
  if (e.code === "57014") return new AppError("TIMEOUT", { internal: "statement timeout" });
  if (e.code === "40001" || e.code === "40P01") return new AppError("CONFLICT", { internal: e.code });
  if (e.code && /^(08|53|57P)/.test(e.code)) return new AppError("SERVICE_UNAVAILABLE", { internal: e.code });
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "CONNECTION_CLOSED", "CONNECT_TIMEOUT", "CONNECTION_ENDED"].includes(e.code ?? ""))
    return new AppError("SERVICE_UNAVAILABLE", { internal: e.code });
  return null;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return fromDatabase(err) ?? new AppError("INTERNAL", { cause: err, internal: err instanceof Error ? err.message : String(err) });
}
