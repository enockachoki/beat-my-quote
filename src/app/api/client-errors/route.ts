import { route } from "@/server/http/handler";
import { clientErrorSchema } from "@/lib/schemas";
import { RULES } from "@/server/services/rateLimit";
import { log } from "@/server/observability/logger";

/** Browser error reports (from error boundaries). Rate limited; content is untrusted and redacted. */
export const POST = route({ auth: "public", rateLimit: RULES.clientError }, async (ctx) => {
  const r = await ctx.body(clientErrorSchema);
  log.warn("client.error", { message: r.message, digest: r.digest, path: r.path, clientRequestId: r.requestId });
  return { status: 202, body: { ok: true } };
});
