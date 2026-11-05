import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structured JSON logger with recursive redaction. Never log passwords,
 * tokens, payment secrets or unnecessary personal data.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface RequestContext {
  requestId: string;
  userId?: string;
  route?: string;
}
export const requestContext = new AsyncLocalStorage<RequestContext>();

const SECRET_KEY = /pass(word)?|secret|token|authori[sz]ation|cookie|api[-_]?key|signature|card|cvc|iban|session|jwt|client_secret/i;
const PII_KEY = /^(email|phone|line1|line2|address|postcode|full_?name|ip)$/i;

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain || !user) return "[redacted]";
  return `${user.slice(0, 1)}***@${domain}`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Scrub bearer tokens / JWT-like strings that appear in free text.
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]")
      .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[jwt]")
      .replace(/\b(sk|rk|whsec|pk)_(live|test)_[A-Za-z0-9]+/g, "[stripe-key]")
      .slice(0, 2000);
  }
  if (typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) out[k] = "[redacted]";
    else if (PII_KEY.test(k)) out[k] = typeof v === "string" && k.toLowerCase() === "email" ? maskEmail(v) : "[pii]";
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

function minLevel(): Level {
  const l = process.env.LOG_LEVEL as Level | undefined;
  return l && l in ORDER ? l : "info";
}

export type LogSink = (line: string, level: Level) => void;
let sink: LogSink = (line, level) => {
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};
export function setLogSink(s: LogSink): void {
  sink = s;
}

function write(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[minLevel()]) return;
  const ctx = requestContext.getStore();
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    requestId: ctx?.requestId,
    userId: ctx?.userId,
    route: ctx?.route,
    ...(redact(fields) as Record<string, unknown>),
  };
  sink(JSON.stringify(record), level);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};
