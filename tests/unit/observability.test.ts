import { describe, expect, it } from "vitest";
import { log, maskEmail, redact, requestContext, setLogSink } from "@/server/observability/logger";
import { AppError, fromDatabase, toAppError } from "@/server/errors";

describe("log redaction", () => {
  it("removes secrets and personal data recursively", () => {
    const out = redact({
      password: "hunter2", token: "abc", headers: { authorization: "Bearer xyz", cookie: "a=b" },
      email: "jane.doe@example.com", phone: "07700900000", address: { line1: "1 High St", postcode: "SE15 4AA" },
      nested: [{ client_secret: "pi_123_secret_456", ok: 1 }],
      note: "key sk_test_abcdef123 and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("xyz");
    expect(s).not.toContain("07700900000");
    expect(s).not.toContain("1 High St");
    expect(s).not.toContain("pi_123_secret_456");
    expect(s).not.toContain("sk_test_abcdef123");
    expect(s).not.toContain("eyJhbGci");
    expect(out.email).toBe("j***@example.com");
    expect(maskEmail("bad")).toBe("[redacted]");
  });
  it("writes structured JSON with the correlation id", () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    requestContext.run({ requestId: "req-123", route: "GET /x" }, () => log.error("test.event", { password: "p", n: 1 }));
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: "error", event: "test.event", requestId: "req-123", route: "GET /x", password: "[redacted]", n: 1 });
  });
});

describe("error mapping", () => {
  it("maps database errors to safe app errors", () => {
    expect(fromDatabase({ code: "23505", constraint_name: "offers_one_live_per_job" })?.code).toBe("JOB_NOT_AVAILABLE");
    expect(fromDatabase({ code: "23505", constraint_name: "media_no_duplicate_uploads" })?.code).toBe("UPLOAD_DUPLICATE");
    expect(fromDatabase({ code: "P0001", message: "INVALID_JOB_TRANSITION draft->completed" })?.code).toBe("INVALID_TRANSITION");
    expect(fromDatabase({ code: "P0001", message: "START_REQUIRES_DEPOSIT" })?.code).toBe("START_CONDITIONS_UNMET");
    expect(fromDatabase({ code: "57014" })?.code).toBe("TIMEOUT");
    expect(fromDatabase({ code: "ECONNREFUSED" })?.code).toBe("SERVICE_UNAVAILABLE");
  });
  it("never exposes internal messages to users", () => {
    const e = toAppError(new Error("relation \"secret_table\" does not exist"));
    expect(e.code).toBe("INTERNAL");
    expect(e.message).not.toContain("secret_table");
    expect(e.status).toBe(500);
    expect(new AppError("RATE_LIMITED").status).toBe(429);
  });
});
