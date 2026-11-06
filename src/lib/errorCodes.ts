/**
 * Stable error codes shared by server and browser. The browser shows the
 * user-facing message; internal details never leave the server.
 */
export const ERROR_MESSAGES = {
  UNAUTHENTICATED: "Please sign in to continue.",
  SESSION_EXPIRED: "Your session has expired. Please sign in again.",
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: "We couldn't find that.",
  VALIDATION_FAILED: "Some details need correcting.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  CSRF_FAILED: "This request could not be verified. Please refresh the page and try again.",
  CONFLICT: "This was changed by someone else. Please refresh and try again.",
  IDEMPOTENCY_IN_PROGRESS: "We're still processing your previous request. Please wait a moment.",
  IDEMPOTENCY_MISMATCH: "This request doesn't match the original. Please refresh and try again.",
  INVALID_TRANSITION: "That action isn't available at this stage.",
  JOB_NOT_AVAILABLE: "Sorry, this job is no longer available.",
  OFFER_EXPIRED: "This offer has expired.",
  BUILDER_NOT_APPROVED: "Your builder account must be approved before you can take jobs.",
  BELOW_MINIMUM_PRICE: "This job is below our minimum price for the trade.",
  UPLOAD_INVALID_TYPE: "That file type isn't supported. Please upload JPG, PNG, WEBP, PDF, MP4, MOV or WEBM.",
  UPLOAD_TOO_LARGE: "That file is too large.",
  UPLOAD_TOO_MANY: "You've reached the maximum number of files for this job.",
  UPLOAD_DUPLICATE: "You've already uploaded this file.",
  UPLOAD_CONTENT_MISMATCH: "That file's contents don't match its type. Please check the file and try again.",
  UPLOAD_INCOMPLETE: "The upload didn't finish. Please try again.",
  UPLOAD_EXPIRED: "The upload link expired. Please try again.",
  SUBMISSION_INCOMPLETE: "Please add your quote and at least one photo before submitting.",
  PAYMENT_UNAVAILABLE: "Payments are temporarily unavailable. Nothing has been charged. Please try again shortly.",
  PAYMENT_PENDING: "We're confirming your payment with our payment provider.",
  START_CONDITIONS_UNMET: "Work can't start until the contract, deposit and pre-start check are complete.",
  SERVICE_UNAVAILABLE: "The service is temporarily unavailable. Your details have been kept. Please try again.",
  TIMEOUT: "The request took too long. Your details have been kept. Please try again.",
  INTERNAL: "Something went wrong on our side. Your details have been kept. Please try again.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; fields?: Record<string, string>; requestId?: string };
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && value in ERROR_MESSAGES;
}
