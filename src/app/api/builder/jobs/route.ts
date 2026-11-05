import { route } from "@/server/http/handler";
import { paginationSchema } from "@/lib/schemas";
import * as builders from "@/server/services/builderService";

export const GET = route({ auth: ["builder"] }, async (ctx) => {
  const { cursor, limit } = ctx.query(paginationSchema);
  return { body: await builders.listAvailableJobs(ctx.user!, cursor, limit) };
});
