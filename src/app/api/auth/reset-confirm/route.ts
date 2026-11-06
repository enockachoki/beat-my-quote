import { route } from "@/server/http/handler";
import { resetConfirmSchema } from "@/lib/schemas";
import * as accounts from "@/server/services/accountService";

export const POST = route({ auth: "public" }, async (ctx) => {
  const { token, password } = await ctx.body(resetConfirmSchema);
  await accounts.confirmPasswordReset(token, password, ctx.ip);
  return { body: { ok: true } };
});
