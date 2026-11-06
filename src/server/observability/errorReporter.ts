import { log, redact, requestContext } from "./logger";

/**
 * Error-monitoring seam. When SENTRY_DSN is configured, wire @sentry/nextjs in
 * here (see TECHNICAL_SECURITY_AUDIT.md). Until then errors go to structured
 * logs only. We never claim Sentry is connected without a DSN.
 */
export interface ErrorReporter {
  capture(err: unknown, context?: Record<string, unknown>): void;
  readonly connected: boolean;
}

const logReporter: ErrorReporter = {
  connected: false,
  capture(err, context) {
    log.error("exception", { err: redact(err), stack: err instanceof Error ? err.stack?.split("\n").slice(0, 8).join("\n") : undefined, ...context, requestId: requestContext.getStore()?.requestId });
  },
};

let reporter: ErrorReporter = logReporter;
export function setErrorReporter(r: ErrorReporter): void {
  reporter = r;
}
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  try {
    reporter.capture(err, context);
  } catch {
    // Reporting must never throw.
  }
}
export function errorReporterConnected(): boolean {
  return reporter.connected;
}
