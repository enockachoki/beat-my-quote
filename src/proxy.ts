import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before every request:
 * - assigns a correlation id (x-request-id) used in all server logs;
 * - sets a nonce-based Content-Security-Policy;
 * - rejects cross-origin preflights for the API (no CORS is offered);
 * - redirects signed-out users away from protected areas (UX only; the
 *   authoritative checks happen in server layouts and API handlers).
 */
const PROTECTED = ["/homeowner", "/builder", "/admin"];

export function proxy(req: NextRequest) {
  const requestId = crypto.randomUUID();
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV !== "production";
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${supabase}`.trim(),
    `media-src 'self' blob: ${supabase}`.trim(),
    `connect-src 'self' ${supabase} ${supabase.replace("https://", "wss://")}`.trim(),
    "font-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self' https://checkout.stripe.com",
    "base-uri 'self'",
    "object-src 'none'",
    // Only on HTTPS deployments; on plain-HTTP test servers it would break same-site requests.
    ...((process.env.APP_ORIGIN ?? "").startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  if (req.method === "OPTIONS" && req.nextUrl.pathname.startsWith("/api/")) {
    return new NextResponse(null, { status: 405, headers: { "x-request-id": requestId } });
  }

  const path = req.nextUrl.pathname;
  if (PROTECTED.some((p) => path === p || path.startsWith(`${p}/`))) {
    const hasSession = req.cookies.has("bmq_session") || req.cookies.getAll().some((c) => c.name.startsWith("sb-"));
    if (!hasSession) {
      const url = req.nextUrl.clone();
      url.pathname = "/sign-in";
      url.search = `?next=${encodeURIComponent(path)}`;
      return NextResponse.redirect(url);
    }
  }

  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  res.headers.set("x-request-id", requestId);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
