import { NextResponse } from "next/server";
import { pingDatabase } from "@/server/db/client";
import { config } from "@/server/config";
import { errorReporterConnected } from "@/server/observability/errorReporter";

export const dynamic = "force-dynamic";

/**
 * Readiness: checks the database and reports which integrations are
 * configured. "configured" means credentials are present, not that the
 * provider has been verified end to end.
 */
export async function GET() {
  const cfg = config();
  const dbStatus = await pingDatabase(2000);
  const body = {
    status: dbStatus.ok ? "ready" : "degraded",
    checks: {
      database: { ok: dbStatus.ok, latencyMs: dbStatus.latencyMs, error: dbStatus.error },
      auth: cfg.AUTH_PROVIDER,
      storage: cfg.STORAGE_PROVIDER,
      payments: cfg.PAYMENT_PROVIDER,
      email: cfg.EMAIL_PROVIDER === "resend" && cfg.RESEND_API_KEY ? "resend" : "console",
      sms: cfg.SMS_PROVIDER === "twilio" && cfg.TWILIO_AUTH_TOKEN ? "twilio" : "console",
      malwareScanner: cfg.MALWARE_SCANNER_URL ? "configured" : "not_configured",
      errorMonitoring: errorReporterConnected() ? "connected" : "logs_only",
    },
  };
  return NextResponse.json(body, { status: dbStatus.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
