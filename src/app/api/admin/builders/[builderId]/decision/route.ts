import { route } from "@/server/http/handler";
import { builderDecisionSchema, uuidSchema } from "@/lib/schemas";
import * as builders from "@/server/services/builderService";

export const POST = route<{ builderId: string }>({ auth: ["admin"], idempotent: true }, async (ctx) => {
  const d = await ctx.body(builderDecisionSchema);
  const row = await builders.adminDecide(ctx.user!, uuidSchema.parse(ctx.params.builderId), d);
  return { body: { status: row?.status, kind: row?.kind } };
});
