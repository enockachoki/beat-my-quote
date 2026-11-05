import { route } from "@/server/http/handler";
import { builderApplicationSchema } from "@/lib/schemas";
import * as builders from "@/server/services/builderService";

export const GET = route({ auth: ["builder"] }, async (ctx) => ({ body: await builders.getMyBuilder(ctx.user!) }));

export const POST = route({ auth: ["builder"] }, async (ctx) => {
  const input = await ctx.body(builderApplicationSchema);
  const row = await builders.apply(ctx.user!, input);
  return { status: 201, body: { status: row.status } };
});
