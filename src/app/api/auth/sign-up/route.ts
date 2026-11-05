import { route } from "@/server/http/handler";
import { signUpSchema } from "@/lib/schemas";
import * as accounts from "@/server/services/accountService";

export const POST = route({ auth: "public" }, async (ctx) => {
  const input = await ctx.body(signUpSchema);
  const r = await accounts.signUp(input, ctx.ip);
  return { status: 201, body: { role: r.role } };
});
