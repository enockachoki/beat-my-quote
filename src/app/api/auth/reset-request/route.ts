import { route } from "@/server/http/handler";
import { resetRequestSchema } from "@/lib/schemas";
import * as accounts from "@/server/services/accountService";

export const POST = route({ auth: "public" }, async (ctx) => {
  const { email } = await ctx.body(resetRequestSchema);
  await accounts.requestPasswordReset(email, ctx.ip);
  return { status: 202, body: { ok: true } };
});
