import { z } from "zod";
import { route } from "@/server/http/handler";
import { paginationSchema } from "@/lib/schemas";
import * as builders from "@/server/services/builderService";

export const GET = route({ auth: ["admin"] }, async (ctx) => {
  const q = ctx.query(paginationSchema.extend({ status: z.enum(["pending", "approved", "rejected", "suspended"]).default("pending") }));
  return { body: await builders.adminListBuilders(ctx.user!, q.status, q.cursor, q.limit) };
});
