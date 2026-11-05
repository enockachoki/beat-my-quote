import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { config } from "../config";
import { AppError, fromZod, toAppError } from "../errors";
import { log, requestContext } from "../observability/logger";
import { reportError } from "../observability/errorReporter";
import { currentUser } from "../auth";
import type { Role, SessionUser } from "../authz/policies";
import { enforceRateLimit, RULES, type RateRule } from "../services/rateLimit";
import { runIdempotent } from "../services/idempotency";
import { idempotencyKeySchema } from "@/lib/schemas";
import type { ApiErrorBody } from "@/lib/errorCodes";

const MAX_JSON_BYTES = 64 * 1024;

export interface HandlerContext<P> {
  req: NextRequest;
  params: P;
  user: SessionUser | null;
  requestId: string;
  ip: string;
  /** Parses and validates the JSON body against a schema (server-side validation). */
  body<S extends z.ZodType>(schema: S): Promise<z.output<S>>;
  query<S extends z.ZodType>(schema: S): z.output<S>;
}

interface RouteOptions {
  /** Roles allowed; "public" means no sign-in needed. */
  auth: Role[] | "any" | "public";
  rateLimit?: RateRule;
  /** Requires an Idempotency-Key header and replays the first response for repeats. */
  idempotent?: boolean;
  /** Skip same-origin check (only for signed provider webhooks / cron with bearer). */
  allowCrossOrigin?: boolean;
}

type Result = Response | { status?: number; body: unknown };

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/**
 * CSRF defence for cookie-authenticated mutations: the browser's Origin (or
 * Sec-Fetch-Site) must show the request came from our own site. Combined with
 * SameSite=Lax cookies and JSON-only bodies.
 */
export function checkSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === config().APP_ORIGIN;
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin";
}

function errorResponse(err: AppError, requestId: string): NextResponse<ApiErrorBody> {
  const res = NextResponse.json<ApiErrorBody>({ error: { code: err.code, message: err.message, fields: err.fields, requestId } }, { status: err.status });
  if (err.retryAfterSeconds) res.headers.set("Retry-After", String(err.retryAfterSeconds));
  return res;
}

export function route<P = Record<string, string>>(opts: RouteOptions, fn: (ctx: HandlerContext<P>) => Promise<Result>) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }): Promise<Response> => {
    const incoming = req.headers.get("x-request-id");
    const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    const started = Date.now();
    const routeName = `${req.method} ${req.nextUrl.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`;
    return requestContext.run({ requestId, route: routeName }, async () => {
      let res: Response;
      try {
        const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
        if (mutating && !opts.allowCrossOrigin && !checkSameOrigin(req)) throw new AppError("CSRF_FAILED");

        let user: SessionUser | null = null;
        if (opts.auth !== "public") {
          const cu = await currentUser();
          if (cu.state === "expired") throw new AppError("SESSION_EXPIRED");
          if (cu.state !== "active") throw new AppError("UNAUTHENTICATED");
          user = cu.user;
          const store = requestContext.getStore();
          if (store) store.userId = user.id;
          if (opts.auth !== "any" && !opts.auth.includes(user.role)) {
            log.warn("authz.denied", { role: user.role, need: opts.auth });
            throw new AppError("FORBIDDEN");
          }
        }
        const ip = clientIp(req);
        if (opts.rateLimit) await enforceRateLimit(opts.rateLimit, user ? `u:${user.id}` : `ip:${ip}`);
        else if (mutating && user) await enforceRateLimit(RULES.mutation, `u:${user.id}`);

        let rawBody: unknown;
        let bodyRead = false;
        const readBody = async () => {
          if (bodyRead) return rawBody;
          bodyRead = true;
          const ct = req.headers.get("content-type") ?? "";
          if (!ct.toLowerCase().startsWith("application/json")) throw new AppError("VALIDATION_FAILED", { fields: { _: "Expected JSON" } });
          const text = await req.text();
          if (text.length > MAX_JSON_BYTES) throw new AppError("VALIDATION_FAILED", { fields: { _: "Request too large" } });
          try {
            rawBody = text ? JSON.parse(text) : {};
          } catch {
            throw new AppError("VALIDATION_FAILED", { fields: { _: "Malformed JSON" } });
          }
          return rawBody;
        };
        const params = await routeCtx.params;
        const ctx: HandlerContext<P> = {
          req, params, user, requestId, ip,
          async body(schema) {
            const parsed = schema.safeParse(await readBody());
            if (!parsed.success) throw fromZod(parsed.error);
            return parsed.data;
          },
          query(schema) {
            const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
            if (!parsed.success) throw fromZod(parsed.error);
            return parsed.data;
          },
        };

        const exec = async () => {
          const out = await fn(ctx);
          if (out instanceof Response) return { status: out.status, body: undefined as unknown, raw: out };
          return { status: out.status ?? 200, body: out.body, raw: null as Response | null };
        };

        if (opts.idempotent && user) {
          const key = idempotencyKeySchema.safeParse(req.headers.get("idempotency-key"));
          if (!key.success) throw new AppError("VALIDATION_FAILED", { fields: { _: "Missing Idempotency-Key header" } });
          const body = req.headers.get("content-type")?.startsWith("application/json") ? await readBody() : null;
          const r = await runIdempotent(user.id, key.data, routeName, body, async () => {
            const o = await exec();
            return { status: o.status, body: o.body };
          });
          res = NextResponse.json(r.body, { status: r.status });
          if (r.replayed) res.headers.set("Idempotent-Replayed", "true");
        } else {
          const o = await exec();
          res = o.raw ?? NextResponse.json(o.body, { status: o.status });
        }
      } catch (err) {
        const appErr = toAppError(err);
        if (appErr.status >= 500) reportError(err, { route: routeName });
        else if (appErr.code === "UNAUTHENTICATED" || appErr.code === "SESSION_EXPIRED" || appErr.code === "FORBIDDEN" || appErr.code === "CSRF_FAILED") log.warn("auth.rejected", { code: appErr.code, internal: appErr.internal });
        res = errorResponse(appErr, requestId);
      }
      res.headers.set("x-request-id", requestId);
      res.headers.set("Cache-Control", "no-store");
      log.info("api.request", { method: req.method, status: res.status, ms: Date.now() - started });
      return res;
    });
  };
}

/** Bearer-token guard for scheduled jobs (Vercel Cron sends CRON_SECRET). */
export function assertCron(req: NextRequest): void {
  const secret = config().CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) throw new AppError("FORBIDDEN", { internal: "cron auth" });
}
