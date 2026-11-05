import { route } from "@/server/http/handler";
import { signInSchema } from "@/lib/schemas";
import * as accounts from "@/server/services/accountService";
import { withServiceTx } from "@/server/db/client";

export const POST = route({ auth: "public" }, async (ctx) => {
  const { email, password } = await ctx.body(signInSchema);
  const identity = await accounts.signIn(email, password, ctx.ip);
  const [p] = await withServiceTx((tx) => tx<{ role: string }[]>`select role from public.profiles where id = ${identity.id}`);
  return { body: { role: p?.role ?? "homeowner" } };
});
