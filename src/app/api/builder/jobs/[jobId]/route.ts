import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as builders from "@/server/services/builderService";
import { AppError } from "@/server/errors";

export const GET = route<{ jobId: string }>({ auth: ["builder"] }, async (ctx) => {
  const id = uuidSchema.safeParse(ctx.params.jobId);
  if (!id.success) throw new AppError("NOT_FOUND");
  return { body: await builders.getBuilderJob(ctx.user!, id.data) };
});
